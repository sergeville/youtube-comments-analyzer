#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DATABASE,
  DEFAULT_NEO4J_URL,
  cypher,
  cypherRows,
  ensureSchema,
  loadDotEnv,
  resolveConfig,
} from "./neo4j-lib.mjs";
import {
  buildContextKey,
  deriveCommentContext,
} from "./comment-context.mjs";
import { refreshContextAggregates } from "./neo4j-import-youtube-comments.mjs";

const DEFAULT_LIMIT = 2147483647;
const DEFAULT_BATCH_SIZE = 200;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");

export const BACKFILL_READ_QUERY = `
  MATCH (comment:YouTubeComment)
  OPTIONAL MATCH (video:YouTubeVideo)-[:HAS_COMMENT]->(comment)
  WITH comment, collect(DISTINCT video) AS videos
  WITH comment, videos, CASE WHEN size(videos) = 1 THEN videos[0] ELSE null END AS video
  OPTIONAL MATCH (video)-[:USES_CLASSIFICATION_PROFILE]->(profile:ClassificationProfile)
  WITH comment, videos, video, collect(DISTINCT profile) AS profiles
  OPTIONAL MATCH (comment)-[contextRelation:IN_CONTEXT]->(context:CommentContext)
  WITH comment, videos, video, profiles,
       count(DISTINCT contextRelation) AS contextEdgeCount,
       [entry IN collect({
         key: context.key,
         name: context.name,
         nodeMode: context.mode,
         nodeClassifierVersion: context.classifierVersion,
         nodeCategory: context.category,
         nodeProfile: context.profile,
         relationLabel: contextRelation.label,
         relationMode: contextRelation.mode,
         relationClassifierVersion: contextRelation.classifierVersion,
         categories: [(context)-[:SUBCLASS_OF]->(category:CommentCategory) | category.name],
         profiles: [(context)-[:VALID_FOR]->(validProfile:ClassificationProfile) | validProfile.name]
       }) WHERE entry.key IS NOT NULL OR entry.name IS NOT NULL
            OR entry.relationLabel IS NOT NULL] AS existingContexts
  RETURN {
    id: comment.id,
    videoId: video.id,
    videoCount: size(videos),
    profile: CASE WHEN size(profiles) = 1 THEN profiles[0].name ELSE "unknown" END,
    profileCount: size(profiles),
    text: comment.text,
    category: coalesce(comment.category, "Uncategorized"),
    intent: coalesce(comment.intent, "unknown"),
    sentiment: coalesce(comment.sentiment, "neutral"),
    priority: coalesce(comment.priority, "low"),
    reasons: coalesce(comment.reasons, []),
    parent: coalesce(comment.parent, "root"),
    isCreator: coalesce(comment.isCreator, false),
    contextEdgeCount: contextEdgeCount,
    contexts: existingContexts
  } AS item
  ORDER BY item.id
  LIMIT $limit
`;

export const BACKFILL_WRITE_QUERY = `
  UNWIND $rows AS row
  MATCH (:YouTubeVideo {id: row.videoId})-[:HAS_COMMENT]->(comment:YouTubeComment {id: row.id})
  MERGE (category:CommentCategory {name: row.category})
  MERGE (profile:ClassificationProfile {name: row.profile})
  WITH comment, category, profile, row
  OPTIONAL MATCH (comment)-[oldContext:IN_CONTEXT]->(:CommentContext)
  WITH comment, category, profile, row, collect(oldContext) AS oldContexts
  FOREACH (old IN oldContexts | DELETE old)
  MERGE (context:CommentContext {key: row.contextKey})
  SET context.name = row.contextName,
      context.mode = row.contextMode,
      context.classifierVersion = row.contextClassifierVersion,
      context.category = row.category,
      context.profile = row.profile,
      context.updatedAt = datetime()
  WITH comment, category, profile, context, row
  OPTIONAL MATCH (context)-[oldTaxonomy:SUBCLASS_OF|VALID_FOR]->()
  WITH comment, category, profile, context, row, collect(oldTaxonomy) AS oldTaxonomyRelations
  FOREACH (old IN oldTaxonomyRelations | DELETE old)
  MERGE (comment)-[relation:IN_CONTEXT]->(context)
  SET relation.label = row.contextName,
      relation.mode = row.contextMode,
      relation.classifierVersion = row.contextClassifierVersion,
      relation.updatedAt = datetime()
  MERGE (context)-[:SUBCLASS_OF]->(category)
  MERGE (context)-[:VALID_FOR]->(profile)
`;

function printHelp() {
  console.log(`Usage:
  node scripts/neo4j-context-backfill.mjs [options]

Options:
  --write             Apply context nodes and relationships (default is read-only dry run)
  --limit <count>     Maximum comments to inspect in a read-only preview
  --batch-size <n>    Write batch size (default ${DEFAULT_BATCH_SIZE})
  --url <url>         Neo4j HTTP URL (default ${DEFAULT_NEO4J_URL})
  --database <name>   Neo4j database (default ${DEFAULT_DATABASE})
  -h, --help          Show this help

The default command only reads the graph and reports proposed changes. --write is
required for mutations and always covers the complete graph; --limit cannot be
combined with --write.
`);
}

function requireValue(args, flag) {
  const value = args.shift();
  if (!value) throw new Error(`Missing value for ${flag}.`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

// fallow-ignore-next-line complexity
function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };

  const parsed = {
    write: false,
    limit: DEFAULT_LIMIT,
    limitExplicit: false,
    batchSize: DEFAULT_BATCH_SIZE,
    url: process.env.NEO4J_URL || DEFAULT_NEO4J_URL,
    database: process.env.NEO4J_DATABASE || DEFAULT_DATABASE,
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--write") parsed.write = true;
    else if (arg === "--limit") {
      parsed.limit = positiveInteger(requireValue(args, arg), arg);
      parsed.limitExplicit = true;
    }
    else if (arg === "--batch-size") parsed.batchSize = positiveInteger(requireValue(args, arg), arg);
    else if (arg === "--url") parsed.url = requireValue(args, arg);
    else if (arg === "--database") parsed.database = requireValue(args, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function assertCommentIdentity(item) {
  if (!item || !item.id) throw new Error("comment id is missing");
}

function assertSingleVideo(item) {
  if (item.videoCount !== undefined && item.videoCount !== 1) {
    throw new Error(`comment ${item.id} must be linked to exactly one video`);
  }
  if (!item.videoId) throw new Error(`comment ${item.id} is not linked to a video`);
}

function assertSingleProfile(item) {
  if ((item.profileCount || 0) > 1) {
    throw new Error(`video ${item.videoId} has multiple classification profiles`);
  }
}

function assertBackfillItem(item) {
  assertCommentIdentity(item);
  assertSingleVideo(item);
  assertSingleProfile(item);
}

function normalizedEvaluation(item) {
  const {
    category = "Uncategorized",
    intent = "unknown",
    sentiment = "neutral",
    priority = "low",
    reasons = [],
  } = item;
  return {
    category,
    intent,
    sentiment,
    priority,
    reasons: Array.isArray(reasons) ? reasons : [],
  };
}

function plannedRow(item) {
  assertBackfillItem(item);
  const evaluation = normalizedEvaluation(item);
  const context = deriveCommentContext({ comment: item, evaluation });
  const profile = item.profile || "unknown";
  return {
    id: item.id,
    videoId: item.videoId,
    category: evaluation.category,
    profile,
    contextKey: buildContextKey(profile, evaluation.category, context),
    contextName: context.name,
    contextMode: context.mode,
    contextClassifierVersion: context.classifierVersion,
  };
}

function existingContexts(item) {
  if (!Array.isArray(item.contexts)) return [];
  return item.contexts.filter((context) => context && context.key);
}

const CURRENT_CONTEXT_FIELDS = Object.freeze([
  ["key", "contextKey"],
  ["name", "contextName"],
  ["nodeMode", "contextMode"],
  ["nodeClassifierVersion", "contextClassifierVersion"],
  ["nodeCategory", "category"],
  ["nodeProfile", "profile"],
  ["relationLabel", "contextName"],
  ["relationMode", "contextMode"],
  ["relationClassifierVersion", "contextClassifierVersion"],
]);

function metadataMatches(context, row) {
  return CURRENT_CONTEXT_FIELDS.every(
    ([contextField, rowField]) => context[contextField] === row[rowField],
  );
}

function hasExactTarget(values, expected) {
  return Array.isArray(values) && values.length === 1 && values[0] === expected;
}

function hasSingleContextEdge(item, contexts) {
  const edgeCount = item.contextEdgeCount ?? contexts.length;
  if (edgeCount !== 1) return false;
  return contexts.length === 1;
}

function isCurrent(item, row) {
  const contexts = existingContexts(item);
  if (!hasSingleContextEdge(item, contexts)) return false;
  const [context] = contexts;
  if (!metadataMatches(context, row)) return false;
  if (!hasExactTarget(context.categories, row.category)) return false;
  return hasExactTarget(context.profiles, row.profile);
}

function classifyBackfillItem(item) {
  try {
    const row = plannedRow(item);
    return { status: isCurrent(item, row) ? "skipped" : "proposed", row };
  } catch (error) {
    return { status: "invalid", item, error };
  }
}

function invalidItemId(item) {
  return item?.id || null;
}

export function buildBackfillPlan(items) {
  const rows = [];
  const invalidDetails = [];
  const videoIds = new Set();
  const counts = { processed: 0, skipped: 0 };
  const handlers = {
    proposed(result) {
      counts.processed += 1;
      videoIds.add(result.row.videoId);
      rows.push(result.row);
    },
    skipped(result) {
      counts.processed += 1;
      counts.skipped += 1;
      videoIds.add(result.row.videoId);
    },
    invalid(result) {
      invalidDetails.push({ id: invalidItemId(result.item), error: result.error.message });
    },
  };

  for (const item of items) {
    const result = classifyBackfillItem(item);
    handlers[result.status](result);
  }

  return {
    rows,
    videoIds: [...videoIds],
    summary: {
      inspected: items.length,
      processed: counts.processed,
      proposed: rows.length,
      skipped: counts.skipped,
      invalid: invalidDetails.length,
      invalidDetails: invalidDetails.slice(0, 20),
    },
  };
}

function assertFullGraphWrite(write, limit) {
  if (write && limit !== DEFAULT_LIMIT) {
    throw new Error("--limit is available only for read-only previews; full writes cannot be partial.");
  }
}

function assertWritablePlan(plan) {
  if (plan.summary.invalid > 0) {
    throw new Error(
      `Refusing to write: ${plan.summary.invalid} invalid comment row(s). Run a dry preview for details.`,
    );
  }
}

async function writeBackfillPlan(config, plan, batchSize, opts) {
  await ensureSchema(config, opts);
  for (let index = 0; index < plan.rows.length; index += batchSize) {
    await cypher(config, BACKFILL_WRITE_QUERY, {
      rows: plan.rows.slice(index, index + batchSize),
    }, opts);
  }
  await refreshContextAggregates(config, plan.videoIds, opts);
}

export async function runContextBackfill(config, {
  write = false,
  limit = DEFAULT_LIMIT,
  batchSize = DEFAULT_BATCH_SIZE,
  fetchImpl,
} = {}) {
  assertFullGraphWrite(write, limit);
  const opts = { fetchImpl };
  const rawRows = await cypherRows(config, BACKFILL_READ_QUERY, { limit }, opts);
  const items = rawRows.map((row) => row[0]);
  const plan = buildBackfillPlan(items);

  if (!write) {
    return { dryRun: true, written: 0, ...plan.summary };
  }

  assertWritablePlan(plan);
  await writeBackfillPlan(config, plan, batchSize, opts);

  return { dryRun: false, written: plan.rows.length, ...plan.summary };
}

function requireCredentials() {
  if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    throw new Error("Set NEO4J_USER and NEO4J_PASSWORD to read the local graph.");
  }
}

async function executeCli(args) {
  if (args.help) {
    printHelp();
    return;
  }
  if (args.write && args.limitExplicit) {
    throw new Error("--limit cannot be combined with --write; aggregate relations require a full graph pass.");
  }
  requireCredentials();
  const config = resolveConfig(args);
  const result = await runContextBackfill(config, args);
  console.log(JSON.stringify({
    ok: true,
    neo4jUrl: config.url,
    database: config.database,
    ...result,
  }, null, 2));
}

async function main() {
  try {
    loadDotEnv(PROJECT_DIR);
    const args = parseArgs(process.argv.slice(2));
    await executeCli(args);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

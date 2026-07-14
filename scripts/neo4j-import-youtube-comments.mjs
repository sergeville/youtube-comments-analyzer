#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_NEO4J_URL,
  DEFAULT_DATABASE,
  loadDotEnv,
  resolveConfig,
  cypher,
  cypherRows,
  ensureSchema,
} from "./neo4j-lib.mjs";
import {
  buildContextKey,
  resolveCommentContext,
} from "./comment-context.mjs";

const BATCH_SIZE = 200;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");

export const IMPORT_COMMENTS_QUERY = `
  MATCH (v:YouTubeVideo {id: $videoId})
  MATCH (p:ClassificationProfile {name: $profile})
  UNWIND $rows AS row
  MERGE (a:YouTubeAuthor {id: row.authorKey})
  SET a.handle = row.author,
      a.youtubeAuthorId = row.authorId,
      a.url = row.authorUrl,
      a.updatedAt = datetime()
  MERGE (c:YouTubeComment {id: row.id})
  SET c.text = row.text,
      c.likeCount = row.likeCount,
      c.parent = row.parent,
      c.isPinned = row.isPinned,
      c.isCreator = row.isCreator,
      c.timestamp = row.timestamp,
      c.category = row.category,
      c.subcategory = row.subcategory,
      c.intent = row.intent,
      c.sentiment = row.sentiment,
      c.priority = row.priority,
      c.reasons = row.reasons,
      c.updatedAt = datetime()
  WITH v, p, a, c, row
  OPTIONAL MATCH (c)<-[oldAuthor:WROTE]-(:YouTubeAuthor)
  WITH v, p, a, c, row, collect(oldAuthor) AS oldAuthorRelations
  FOREACH (old IN oldAuthorRelations | DELETE old)
  WITH v, p, a, c, row
  OPTIONAL MATCH (c)-[oldCategory:IN_CATEGORY]->(:CommentCategory)
  WITH v, p, a, c, row, collect(oldCategory) AS oldCategoryRelations
  FOREACH (old IN oldCategoryRelations | DELETE old)
  MERGE (cat:CommentCategory {name: row.category})
  MERGE (a)-[:WROTE]->(c)
  MERGE (v)-[:HAS_COMMENT]->(c)
  MERGE (c)-[:IN_CATEGORY]->(cat)
  WITH p, c, cat, row
  OPTIONAL MATCH (c)-[oldContext:IN_CONTEXT]->(:CommentContext)
  WITH p, c, cat, row, collect(oldContext) AS oldContexts
  FOREACH (old IN oldContexts | DELETE old)
  MERGE (ctx:CommentContext {key: row.contextKey})
  SET ctx.name = row.contextName,
      ctx.mode = row.contextMode,
      ctx.classifierVersion = row.contextClassifierVersion,
      ctx.category = row.category,
      ctx.profile = $profile,
      ctx.updatedAt = datetime()
  WITH p, c, cat, ctx, row
  OPTIONAL MATCH (ctx)-[oldTaxonomy:SUBCLASS_OF|VALID_FOR]->()
  WITH p, c, cat, ctx, row, collect(oldTaxonomy) AS oldTaxonomyRelations
  FOREACH (old IN oldTaxonomyRelations | DELETE old)
  MERGE (c)-[ic:IN_CONTEXT]->(ctx)
  SET ic.label = row.contextName,
      ic.mode = row.contextMode,
      ic.classifierVersion = row.contextClassifierVersion,
      ic.updatedAt = datetime()
  MERGE (ctx)-[:SUBCLASS_OF]->(cat)
  MERGE (ctx)-[:VALID_FOR]->(p)
`;

export const REFRESH_VIDEO_CONTEXT_QUERY = `
  UNWIND $videoIds AS videoId
  MATCH (v:YouTubeVideo {id: videoId})
  OPTIONAL MATCH (v)-[oldCoverage:COVERS]->(:CommentContext)
  WITH v, collect(oldCoverage) AS oldCoverageRelations
  FOREACH (old IN oldCoverageRelations | DELETE old)
  WITH v
  MATCH (v)-[:HAS_COMMENT]->(allComment:YouTubeComment)
  WITH v, count(DISTINCT allComment) AS totalComments
  MATCH (v)-[:HAS_COMMENT]->(comment:YouTubeComment)-[:IN_CONTEXT]->(ctx:CommentContext)
  WITH v, ctx, totalComments, count(DISTINCT comment) AS commentCount
  MERGE (v)-[coverage:COVERS]->(ctx)
  SET coverage.commentCount = commentCount,
      coverage.share = CASE
        WHEN totalComments = 0 THEN 0.0
        ELSE toFloat(commentCount) / toFloat(totalComments)
      END,
      coverage.updatedAt = datetime()
`;

export const REFRESH_AUTHOR_CONTEXT_QUERY = `
  UNWIND $videoIds AS videoId
  MATCH (v:YouTubeVideo {id: videoId})-[:HAS_COMMENT]->(:YouTubeComment)<-[:WROTE]-(author:YouTubeAuthor)
  WITH collect(DISTINCT author) AS affectedAuthors
  UNWIND affectedAuthors AS author
  OPTIONAL MATCH (author)-[oldDiscussion:DISCUSSES]->(:CommentContext)
  WITH author, collect(oldDiscussion) AS oldDiscussionRelations
  FOREACH (old IN oldDiscussionRelations | DELETE old)
  WITH author
  MATCH (author)-[:WROTE]->(comment:YouTubeComment)-[:IN_CONTEXT]->(ctx:CommentContext)
  WITH author, ctx, count(DISTINCT comment) AS commentCount
  MERGE (author)-[discussion:DISCUSSES]->(ctx)
  SET discussion.commentCount = commentCount,
      discussion.updatedAt = datetime()
`;

function printHelp() {
  console.log(`Usage:
  node scripts/neo4j-import-youtube-comments.mjs <comments-json> [options]

Options:
  --url <url>          Neo4j HTTP URL. Defaults to NEO4J_URL or ${DEFAULT_NEO4J_URL}
  --database <name>    Neo4j database. Defaults to NEO4J_DATABASE or ${DEFAULT_DATABASE}
  --dry-run            Validate and summarize without connecting to Neo4j
  --update, --force    If the video already exists, re-import it without asking
  --skip-existing      If the video already exists, skip it without asking
  -h, --help           Show this help

Existing videos:
  By default, if the YouTubeVideo id already exists in Neo4j the importer asks
  whether to update it (interactive), or skips it when stdin is not a TTY.
  Use --update to always re-import, or --skip-existing to always skip.

Environment:
  NEO4J_URL            Example: http://localhost:7474 (non-localhost must be https://)
  NEO4J_DATABASE       Example: neo4j
  NEO4J_USER           Required unless --dry-run
  NEO4J_PASSWORD       Required unless --dry-run
  NEO4J_QUERY_TIMEOUT_MS  Per-request timeout (default 30000)
  NEO4J_MAX_ROWS       Result-size cap (default 100000)

  Graph model:
  (:YouTubeVideo)-[:HAS_COMMENT]->(:YouTubeComment)
  (:YouTubeAuthor)-[:WROTE]->(:YouTubeComment)
  (:YouTubeComment)-[:REPLY_TO]->(:YouTubeComment)
  (:YouTubeComment)-[:IN_CATEGORY]->(:CommentCategory)
  (:YouTubeVideo)-[:USES_CLASSIFICATION_PROFILE]->(:ClassificationProfile)
  (:YouTubeComment)-[:IN_CONTEXT {label}]->(:CommentContext)
  (:CommentContext)-[:SUBCLASS_OF]->(:CommentCategory)
  (:CommentContext)-[:VALID_FOR]->(:ClassificationProfile)
  (:YouTubeVideo)-[:COVERS {commentCount, share}]->(:CommentContext)
  (:YouTubeAuthor)-[:DISCUSSES {commentCount}]->(:CommentContext)
`);
}

// fallow-ignore-next-line complexity
function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  const jsonPath = args.shift();
  let url = process.env.NEO4J_URL || DEFAULT_NEO4J_URL;
  let database = process.env.NEO4J_DATABASE || DEFAULT_DATABASE;
  let dryRun = false;
  let update = false;
  let skipExisting = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--url") {
      url = requireValue(args, arg);
      continue;
    }
    if (arg === "--database") {
      database = requireValue(args, arg);
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--update" || arg === "--force") {
      update = true;
      continue;
    }
    if (arg === "--skip-existing") {
      skipExisting = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (update && skipExisting) {
    throw new Error("Use either --update or --skip-existing, not both.");
  }

  return { jsonPath, url, database, dryRun, update, skipExisting };
}

function requireValue(args, flag) {
  const value = args.shift();
  if (!value) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function loadCommentsJson(jsonPath) {
  if (!jsonPath) {
    throw new Error("Missing comments JSON path.");
  }

  const resolved = path.resolve(jsonPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  validateCommentsData(data, resolved);
  return { data, resolved };
}

// fallow-ignore-next-line complexity
export function validateCommentsData(data, sourcePath) {
  if (!data || typeof data !== "object") {
    throw new Error(`${sourcePath} is not a JSON object.`);
  }
  if (!data.video?.id || !data.video?.title) {
    throw new Error(`${sourcePath} is missing video.id or video.title.`);
  }
  if (!Array.isArray(data.comments)) {
    throw new Error(`${sourcePath} is missing comments array.`);
  }

  const missingId = data.comments.find((comment) => !comment.id);
  if (missingId) {
    throw new Error("Every comment must have an id before Neo4j import.");
  }

  const commentIds = data.comments.map((comment) => comment.id);
  if (new Set(commentIds).size !== commentIds.length) {
    throw new Error("Comment ids must be unique within one import.");
  }

  for (const comment of data.comments) {
    try {
      resolveCommentContext(comment);
    } catch (error) {
      throw new Error(`Comment ${comment.id}: ${error.message}`);
    }
  }
}

export function summarize(data) {
  const rootComments = data.comments.filter((comment) => comment.parent === "root").length;
  const replies = data.comments.length - rootComments;
  const authors = new Set(data.comments.map((comment) => authorKey(comment))).size;
  const categories = new Set(data.comments.map((comment) => comment.evaluation?.category || "Uncategorized")).size;
  const contexts = new Set(data.comments.map((comment) => resolveCommentContext(comment).name)).size;

  return {
    videoId: data.video.id,
    title: data.video.title,
    comments: data.comments.length,
    rootComments,
    replies,
    authors,
    categories,
    contexts,
    classificationProfile: data.classification?.profile || "unknown",
  };
}

function authorKey(comment) {
  return comment.authorId || comment.author || "unknown-author";
}

export function normalizeRows(comments, profile = "unknown") {
  // fallow-ignore-next-line complexity
  return comments.map((comment) => {
    let context;
    try {
      context = resolveCommentContext(comment);
    } catch (error) {
      throw new Error(`Comment ${comment.id || "<missing-id>"}: ${error.message}`);
    }
    const category = comment.evaluation?.category || "Uncategorized";
    return {
      id: comment.id,
      authorKey: authorKey(comment),
      author: comment.author || "Unknown author",
      authorId: comment.authorId || null,
      authorUrl: comment.authorUrl || null,
      text: comment.text || "",
      likeCount: Number(comment.likeCount || 0),
      parent: comment.parent || "root",
      isPinned: Boolean(comment.isPinned),
      isCreator: Boolean(comment.isCreator),
      timestamp: comment.timestamp || null,
      category,
      subcategory: comment.evaluation?.subcategory || null,
      intent: comment.evaluation?.intent || "unknown",
      sentiment: comment.evaluation?.sentiment || "neutral",
      priority: comment.evaluation?.priority || "low",
      reasons: Array.isArray(comment.evaluation?.reasons) ? comment.evaluation.reasons : [],
      contextKey: buildContextKey(profile, category, context),
      contextName: context.name,
      contextMode: context.mode,
      contextClassifierVersion: context.classifierVersion,
    };
  });
}

// Look up an existing YouTubeVideo by id. Returns null when absent.
async function fetchExistingVideo(config, videoId) {
  const rows = await cypherRows(config, `
    MATCH (v:YouTubeVideo {id: $id})
    RETURN v.id, v.title, v.extractedCommentCount, toString(v.updatedAt)
  `, { id: videoId });
  if (!rows.length) {
    return null;
  }
  const [id, title, extractedCommentCount, updatedAt] = rows[0];
  return { id, title, extractedCommentCount, updatedAt };
}

// Ask a yes/no question on the terminal. Prompt text goes to stderr so stdout stays
// pure JSON for piping. Returns false on empty/no.
async function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// Decide what to do when the video already exists: "update" (re-import) or "skip".
// --update / --skip-existing force the outcome; otherwise ask when interactive, and
// default to skip when stdin is not a TTY (so CI/pipes never hang). `ask` is injectable
// so the decision logic can be unit-tested without a real terminal.
// fallow-ignore-next-line complexity
export async function resolveExistingVideoAction(existing, args, ask = askYesNo) {
  if (args.update) {
    return "update";
  }
  if (args.skipExisting) {
    return "skip";
  }
  if (!process.stdin.isTTY) {
    console.error(
      `Video "${existing.title}" (${existing.id}) already exists in Neo4j ` +
      `(${existing.extractedCommentCount} comments, updated ${existing.updatedAt}). Skipping. ` +
      "Pass --update to re-import or --skip-existing to silence this.",
    );
    return "skip";
  }
  const yes = await ask(
    `Video "${existing.title}" (${existing.id}) already exists in Neo4j — ` +
    `${existing.extractedCommentCount} comments, updated ${existing.updatedAt}. Update it? [y/N] `,
  );
  return yes ? "update" : "skip";
}

async function importVideo(config, data) {
  await cypher(config, `
    MERGE (v:YouTubeVideo {id: $video.id})
    SET v.title = $video.title,
        v.url = $video.url,
        v.channel = $video.channel,
        v.channelId = $video.channelId,
        v.handle = $video.handle,
        v.reportedCommentCount = $video.reportedCommentCount,
        v.extractedCommentCount = $video.extractedCommentCount,
        v.updatedAt = datetime()
    WITH v
    OPTIONAL MATCH (v)-[oldProfile:USES_CLASSIFICATION_PROFILE]->(:ClassificationProfile)
    WITH v, collect(oldProfile) AS oldProfileRelations
    FOREACH (old IN oldProfileRelations | DELETE old)
    MERGE (p:ClassificationProfile {name: $profile})
    MERGE (v)-[:USES_CLASSIFICATION_PROFILE]->(p)
    FOREACH (_ IN CASE WHEN $video.channelId IS NULL THEN [] ELSE [1] END |
      MERGE (ch:YouTubeChannel {id: $video.channelId})
      SET ch.name = $video.channel, ch.handle = $video.handle
      MERGE (ch)-[:PUBLISHED]->(v)
    )
  `, {
    video: {
      channel: null, channelId: null, handle: null,
      ...data.video,
    },
    profile: data.classification?.profile || "unknown",
  });
}

async function importComments(config, data) {
  const profile = data.classification?.profile || "unknown";
  const rows = normalizeRows(data.comments, profile);
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    await cypher(config, IMPORT_COMMENTS_QUERY, {
      videoId: data.video.id,
      profile,
      rows: batch,
    });
  }
}

async function importReplyEdges(config, data) {
  const profile = data.classification?.profile || "unknown";
  const rows = normalizeRows(data.comments, profile).filter((comment) => comment.parent !== "root");
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    await cypher(config, `
      UNWIND $rows AS row
      MATCH (child:YouTubeComment {id: row.id})
      MATCH (parent:YouTubeComment {id: row.parent})
      MERGE (child)-[:REPLY_TO]->(parent)
    `, { rows: batch });
  }
}

export async function refreshContextAggregates(config, videoIds, opts = {}) {
  const uniqueVideoIds = [...new Set(videoIds.filter(Boolean))];
  if (!uniqueVideoIds.length) {
    return;
  }
  const parameters = { videoIds: uniqueVideoIds };
  await cypher(config, REFRESH_VIDEO_CONTEXT_QUERY, parameters, opts);
  await cypher(config, REFRESH_AUTHOR_CONTEXT_QUERY, parameters, opts);
}

function requireNeo4jCredentials({ dryRun }) {
  if (dryRun) {
    return;
  }
  if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    throw new Error("Set NEO4J_USER and NEO4J_PASSWORD, or run with --dry-run.");
  }
}

// fallow-ignore-next-line complexity
async function main() {
  try {
    loadDotEnv(PROJECT_DIR);
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }

    requireNeo4jCredentials(args);
    const { data, resolved } = loadCommentsJson(args.jsonPath);
    const summary = summarize(data);

    if (args.dryRun) {
      console.log(JSON.stringify({
        ok: true,
        dryRun: true,
        sourcePath: resolved,
        neo4jUrl: args.url,
        database: args.database,
        summary,
      }, null, 2));
      return;
    }

    // resolveConfig enforces the TLS rule (non-localhost must be https).
    const config = resolveConfig({ url: args.url, database: args.database });

    await ensureSchema(config);

    // Skip or update when the video is already in the graph; import it when it is new.
    const existing = await fetchExistingVideo(config, data.video.id);
    let action = "created";
    if (existing) {
      const decision = await resolveExistingVideoAction(existing, args);
      if (decision === "skip") {
        console.log(JSON.stringify({
          ok: true,
          action: "skipped",
          sourcePath: resolved,
          neo4jUrl: config.url,
          database: config.database,
          existing,
          summary,
        }, null, 2));
        return;
      }
      action = "updated";
    }

    await importVideo(config, data);
    await importComments(config, data);
    await importReplyEdges(config, data);
    await refreshContextAggregates(config, [data.video.id]);

    console.log(JSON.stringify({
      ok: true,
      action,
      sourcePath: resolved,
      neo4jUrl: config.url,
      database: config.database,
      summary,
    }, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

// Only run when invoked directly, so tests can import the pure helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

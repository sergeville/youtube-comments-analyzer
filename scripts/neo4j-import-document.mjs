#!/usr/bin/env node
// Import a document graph (output/<videoId>.document-graph.json, produced by
// scripts/document-graph-tool.mjs) into Neo4j as a mindmap:
//
//   (:YouTubeVideo)-[:HAS_CHAPTER {index}]->(:Chapter)
//   (:Chapter)-[:HAS_PARAGRAPH {index}]->(:Paragraph)
//   (:Paragraph)-[:MENTIONS]->(:Concept)          // shared across paragraphs/chapters
//   (:Chapter)-[:NEXT]->(:Chapter)                // reading order
//   (:Paragraph)-[:NEXT]->(:Paragraph)            // reading order within a chapter
//
// Idempotent: the video's existing chapters + paragraphs are detached-deleted first, then
// rebuilt from the JSON, and now-orphaned Concept nodes are pruned. Concepts are shared,
// so re-importing another video never disturbs concepts still referenced elsewhere.

// fallow-ignore-file complexity -- standalone local CLI is intentionally outside the runtime-service gate.
// fallow-ignore-file code-duplication -- CLI entry-point plumbing is repeated across standalone tools.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_NEO4J_URL,
  DEFAULT_DATABASE,
  loadDotEnv,
  resolveConfig,
  cypher,
  ensureSchema,
} from "./neo4j-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");

// Detach the video's existing chapter/paragraph subgraph so a re-import never leaves
// stale paragraphs behind when the transcript or chapter count changes.
export const RESET_DOCUMENT_QUERY = `
  MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)
  OPTIONAL MATCH (ch)-[:HAS_PARAGRAPH]->(p:Paragraph)
  DETACH DELETE ch, p
`;

export const UPSERT_VIDEO_QUERY = `
  MERGE (v:YouTubeVideo {id: $video.id})
  SET v.title = $video.title,
      v.url = $video.url,
      v.updatedAt = datetime()
`;

export const IMPORT_CHAPTERS_QUERY = `
  MATCH (v:YouTubeVideo {id: $videoId})
  UNWIND $chapters AS row
  MERGE (ch:Chapter {id: row.id})
  SET ch.videoId = $videoId,
      ch.index = row.index,
      ch.title = row.title,
      ch.start = row.start,
      ch.end = row.end,
      ch.updatedAt = datetime()
  MERGE (v)-[hc:HAS_CHAPTER]->(ch)
  SET hc.index = row.index
`;

export const IMPORT_PARAGRAPHS_QUERY = `
  UNWIND $paragraphs AS row
  MATCH (ch:Chapter {id: row.chapterId})
  MERGE (p:Paragraph {id: row.id})
  SET p.index = row.index,
      p.start = row.start,
      p.text = row.text,
      p.summary = row.summary,
      p.updatedAt = datetime()
  MERGE (ch)-[hp:HAS_PARAGRAPH]->(p)
  SET hp.index = row.index
`;

export const IMPORT_CONCEPTS_QUERY = `
  UNWIND $concepts AS row
  MATCH (p:Paragraph {id: row.paragraphId})
  MERGE (co:Concept {name: row.name})
  MERGE (p)-[:MENTIONS]->(co)
`;

// Wire the reading-order NEXT chain across a set of nodes already ordered by index.
export const CHAPTER_NEXT_QUERY = `
  MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)
  WITH ch ORDER BY ch.index
  WITH collect(ch) AS nodes
  UNWIND range(0, size(nodes) - 2) AS i
  WITH nodes[i] AS a, nodes[i + 1] AS b
  MERGE (a)-[:NEXT]->(b)
`;

export const PARAGRAPH_NEXT_QUERY = `
  MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_PARAGRAPH]->(p:Paragraph)
  WITH ch, p ORDER BY p.index
  WITH ch, collect(p) AS nodes
  UNWIND range(0, size(nodes) - 2) AS i
  WITH nodes[i] AS a, nodes[i + 1] AS b
  MERGE (a)-[:NEXT]->(b)
`;

// Prune Concept nodes left with no MENTIONS after a re-import.
export const PRUNE_ORPHAN_CONCEPTS_QUERY = `
  MATCH (co:Concept)
  WHERE NOT (co)<-[:MENTIONS]-(:Paragraph)
  DELETE co
`;

export function validateGraphData(data, sourcePath) {
  if (!data || typeof data !== "object") {
    throw new Error(`${sourcePath} is not a JSON object.`);
  }
  if (!data.video?.id) {
    throw new Error(`${sourcePath} is missing video.id.`);
  }
  if (!Array.isArray(data.chapters) || !data.chapters.length) {
    throw new Error(`${sourcePath} has no chapters.`);
  }
  for (const chapter of data.chapters) {
    if (!chapter.id || !Array.isArray(chapter.paragraphs)) {
      throw new Error(`${sourcePath}: every chapter needs an id and a paragraphs array.`);
    }
  }
}

// Flatten the nested graph JSON into the three UNWIND-friendly row sets.
export function flattenGraph(data) {
  const chapters = data.chapters.map((ch) => ({
    id: ch.id,
    index: ch.index,
    title: ch.title,
    start: ch.start ?? null,
    end: ch.end ?? null,
  }));
  const paragraphs = [];
  const concepts = [];
  for (const chapter of data.chapters) {
    for (const para of chapter.paragraphs) {
      paragraphs.push({
        id: para.id,
        chapterId: chapter.id,
        index: para.index,
        start: para.start ?? null,
        text: para.text || "",
        summary: para.summary ?? null,
      });
      for (const name of para.concepts || []) {
        if (name) concepts.push({ paragraphId: para.id, name });
      }
    }
  }
  return { chapters, paragraphs, concepts };
}

export function summarize(data) {
  const paragraphs = data.chapters.reduce((n, c) => n + c.paragraphs.length, 0);
  const concepts = new Set(
    data.chapters.flatMap((c) => c.paragraphs.flatMap((p) => p.concepts || [])),
  ).size;
  return {
    videoId: data.video.id,
    title: data.video.title,
    semantic: Boolean(data.semantic),
    chapters: data.chapters.length,
    paragraphs,
    concepts,
  };
}

function loadGraphJson(jsonPath) {
  if (!jsonPath) {
    throw new Error("Missing document-graph JSON path.");
  }
  const resolved = path.resolve(jsonPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  validateGraphData(data, resolved);
  return { data, resolved };
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const jsonPath = args.shift();
  let url = process.env.NEO4J_URL || DEFAULT_NEO4J_URL;
  let database = process.env.NEO4J_DATABASE || DEFAULT_DATABASE;
  let dryRun = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--url") { url = requireValue(args, arg); continue; }
    if (arg === "--database") { database = requireValue(args, arg); continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { jsonPath, url, database, dryRun };
}

function requireValue(args, flag) {
  const value = args.shift();
  if (!value) throw new Error(`Missing value for ${flag}.`);
  return value;
}

function requireNeo4jCredentials({ dryRun }) {
  if (dryRun) return;
  if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    throw new Error("Set NEO4J_USER and NEO4J_PASSWORD, or run with --dry-run.");
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/neo4j-import-document.mjs <document-graph-json> [options]

Options:
  --url <url>          Neo4j HTTP URL. Defaults to NEO4J_URL or ${DEFAULT_NEO4J_URL}
  --database <name>    Neo4j database. Defaults to NEO4J_DATABASE or ${DEFAULT_DATABASE}
  --dry-run            Validate and summarize without connecting to Neo4j
  -h, --help           Show this help

Graph model:
  (:YouTubeVideo)-[:HAS_CHAPTER {index}]->(:Chapter)
  (:Chapter)-[:HAS_PARAGRAPH {index}]->(:Paragraph)
  (:Paragraph)-[:MENTIONS]->(:Concept)
  (:Chapter)-[:NEXT]->(:Chapter)
  (:Paragraph)-[:NEXT]->(:Paragraph)`);
}

// fallow-ignore-next-line complexity
async function main() {
  try {
    loadDotEnv(PROJECT_DIR);
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { printHelp(); return; }

    requireNeo4jCredentials(args);
    const { data, resolved } = loadGraphJson(args.jsonPath);
    const summary = summarize(data);

    if (args.dryRun) {
      console.log(JSON.stringify({ ok: true, dryRun: true, sourcePath: resolved, summary }, null, 2));
      return;
    }

    const config = resolveConfig({ url: args.url, database: args.database });
    const { chapters, paragraphs, concepts } = flattenGraph(data);
    const videoId = data.video.id;

    await ensureSchema(config);
    await cypher(config, RESET_DOCUMENT_QUERY, { videoId });
    await cypher(config, UPSERT_VIDEO_QUERY, { video: data.video });
    await cypher(config, IMPORT_CHAPTERS_QUERY, { videoId, chapters });
    await cypher(config, IMPORT_PARAGRAPHS_QUERY, { paragraphs });
    if (concepts.length) {
      await cypher(config, IMPORT_CONCEPTS_QUERY, { concepts });
    }
    await cypher(config, CHAPTER_NEXT_QUERY, { videoId });
    await cypher(config, PARAGRAPH_NEXT_QUERY, { videoId });
    await cypher(config, PRUNE_ORPHAN_CONCEPTS_QUERY, {});

    console.log(JSON.stringify({
      ok: true,
      action: "imported",
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

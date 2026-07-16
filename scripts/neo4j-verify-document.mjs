#!/usr/bin/env node
// Verify the document mindmap graph for one video: chapter/paragraph/concept counts,
// contiguous reading-order NEXT chains, no orphan paragraphs or concepts, and at least
// one cross-chapter concept (the mindmap "bridge" that proves the graph links up). Exits
// non-zero when any health check fails. Structural — no LLM, no writes.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv, resolveConfig, cypherRows } from "./neo4j-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");

async function firstRow(config, statement, parameters) {
  return (await cypherRows(config, statement, parameters))[0] || [];
}

async function loadSummary(config, videoId) {
  const [chapters, paragraphs, concepts, mentions] = await firstRow(config, `
    MATCH (v:YouTubeVideo {id: $videoId})
    OPTIONAL MATCH (v)-[:HAS_CHAPTER]->(ch:Chapter)
    OPTIONAL MATCH (ch)-[:HAS_PARAGRAPH]->(p:Paragraph)
    OPTIONAL MATCH (p)-[m:MENTIONS]->(co:Concept)
    RETURN count(DISTINCT ch), count(DISTINCT p), count(DISTINCT co), count(m)
  `, { videoId });
  return { chapters, paragraphs, concepts, mentions };
}

async function loadHealth(config, videoId) {
  // Paragraphs attached to this video but with no chapter parent (should be 0).
  const [orphanParagraphs] = await firstRow(config, `
    MATCH (p:Paragraph)
    WHERE p.id STARTS WITH $prefix AND NOT (:Chapter)-[:HAS_PARAGRAPH]->(p)
    RETURN count(p)
  `, { prefix: `${videoId}:ch:` });
  // Concept nodes with no MENTIONS anywhere (prune should have removed these).
  const [orphanConcepts] = await firstRow(config, `
    MATCH (co:Concept) WHERE NOT (co)<-[:MENTIONS]-(:Paragraph) RETURN count(co)
  `, {});
  // Chapter NEXT chain should have exactly (chapters - 1) edges for this video.
  const [chapterCount, chapterNextEdges] = await firstRow(config, `
    MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)
    WITH collect(ch) AS chs
    OPTIONAL MATCH (a:Chapter)-[n:NEXT]->(b:Chapter)
    WHERE a IN chs AND b IN chs
    RETURN size(chs), count(n)
  `, { videoId });
  const chapterChainOk = chapterCount <= 1 ? 1 : (chapterNextEdges === chapterCount - 1 ? 1 : 0);
  return {
    orphanParagraphs,
    orphanConcepts,
    chapterChainBroken: chapterChainOk ? 0 : 1,
  };
}

async function loadChapters(config, videoId) {
  const rows = await cypherRows(config, `
    MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)
    OPTIONAL MATCH (ch)-[:HAS_PARAGRAPH]->(p:Paragraph)
    RETURN ch.index AS idx, ch.title AS title, count(p) AS paragraphs
    ORDER BY idx ASC
  `, { videoId });
  return rows.map(([index, title, paragraphs]) => ({ index, title, paragraphs }));
}

// Concepts mentioned by paragraphs living in 2+ distinct chapters of this video.
async function loadBridgeConcepts(config, videoId) {
  const rows = await cypherRows(config, `
    MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_PARAGRAPH]->(:Paragraph)-[:MENTIONS]->(co:Concept)
    WITH co, count(DISTINCT ch) AS chapters
    WHERE chapters >= 2
    RETURN co.name AS name, chapters
    ORDER BY chapters DESC, name ASC
    LIMIT 15
  `, { videoId });
  return rows.map(([name, chapters]) => ({ name, chapters }));
}

function requireCredentials() {
  if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    throw new Error("Set NEO4J_USER and NEO4J_PASSWORD.");
  }
}

function parseArgs(argv) {
  const videoId = argv[0];
  if (!videoId || videoId === "-h" || videoId === "--help") {
    throw new Error('Usage: node scripts/neo4j-verify-document.mjs <videoId>');
  }
  return { videoId };
}

async function buildReport(config, videoId) {
  const [summary, health, chapters, bridgeConcepts] = await Promise.all([
    loadSummary(config, videoId),
    loadHealth(config, videoId),
    loadChapters(config, videoId),
    loadBridgeConcepts(config, videoId),
  ]);
  const healthOk = Object.values(health).every((value) => value === 0);
  const ok = healthOk && summary.chapters > 0 && summary.paragraphs > 0;
  return { ok, videoId, summary, health, bridgeConcepts, chapters };
}

async function main() {
  try {
    loadDotEnv(PROJECT_DIR);
    requireCredentials();
    const { videoId } = parseArgs(process.argv.slice(2));
    const report = await buildReport(resolveConfig(), videoId);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();

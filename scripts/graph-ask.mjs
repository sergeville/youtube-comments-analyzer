#!/usr/bin/env node
// Graph-RAG over the document mindmap (story yca-9): answer a question about a video
// using its Neo4j graph as the retrieval source. Pipeline:
//   1. tokenize the question into search terms
//   2. score every Paragraph by concept-match (via :MENTIONS) + text-match, keep top-K
//   3. optionally pull each hit's NEXT neighbor for a wider context window
//   4. synthesize a cited answer with local Ollama (llama3.2), or --no-llm to just
//      print the retrieved, timestamped passages.
//
// This is the same retrieval the analyzer's other tools imply, wired into one CLI so the
// graph is a reusable context source. No new dependencies: Neo4j over the HTTP endpoint
// (neo4j-lib) and Ollama over its local HTTP API.

// fallow-ignore-file complexity -- standalone local CLI is intentionally outside the runtime-service gate.
// fallow-ignore-file code-duplication -- CLI entry-point plumbing is repeated across standalone tools.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv, resolveConfig, cypherRows } from "./neo4j-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.YCA_OLLAMA_MODEL || "llama3.2:latest";
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Common words that add noise to graph term-matching (kept small and general).
export const STOPWORDS = new Set([
  "the", "and", "for", "with", "how", "what", "why", "does", "did", "you", "your",
  "this", "that", "these", "those", "are", "was", "were", "can", "could", "would",
  "should", "into", "about", "from", "they", "them", "have", "has", "had", "will",
  "when", "where", "which", "who", "whom", "there", "here", "its", "it's", "use",
  "used", "using", "get", "got", "make", "made", "video", "explain", "tell",
]);

// Break a question into distinct, meaningful lowercase terms for graph matching.
export function tokenizeQuestion(question, stopwords = STOPWORDS) {
  const words = String(question || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#. -]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, "").trim())
    .filter((w) => w.length > 2 && !stopwords.has(w));
  return [...new Set(words)];
}

// One scored retrieval pass: concept matches (via :MENTIONS) count double, text matches
// count once. Returns the top-K paragraphs with their chapter + concept context.
export const RETRIEVAL_QUERY = `
  WITH $terms AS terms
  MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_PARAGRAPH]->(p:Paragraph)
  OPTIONAL MATCH (p)-[:MENTIONS]->(co:Concept)
  WITH ch, p, terms, collect(DISTINCT co.name) AS concepts
  WITH ch, p, concepts,
       size([t IN terms WHERE toLower(p.text) CONTAINS t]) AS textScore,
       size([t IN terms WHERE any(c IN concepts WHERE c CONTAINS t)]) AS conceptScore
  WITH ch, p, concepts, textScore, conceptScore, (conceptScore * 2 + textScore) AS score
  WHERE score > 0
  RETURN ch.index AS chapter, ch.title AS chapterTitle, p.id AS paragraphId,
         p.index AS paragraphIndex, p.start AS startSec, p.summary AS summary,
         p.text AS text, [c IN concepts WHERE c IS NOT NULL] AS concepts, score
  ORDER BY score DESC, chapter ASC, paragraphIndex ASC
  LIMIT $topK
`;

// Fetch the paragraph immediately before/after each hit (reading order via :NEXT), so
// the answer sees a little surrounding context, not just the isolated hit.
export const NEIGHBOR_QUERY = `
  UNWIND $paragraphIds AS pid
  MATCH (p:Paragraph {id: pid})
  OPTIONAL MATCH (prev:Paragraph)-[:NEXT]->(p)
  OPTIONAL MATCH (p)-[:NEXT]->(next:Paragraph)
  RETURN pid AS paragraphId, prev.text AS prevText, next.text AS nextText
`;

async function retrieve(config, videoId, terms, topK) {
  const rows = await cypherRows(config, RETRIEVAL_QUERY, { videoId, terms, topK });
  return rows.map(([chapter, chapterTitle, paragraphId, paragraphIndex, startSec, summary, text, concepts, score]) => ({
    chapter, chapterTitle, paragraphId, paragraphIndex, startSec, summary, text, concepts, score,
  }));
}

async function attachNeighbors(config, passages) {
  if (!passages.length) return passages;
  const rows = await cypherRows(config, NEIGHBOR_QUERY, {
    paragraphIds: passages.map((p) => p.paragraphId),
  });
  const byId = new Map(rows.map(([id, prevText, nextText]) => [id, { prevText, nextText }]));
  return passages.map((p) => ({ ...p, ...(byId.get(p.paragraphId) || {}) }));
}

function videoUrl(videoId, startSec) {
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(startSec || 0))}s`;
}

// Assemble the LLM prompt: numbered, timestamped passages + a strict answer contract.
export function buildAnswerPrompt(question, passages, { withNeighbors } = {}) {
  const blocks = passages.map((p, i) => {
    const ctx = withNeighbors
      ? `${p.prevText ? p.prevText + " " : ""}${p.text}${p.nextText ? " " + p.nextText : ""}`
      : p.text;
    return `[${i + 1}] (chapter "${p.chapterTitle}", ${p.startSec}s) ${ctx}`;
  }).join("\n\n");
  return (
    "You answer a question using ONLY the numbered transcript passages below, which were " +
    "retrieved from a knowledge graph of one YouTube video. Cite the passages you use as " +
    "[1], [2], etc. If the passages do not contain the answer, say so plainly — do not " +
    "invent facts.\n\n" +
    `QUESTION: ${question}\n\nPASSAGES:\n${blocks}\n\nANSWER (with [n] citations):`
  );
}

// Free-text answer from Ollama. Returns null on any failure so --no-llm-style fallback
// output can still be shown.
export async function askOllama(prompt, opts = {}) {
  const url = opts.url || OLLAMA_URL;
  const model = opts.model || OLLAMA_MODEL;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.2 } }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return typeof payload.response === "string" ? payload.response.trim() : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const videoId = args.shift();
  const question = args.shift();
  let topK = 6;
  let neighbors = false;
  let noLlm = false;
  let json = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--top") { topK = Number(args.shift() || 6); continue; }
    if (arg === "--neighbors") { neighbors = true; continue; }
    if (arg === "--no-llm") { noLlm = true; continue; }
    if (arg === "--json") { json = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { videoId, question, topK, neighbors, noLlm, json };
}

function printHelp() {
  console.log(`Usage:
  node scripts/graph-ask.mjs <videoId> "<question>" [options]

Options:
  --top <n>       Number of passages to retrieve (default 6)
  --neighbors     Also include each hit's previous/next paragraph (wider context)
  --no-llm        Skip Ollama; just print the retrieved passages (fast, no model needed)
  --json          Emit machine-readable JSON instead of formatted text
  -h, --help      Show this help

Env: NEO4J_URL/USER/PASSWORD (query), OLLAMA_URL + YCA_OLLAMA_MODEL (answer).
Example:
  node scripts/graph-ask.mjs 1mvlBz6pj1I "How does he chunk the data for RAG?"`);
}

function renderText(question, passages, answer) {
  const lines = [];
  if (answer) {
    lines.push("ANSWER:\n" + answer + "\n");
  }
  lines.push(`SOURCES (${passages.length} passages from the graph):`);
  for (let i = 0; i < passages.length; i++) {
    const p = passages[i];
    lines.push(
      `  [${i + 1}] ch${p.chapter} "${p.chapterTitle}" @${p.startSec}s ` +
      `(score ${p.score}${p.concepts.length ? `, concepts: ${p.concepts.slice(0, 4).join(", ")}` : ""})`,
    );
    lines.push(`      ${videoUrl(question.videoId, p.startSec)}`);
  }
  return lines.join("\n");
}

// fallow-ignore-next-line complexity
async function main() {
  try {
    loadDotEnv(PROJECT_DIR);
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { printHelp(); return; }
    if (!args.videoId || !VIDEO_ID_PATTERN.test(args.videoId)) {
      throw new Error("Provide a valid 11-character YouTube video id.");
    }
    if (!args.question) throw new Error("Provide a question in quotes.");
    if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
      throw new Error("Set NEO4J_USER and NEO4J_PASSWORD.");
    }

    const config = resolveConfig();
    const terms = tokenizeQuestion(args.question);
    if (!terms.length) throw new Error("No searchable terms in the question.");

    let passages = await retrieve(config, args.videoId, terms, args.topK);
    if (args.neighbors) passages = await attachNeighbors(config, passages);

    let answer = null;
    if (passages.length && !args.noLlm) {
      const prompt = buildAnswerPrompt(args.question, passages, { withNeighbors: args.neighbors });
      answer = await askOllama(prompt);
    }

    if (args.json) {
      console.log(JSON.stringify({
        ok: true, videoId: args.videoId, question: args.question, terms,
        answer, passages,
      }, null, 2));
      return;
    }

    if (!passages.length) {
      console.log(`No passages in the graph matched: ${terms.join(", ")}`);
      return;
    }
    console.log(renderText({ videoId: args.videoId }, passages, answer));
    if (!answer && !args.noLlm) {
      console.error("\n(note: Ollama returned no answer — showing retrieved passages only.)");
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

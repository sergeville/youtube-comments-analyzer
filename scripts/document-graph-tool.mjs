#!/usr/bin/env node
// Build a mindmap-ready graph model from a video's document: fold the timestamped
// transcript into the video's own chapters, keep every paragraph (with its opening
// timestamp), and — with --semantic — ask a local Ollama model for each paragraph's
// key concepts + a one-line summary (the paragraph's "context"). Emits
// output/<videoId>.document-graph.json for scripts/neo4j-import-document.mjs to load.
// Emits NDJSON progress on stderr when YCA_PROGRESS is set; final JSON goes to stdout.

// fallow-ignore-file complexity -- standalone local CLI is intentionally outside the runtime-service gate.
// fallow-ignore-file code-duplication -- CLI entry-point plumbing is repeated across standalone tools.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findCaptionFile, parseJson3, groupParagraphs } from "./transcript-tool.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT_DIR = path.join(PROJECT_DIR, "output");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.YCA_OLLAMA_MODEL || "llama3.2:latest";
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function progress(stage, message) {
  if (process.env.YCA_PROGRESS) {
    process.stderr.write(JSON.stringify({ progress: stage, message: message || "" }) + "\n");
  }
}

// --- Pure helpers (exported for tests) -------------------------------------

// Normalize a concept string to a stable, shared key: lowercase, trimmed, collapsed
// whitespace, stripped of surrounding punctuation. Empty/degenerate values return "".
export function normalizeConcept(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#. -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Fold the flat, timestamped transcript paragraphs into the video's chapters. Unlike
// document-tool.buildSections (which re-paragraphizes into strings for prose rendering),
// this keeps each paragraph as a { index, start, text } object so the graph can deep-link
// to YouTube at the paragraph's timestamp. Falls back to a single "Full transcript"
// chapter when the video has no chapter markers.
export function foldChapters(paragraphs, chapters, duration) {
  if (!Array.isArray(paragraphs) || !paragraphs.length) return [];
  const withParas = (title, start, end, source) => {
    const paras = source
      .filter((p) => p.start >= start && p.start < end)
      .map((p, index) => ({ index, start: p.start, text: p.text }));
    return { title, start, end, paragraphs: paras };
  };

  if (Array.isArray(chapters) && chapters.length) {
    return chapters
      .map((ch, i) => {
        const start = Math.round(ch.start_time || 0);
        const nextStart = chapters[i + 1] ? chapters[i + 1].start_time : (duration || Infinity);
        const end = Math.round(ch.end_time || nextStart || Infinity);
        return { index: i, ...withParas(ch.title || `Part ${i + 1}`, start, end, paragraphs) };
      })
      .filter((c) => c.paragraphs.length)
      .map((c, i) => ({ ...c, index: i })); // re-index after dropping empty chapters
  }

  const last = paragraphs[paragraphs.length - 1];
  return [{ index: 0, ...withParas("Full transcript", 0, (last.start || 0) + 1, paragraphs) }];
}

export function chapterId(videoId, index) {
  return `${videoId}:ch:${index}`;
}

export function paragraphId(videoId, chapterIndex, paragraphIndex) {
  return `${videoId}:ch:${chapterIndex}:p:${paragraphIndex}`;
}

// Assemble the persisted graph document from folded chapters. Attaches stable ids and,
// when provided, per-paragraph semantic context via `contextFor(text) -> { summary, concepts }`.
// contextFor is injectable so the assembly is testable without Ollama.
export async function buildGraphDocument({ video, folded, semantic, contextFor }) {
  const chapters = [];
  for (const chapter of folded) {
    const paragraphs = [];
    for (const para of chapter.paragraphs) {
      const id = paragraphId(video.id, chapter.index, para.index);
      let summary = null;
      let concepts = [];
      if (semantic && contextFor) {
        const context = await contextFor(para.text);
        summary = context.summary || null;
        concepts = [...new Set((context.concepts || []).map(normalizeConcept).filter(Boolean))];
      }
      paragraphs.push({ id, index: para.index, start: para.start, text: para.text, summary, concepts });
    }
    chapters.push({
      id: chapterId(video.id, chapter.index),
      index: chapter.index,
      title: chapter.title,
      start: chapter.start,
      end: Number.isFinite(chapter.end) ? chapter.end : null,
      paragraphs,
    });
  }
  return { video, semantic: Boolean(semantic), chapters };
}

// --- Ollama context (impure) -----------------------------------------------

// Ask the local model for a paragraph's concepts + one-line summary. Returns a safe
// empty result on any error so one bad paragraph never aborts the whole document.
// fallow-ignore-next-line complexity
export async function ollamaContext(text, opts = {}) {
  const url = opts.url || OLLAMA_URL;
  const model = opts.model || OLLAMA_MODEL;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const prompt =
    "You label a single transcript paragraph from a technical YouTube video. " +
    "Return STRICT JSON only, no prose, shaped exactly as " +
    '{"summary": "<one short sentence>", "concepts": ["<2-5 short topic keywords>"]}. ' +
    "Concepts are the tools, technologies, or ideas the paragraph is about.\n\n" +
    `Paragraph:\n${text}`;
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: "json", options: { temperature: 0.1 } }),
    });
    if (!response.ok) return { summary: null, concepts: [] };
    const payload = await response.json();
    const parsed = JSON.parse(payload.response || "{}");
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : null,
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts.map((c) => String(c)) : [],
    };
  } catch {
    return { summary: null, concepts: [] };
  }
}

// --- I/O + CLI -------------------------------------------------------------

function loadVideo(videoId, outDir) {
  const infoPath = path.join(outDir, `${videoId}.info.json`);
  if (!fs.existsSync(infoPath)) {
    throw new Error(`Info JSON not found: ${infoPath} (run the document/transcript tool first).`);
  }
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  return {
    id: videoId,
    title: info.title || videoId,
    url: info.webpage_url || `https://www.youtube.com/watch?v=${videoId}`,
    duration: Number(info.duration) || null,
    chapters: Array.isArray(info.chapters) ? info.chapters : [],
  };
}

function loadParagraphs(videoId, outDir) {
  const captionFile = findCaptionFile(outDir, videoId);
  if (!captionFile) return [];
  return groupParagraphs(parseJson3(fs.readFileSync(captionFile, "utf8")));
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const videoId = args.shift();
  let outDir = DEFAULT_OUT_DIR;
  let semantic = false;
  let maxParagraphs = Infinity;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--out-dir") { outDir = path.resolve(args.shift() || ""); continue; }
    if (arg === "--semantic") { semantic = true; continue; }
    if (arg === "--max-paragraphs") { maxParagraphs = Number(args.shift() || Infinity); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { videoId, outDir, semantic, maxParagraphs };
}

function printHelp() {
  console.log(`Usage:
  node scripts/document-graph-tool.mjs <videoId> [options]

Options:
  --out-dir <path>        Output directory. Defaults to ${DEFAULT_OUT_DIR}
  --semantic              Add per-paragraph concepts + summary via Ollama (${OLLAMA_MODEL})
  --max-paragraphs <n>    Cap semantic calls (debug/limits); structural output is unbounded
  -h, --help              Show this help

Output:
  output/<videoId>.document-graph.json  — chapters -> paragraphs -> concepts, for
                                          scripts/neo4j-import-document.mjs`);
}

// fallow-ignore-next-line complexity
async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { printHelp(); return; }
    if (!args.videoId || !VIDEO_ID_PATTERN.test(args.videoId)) {
      throw new Error("Provide a valid 11-character YouTube video id.");
    }

    progress("document-graph-load", "Loading info + captions");
    const video = loadVideo(args.videoId, args.outDir);
    const paragraphs = loadParagraphs(args.videoId, args.outDir);
    if (!paragraphs.length) {
      throw new Error(`No captions found for ${args.videoId} — cannot build a document graph.`);
    }
    const folded = foldChapters(paragraphs, video.chapters, video.duration);

    let semanticCalls = 0;
    const contextFor = async (text) => {
      if (semanticCalls >= args.maxParagraphs) return { summary: null, concepts: [] };
      semanticCalls += 1;
      progress("document-graph-context", `Context ${semanticCalls}`);
      return ollamaContext(text);
    };

    progress("document-graph-build", args.semantic ? "Extracting concepts with Ollama" : "Assembling structure");
    const graph = await buildGraphDocument({ video, folded, semantic: args.semantic, contextFor });

    const outPath = path.join(args.outDir, `${args.videoId}.document-graph.json`);
    fs.writeFileSync(outPath, JSON.stringify(graph, null, 2), "utf8");

    const paragraphCount = graph.chapters.reduce((n, c) => n + c.paragraphs.length, 0);
    const conceptCount = new Set(
      graph.chapters.flatMap((c) => c.paragraphs.flatMap((p) => p.concepts)),
    ).size;
    console.log(JSON.stringify({
      ok: true,
      videoId: args.videoId,
      title: video.title,
      semantic: graph.semantic,
      chapters: graph.chapters.length,
      paragraphs: paragraphCount,
      concepts: conceptCount,
      graphJsonPath: outPath,
    }, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

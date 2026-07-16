// Unit tests for the document mindmap pipeline (story yca-9). Server-free and
// Ollama-free: foldChapters + buildGraphDocument are pure, and the semantic path is
// exercised with an injected contextFor. The importer's flatten/validate/summarize are
// tested against a fixture graph.
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeConcept,
  foldChapters,
  chapterId,
  paragraphId,
  buildGraphDocument,
} from "./document-graph-tool.mjs";
import {
  validateGraphData,
  flattenGraph,
  summarize,
} from "./neo4j-import-document.mjs";
import { SCHEMA_VERSION, SCHEMA_STATEMENTS } from "./neo4j-lib.mjs";

const PARAGRAPHS = [
  { start: 0, text: "Intro to the project." },
  { start: 20, text: "We install drizzle." },
  { start: 140, text: "Now we wire up better auth." },
  { start: 300, text: "Deploying the RAG system." },
];
const CHAPTERS = [
  { title: "Introduction", start_time: 0, end_time: 130 },
  { title: "Setup", start_time: 130, end_time: 260 },
  { title: "Deploy", start_time: 260, end_time: 400 },
];

test("normalizeConcept lowercases, trims, and strips punctuation", () => {
  assert.equal(normalizeConcept("  BetterAuth! "), "betterauth");
  assert.equal(normalizeConcept("RAG system."), "rag system.");
  assert.equal(normalizeConcept("C++"), "c++");
  assert.equal(normalizeConcept("***"), "");
});

test("foldChapters folds timestamped paragraphs into chapters and keeps timestamps", () => {
  const folded = foldChapters(PARAGRAPHS, CHAPTERS, 400);
  assert.equal(folded.length, 3);
  assert.deepEqual(folded.map((c) => c.paragraphs.length), [2, 1, 1]);
  // Chapter 0 keeps both intro paragraphs, re-indexed from 0, with their real starts.
  assert.deepEqual(folded[0].paragraphs.map((p) => p.start), [0, 20]);
  assert.deepEqual(folded[0].paragraphs.map((p) => p.index), [0, 1]);
  assert.equal(folded[2].paragraphs[0].text, "Deploying the RAG system.");
});

test("foldChapters drops empty chapters and re-indexes the survivors", () => {
  // Paragraph starts are 0, 20, 140, 300. The middle window [130,135) catches none.
  const chapters = [
    { title: "First", start_time: 0, end_time: 130 }, // catches 0, 20
    { title: "Empty", start_time: 130, end_time: 135 }, // catches nothing
    { title: "Last", start_time: 135, end_time: 400 }, // catches 140, 300
  ];
  const folded = foldChapters(PARAGRAPHS, chapters, 400);
  assert.equal(folded.length, 2);
  assert.deepEqual(folded.map((c) => c.title), ["First", "Last"]);
  assert.deepEqual(folded.map((c) => c.index), [0, 1]); // re-indexed after the drop
});

test("foldChapters falls back to a single chapter with no markers", () => {
  const folded = foldChapters(PARAGRAPHS, [], 400);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].title, "Full transcript");
  assert.equal(folded[0].paragraphs.length, 4);
});

test("id helpers are stable and unique per position", () => {
  assert.equal(chapterId("abc", 2), "abc:ch:2");
  assert.equal(paragraphId("abc", 2, 3), "abc:ch:2:p:3");
});

test("buildGraphDocument (structural) attaches ids and no concepts", async () => {
  const folded = foldChapters(PARAGRAPHS, CHAPTERS, 400);
  const graph = await buildGraphDocument({
    video: { id: "abc", title: "T", url: "u" },
    folded,
    semantic: false,
  });
  assert.equal(graph.semantic, false);
  assert.equal(graph.chapters[0].id, "abc:ch:0");
  assert.equal(graph.chapters[0].paragraphs[0].id, "abc:ch:0:p:0");
  assert.deepEqual(graph.chapters[0].paragraphs[0].concepts, []);
  assert.equal(graph.chapters[0].paragraphs[0].summary, null);
});

test("buildGraphDocument (semantic) normalizes + dedupes concepts from contextFor", async () => {
  const folded = foldChapters(PARAGRAPHS, CHAPTERS, 400);
  const contextFor = async (text) => ({
    summary: `about: ${text.slice(0, 5)}`,
    concepts: ["Drizzle", "drizzle!", "  RAG  "], // dupes + noise on purpose
  });
  const graph = await buildGraphDocument({
    video: { id: "abc", title: "T", url: "u" },
    folded,
    semantic: true,
    contextFor,
  });
  const p = graph.chapters[0].paragraphs[0];
  assert.equal(graph.semantic, true);
  assert.deepEqual(p.concepts, ["drizzle", "rag"]); // deduped + normalized
  assert.ok(p.summary.startsWith("about:"));
});

// ---- importer pure helpers ----

const FIXTURE = {
  video: { id: "abc", title: "Test", url: "u" },
  semantic: true,
  chapters: [
    {
      id: "abc:ch:0",
      index: 0,
      title: "Intro",
      start: 0,
      end: 130,
      paragraphs: [
        { id: "abc:ch:0:p:0", index: 0, start: 0, text: "a", summary: "s", concepts: ["rag"] },
        { id: "abc:ch:0:p:1", index: 1, start: 20, text: "b", summary: null, concepts: ["drizzle"] },
      ],
    },
    {
      id: "abc:ch:1",
      index: 1,
      title: "Deploy",
      start: 130,
      end: 400,
      paragraphs: [
        { id: "abc:ch:1:p:0", index: 0, start: 300, text: "c", summary: null, concepts: ["rag"] },
      ],
    },
  ],
};

test("validateGraphData accepts a well-formed graph and rejects bad ones", () => {
  assert.doesNotThrow(() => validateGraphData(FIXTURE, "fixture"));
  assert.throws(() => validateGraphData({ chapters: [] }, "x"), /missing video\.id/);
  assert.throws(() => validateGraphData({ video: { id: "a" }, chapters: [] }, "x"), /no chapters/);
});

test("flattenGraph produces UNWIND-ready chapter/paragraph/concept rows", () => {
  const { chapters, paragraphs, concepts } = flattenGraph(FIXTURE);
  assert.equal(chapters.length, 2);
  assert.equal(paragraphs.length, 3);
  assert.deepEqual(concepts, [
    { paragraphId: "abc:ch:0:p:0", name: "rag" },
    { paragraphId: "abc:ch:0:p:1", name: "drizzle" },
    { paragraphId: "abc:ch:1:p:0", name: "rag" },
  ]);
  assert.equal(paragraphs[0].chapterId, "abc:ch:0");
});

test("summarize counts chapters, paragraphs, and distinct concepts", () => {
  const s = summarize(FIXTURE);
  assert.equal(s.chapters, 2);
  assert.equal(s.paragraphs, 3);
  assert.equal(s.concepts, 2); // rag + drizzle (distinct)
  assert.equal(s.semantic, true);
});

test("schema bump adds Chapter/Paragraph/Concept constraints at version 4", () => {
  assert.equal(SCHEMA_VERSION, 4);
  const joined = SCHEMA_STATEMENTS.join("\n");
  assert.match(joined, /FOR \(ch:Chapter\) REQUIRE ch\.id IS UNIQUE/);
  assert.match(joined, /FOR \(p:Paragraph\) REQUIRE p\.id IS UNIQUE/);
  assert.match(joined, /FOR \(co:Concept\) REQUIRE co\.name IS UNIQUE/);
});

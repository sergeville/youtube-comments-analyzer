// Unit tests for the graph-RAG CLI (story yca-9). Pure helpers only — no Neo4j, no
// Ollama: tokenization, prompt assembly, and the answer call with an injected fetch.
import test from "node:test";
import assert from "node:assert/strict";

import {
  tokenizeQuestion,
  buildAnswerPrompt,
  askOllama,
  RETRIEVAL_QUERY,
  STOPWORDS,
} from "./graph-ask.mjs";

test("tokenizeQuestion drops stopwords/short words, dedupes, lowercases", () => {
  const terms = tokenizeQuestion("How does he handle the CHUNKING and chunking of data?");
  assert.ok(terms.includes("chunking"));
  assert.ok(terms.includes("handle"));
  assert.ok(terms.includes("data"));
  assert.ok(!terms.includes("the")); // stopword
  assert.ok(!terms.includes("how")); // stopword
  assert.equal(terms.filter((t) => t === "chunking").length, 1); // deduped
});

test("tokenizeQuestion keeps tech tokens with + # . and trims edge punctuation", () => {
  const terms = tokenizeQuestion("Compare C++, Node.js and the .env file.");
  assert.ok(terms.includes("c++"));
  assert.ok(terms.includes("node.js"));
  assert.ok(terms.includes("env")); // ".env" -> "env" after edge-trim
  assert.ok(!terms.includes("")); // no empty tokens
});

test("STOPWORDS is a non-empty Set used by the tokenizer", () => {
  assert.ok(STOPWORDS instanceof Set);
  assert.ok(STOPWORDS.has("the"));
});

test("buildAnswerPrompt numbers passages, includes timestamps + the citation contract", () => {
  const passages = [
    { chapterTitle: "Intro", startSec: 10, text: "first passage" },
    { chapterTitle: "Setup", startSec: 200, text: "second passage" },
  ];
  const prompt = buildAnswerPrompt("What is covered?", passages);
  assert.match(prompt, /\[1\] \(chapter "Intro", 10s\) first passage/);
  assert.match(prompt, /\[2\] \(chapter "Setup", 200s\) second passage/);
  assert.match(prompt, /ONLY the numbered transcript passages/);
  assert.match(prompt, /QUESTION: What is covered\?/);
});

test("buildAnswerPrompt stitches neighbors when withNeighbors is set", () => {
  const passages = [{ chapterTitle: "Intro", startSec: 10, text: "hit", prevText: "before", nextText: "after" }];
  const prompt = buildAnswerPrompt("q", passages, { withNeighbors: true });
  assert.match(prompt, /before hit after/);
});

test("askOllama returns trimmed response text on success", async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ response: "  the answer  " }) });
  const answer = await askOllama("prompt", { fetchImpl: fakeFetch });
  assert.equal(answer, "the answer");
});

test("askOllama returns null on non-ok response or network error", async () => {
  assert.equal(await askOllama("p", { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await askOllama("p", { fetchImpl: async () => { throw new Error("down"); } }), null);
});

test("RETRIEVAL_QUERY scores concepts double and filters zero-score paragraphs", () => {
  assert.match(RETRIEVAL_QUERY, /conceptScore \* 2 \+ textScore/);
  assert.match(RETRIEVAL_QUERY, /WHERE score > 0/);
  assert.match(RETRIEVAL_QUERY, /:MENTIONS\]->\(co:Concept\)/);
});

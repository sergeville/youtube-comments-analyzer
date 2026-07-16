// Unit tests for the /graph/3d normalization helpers (Phase A). Pure — no Neo4j.
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeGraph, nodeStyle, NODE_STYLES } from "./graph-view.mjs";

test("nodeStyle maps known labels and falls back for unknown", () => {
  assert.equal(nodeStyle("YouTubeVideo").group, "video");
  assert.equal(nodeStyle("Concept").group, "concept");
  assert.deepEqual(nodeStyle("Nonsense"), { group: "other", size: 6 });
});

test("normalizeGraph dedupes nodes by id and assigns group/size/name", () => {
  const g = normalizeGraph(
    [
      { id: "v1", primaryLabel: "YouTubeVideo", name: "My Video" },
      { id: "v1", primaryLabel: "YouTubeVideo", name: "dupe" }, // duplicate id — dropped
      { id: "c1", primaryLabel: "Chapter", name: "" },          // empty name -> falls back to id
    ],
    [],
  );
  assert.equal(g.nodes.length, 2);
  const v = g.nodes.find((n) => n.id === "v1");
  assert.equal(v.group, "video");
  assert.equal(v.size, NODE_STYLES.YouTubeVideo.size);
  assert.equal(v.name, "My Video");
  assert.equal(g.nodes.find((n) => n.id === "c1").name, "c1"); // fallback
});

test("normalizeGraph drops links whose endpoints are missing, and dedupes links", () => {
  const g = normalizeGraph(
    [
      { id: "a", primaryLabel: "Chapter", name: "A" },
      { id: "b", primaryLabel: "Concept", name: "B" },
    ],
    [
      { source: "a", target: "b", type: "MENTIONS" },
      { source: "a", target: "b", type: "MENTIONS" },   // duplicate — collapsed
      { source: "a", target: "ghost", type: "MENTIONS" }, // dangling — dropped
    ],
  );
  assert.equal(g.links.length, 1);
  assert.deepEqual(g.links[0], { source: "a", target: "b", type: "MENTIONS" });
  assert.equal(g.metadata.relationshipCount, 1);
});

test("normalizeGraph enforces the node cap and flags truncation + drops now-dangling links", () => {
  const raw = [];
  for (let i = 0; i < 10; i++) raw.push({ id: "n" + i, primaryLabel: "Paragraph", name: "n" + i });
  const links = [{ source: "n0", target: "n9", type: "NEXT" }]; // n9 will be cut by the cap
  const g = normalizeGraph(raw, links, { limit: 5 });
  assert.equal(g.nodes.length, 5);
  assert.equal(g.metadata.truncated, true);
  assert.equal(g.links.length, 0); // n9 dropped -> dangling link removed
});

test("normalizeGraph reports accurate metadata counts when untruncated", () => {
  const g = normalizeGraph(
    [{ id: "a", primaryLabel: "Chapter", name: "A" }, { id: "b", primaryLabel: "Chapter", name: "B" }],
    [{ source: "a", target: "b", type: "NEXT" }],
  );
  assert.deepEqual(g.metadata, { nodeCount: 2, relationshipCount: 1, truncated: false });
});

// Pure helpers for the /graph/3d view (Phase A of docs/neo4j-3d-view-yca-fit.md).
// Server-side only: turn collected Neo4j rows into a normalized, deduped {nodes, links,
// metadata} contract the browser's 3d-force-graph can consume directly. No I/O here so it
// is unit-testable without Neo4j.

// Visual registry keyed by YCA's real node labels. Color is applied client-side from
// `group`; size/shape give redundant, non-color-only meaning (fit-doc §3).
export const NODE_STYLES = {
  YouTubeChannel:  { group: "channel",   size: 16 },
  YouTubeVideo:    { group: "video",     size: 13 },
  Chapter:         { group: "chapter",   size: 10 },
  Concept:         { group: "concept",   size: 7 },
  Paragraph:       { group: "paragraph", size: 6 },
  YouTubeAuthor:   { group: "author",    size: 6 },
  YouTubeComment:  { group: "comment",   size: 5 },
  CommentCategory: { group: "category",  size: 9 },
  CommentContext:  { group: "context",   size: 8 },
};

export function nodeStyle(label) {
  return NODE_STYLES[label] || { group: "other", size: 6 };
}

// Normalize raw {id, primaryLabel, name, properties} nodes + {source, type, target} links
// into a deduped graph. Enforces an overall node cap and drops links whose endpoints were
// not kept, so the browser never receives a dangling edge. Returns the plan's contract.
export function normalizeGraph(rawNodes, rawLinks, opts = {}) {
  const limit = opts.limit ?? Infinity;
  const byId = new Map();
  for (const n of rawNodes) {
    if (!n || n.id == null || byId.has(n.id)) continue;
    const style = nodeStyle(n.primaryLabel);
    byId.set(n.id, {
      id: n.id,
      primaryLabel: n.primaryLabel || "other",
      labels: n.labels && n.labels.length ? n.labels : [n.primaryLabel || "other"],
      name: n.name != null && n.name !== "" ? String(n.name) : String(n.id),
      group: style.group,
      size: style.size,
      properties: n.properties || {},
    });
  }

  let nodes = [...byId.values()];
  const truncated = nodes.length > limit;
  if (truncated) nodes = nodes.slice(0, limit);
  const kept = new Set(nodes.map((n) => n.id));

  const seen = new Set();
  const links = [];
  for (const l of rawLinks) {
    if (!l || !kept.has(l.source) || !kept.has(l.target)) continue;
    const key = `${l.source}|${l.type}|${l.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: l.source, target: l.target, type: l.type });
  }

  return {
    nodes,
    links,
    metadata: { nodeCount: nodes.length, relationshipCount: links.length, truncated },
  };
}

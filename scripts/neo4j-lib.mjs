// Shared Neo4j helpers for the import + verify scripts (story yca-1).
// Uses the Neo4j legacy HTTP transactional endpoint (POST /db/{db}/tx/commit) with
// parameterized Cypher. Pure functions are exported so they can be unit-tested without
// a live database; `cypher()` accepts an injectable `fetchImpl` for the same reason.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_NEO4J_URL = "http://localhost:7474";
export const DEFAULT_DATABASE = "neo4j";
export const DEFAULT_TIMEOUT_MS = Number(process.env.NEO4J_QUERY_TIMEOUT_MS || 30000);
export const DEFAULT_MAX_ROWS = Number(process.env.NEO4J_MAX_ROWS || 100000);

// Load KEY=VALUE pairs from a .env file without overwriting anything already set in the
// environment. No-op if the file is absent.
// fallow-ignore-next-line complexity
export function loadDotEnv(projectDir) {
  const envPath = path.join(projectDir, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Loopback hosts may use plain http; every other host must use https so credentials are
// never sent in cleartext. Throws on a non-localhost non-https URL.
// fallow-ignore-next-line complexity
export function assertTlsForRemote(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid NEO4J_URL: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!isLocal && parsed.protocol !== "https:") {
    throw new Error(
      `Refusing to connect: NEO4J_URL host "${parsed.hostname}" is not localhost and is not https. ` +
      "Use an https:// URL for any remote/Aura Neo4j.",
    );
  }
  return parsed;
}

// Count rows across a tx/commit payload (used for the result-size cap).
export function countRows(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.reduce((total, result) => total + (result?.data?.length || 0), 0);
}

// Execute one parameterized Cypher statement over the tx/commit endpoint.
// opts: { timeoutMs, maxRows, fetchImpl } — fetchImpl defaults to global fetch.
// fallow-ignore-next-line complexity
export async function cypher(config, statement, parameters = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const { url, database, user, password } = config;
  const endpoint = `${url.replace(/\/$/, "")}/db/${encodeURIComponent(database)}/tx/commit`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "authorization": `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({ statements: [{ statement, parameters }] }),
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Neo4j query timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Neo4j authentication failed (check NEO4J_USER / NEO4J_PASSWORD).");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`Neo4j query failed: ${message}`);
  }

  const rows = countRows(payload);
  if (rows > maxRows) {
    throw new Error(
      `Neo4j result too large: ${rows} rows exceeds the ${maxRows}-row cap ` +
      "(raise NEO4J_MAX_ROWS or narrow the query).",
    );
  }
  return payload;
}

// Convenience for read queries that return simple rows.
export async function cypherRows(config, statement, parameters = {}, opts = {}) {
  const payload = await cypher(config, statement, parameters, opts);
  return payload.results?.[0]?.data?.map((row) => row.row) || [];
}

// Idempotent schema: uniqueness constraints, range indexes, and a version marker.
// Kept in sync with scripts/neo4j-schema.cypher (that file is the human-readable copy).
export const SCHEMA_VERSION = 4;
export const SCHEMA_STATEMENTS = [
  "CREATE CONSTRAINT youtube_channel_id IF NOT EXISTS FOR (ch:YouTubeChannel) REQUIRE ch.id IS UNIQUE",
  "CREATE CONSTRAINT youtube_video_id IF NOT EXISTS FOR (v:YouTubeVideo) REQUIRE v.id IS UNIQUE",
  "CREATE CONSTRAINT youtube_comment_id IF NOT EXISTS FOR (c:YouTubeComment) REQUIRE c.id IS UNIQUE",
  "CREATE CONSTRAINT youtube_author_id IF NOT EXISTS FOR (a:YouTubeAuthor) REQUIRE a.id IS UNIQUE",
  "CREATE CONSTRAINT comment_category_name IF NOT EXISTS FOR (cat:CommentCategory) REQUIRE cat.name IS UNIQUE",
  "CREATE CONSTRAINT classification_profile_name IF NOT EXISTS FOR (p:ClassificationProfile) REQUIRE p.name IS UNIQUE",
  "CREATE CONSTRAINT comment_context_key IF NOT EXISTS FOR (ctx:CommentContext) REQUIRE ctx.key IS UNIQUE",
  // Document mindmap model (story yca-9): chapters, paragraphs, and shared concepts.
  "CREATE CONSTRAINT document_chapter_id IF NOT EXISTS FOR (ch:Chapter) REQUIRE ch.id IS UNIQUE",
  "CREATE CONSTRAINT document_paragraph_id IF NOT EXISTS FOR (p:Paragraph) REQUIRE p.id IS UNIQUE",
  "CREATE CONSTRAINT document_concept_name IF NOT EXISTS FOR (co:Concept) REQUIRE co.name IS UNIQUE",
  "CREATE INDEX youtube_comment_category IF NOT EXISTS FOR (c:YouTubeComment) ON (c.category)",
  "CREATE INDEX youtube_comment_parent IF NOT EXISTS FOR (c:YouTubeComment) ON (c.parent)",
  "CREATE INDEX document_chapter_video IF NOT EXISTS FOR (ch:Chapter) ON (ch.videoId)",
];

export async function ensureSchema(config, opts = {}) {
  for (const statement of SCHEMA_STATEMENTS) {
    await cypher(config, statement, {}, opts);
  }
  await cypher(
    config,
    "MERGE (s:SchemaVersion {name: $name}) SET s.version = $version, s.appliedAt = datetime()",
    { name: "youtube-comments", version: SCHEMA_VERSION },
    opts,
  );
}

// Resolve connection config from args + environment, enforcing the TLS rule.
// fallow-ignore-next-line complexity
export function resolveConfig({ url, database } = {}) {
  const resolvedUrl = url || process.env.NEO4J_URL || DEFAULT_NEO4J_URL;
  assertTlsForRemote(resolvedUrl);
  return {
    url: resolvedUrl,
    database: database || process.env.NEO4J_DATABASE || DEFAULT_DATABASE,
    user: process.env.NEO4J_USER,
    password: process.env.NEO4J_PASSWORD,
  };
}

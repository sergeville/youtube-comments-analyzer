#!/usr/bin/env node
// Import a channel manifest (output/channels/<id>.channel.json) into Neo4j: a YouTubeChannel
// node plus every video it published as (:YouTubeChannel)-[:PUBLISHED]->(:YouTubeVideo).
// Unprocessed videos become lightweight stubs; videos already imported with comments keep
// their richer properties (title is only filled when missing). Emits NDJSON progress on
// stderr when YCA_PROGRESS is set; the final JSON result goes to stdout.

// fallow-ignore-file complexity -- standalone local importer has no coverage-backed CI baseline yet.
// fallow-ignore-file code-duplication -- importer entry-point plumbing matches the existing local importer.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_NEO4J_URL, DEFAULT_DATABASE,
  loadDotEnv, resolveConfig, cypher, ensureSchema,
} from "./neo4j-lib.mjs";

const BATCH_SIZE = 500;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const CHANNELS_DIR = path.join(PROJECT_DIR, "output", "channels");

function progress(stage, message) {
  if (process.env.YCA_PROGRESS) {
    process.stderr.write(JSON.stringify({ progress: stage, message: message || "" }) + "\n");
  }
}

export function validateChannelData(data, source) {
  if (!data || typeof data !== "object") throw new Error(`${source} is not a JSON object.`);
  if (!data.channelId) throw new Error(`${source} is missing channelId.`);
  if (!Array.isArray(data.videos)) throw new Error(`${source} is missing videos array.`);
}

export function buildVideoRows(channel) {
  return (channel.videos || [])
    .filter((v) => v && v.id)
    .map((v) => ({ id: v.id, title: v.title || v.id, duration: v.duration ?? null }));
}

function loadChannelJson(arg) {
  // Accept a path, or a bare channelId resolved under output/channels/.
  let resolved = path.resolve(arg);
  if (!fs.existsSync(resolved)) {
    const byId = path.join(CHANNELS_DIR, `${arg}.channel.json`);
    if (fs.existsSync(byId)) resolved = byId;
    else throw new Error(`Channel manifest not found: ${arg}`);
  }
  const data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  validateChannelData(data, resolved);
  return { data, resolved };
}

async function importChannelNode(config, channel) {
  await cypher(config, `
    MERGE (ch:YouTubeChannel {id: $id})
    SET ch.name = $name,
        ch.handle = $handle,
        ch.url = $url,
        ch.subscribers = $subscribers,
        ch.totalViews = $totalViews,
        ch.avatar = $avatar,
        ch.videoCount = $videoCount,
        ch.updatedAt = datetime()
  `, {
    id: channel.channelId,
    name: channel.name || channel.channelId,
    handle: channel.handle || null,
    url: channel.url || null,
    subscribers: channel.subscribers ?? null,
    totalViews: channel.totalViews ?? null,
    avatar: channel.avatar ?? null,
    videoCount: (channel.videos || []).length,
  });
}

async function importChannelVideos(config, channel) {
  const rows = buildVideoRows(channel);
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await cypher(config, `
      MATCH (ch:YouTubeChannel {id: $channelId})
      UNWIND $rows AS row
      MERGE (v:YouTubeVideo {id: row.id})
      SET v.title = coalesce(v.title, row.title),
          v.duration = row.duration,
          v.channelId = $channelId
      MERGE (ch)-[:PUBLISHED]->(v)
    `, { channelId: channel.channelId, rows: batch });
  }
  return rows.length;
}

export function summarize(channel) {
  return {
    channelId: channel.channelId,
    name: channel.name,
    handle: channel.handle,
    videos: (channel.videos || []).length,
  };
}

async function main() {
  try {
    loadDotEnv(PROJECT_DIR);
    const arg = process.argv[2];
    const dryRun = process.argv.includes("--dry-run");
    if (!arg || arg === "-h" || arg === "--help") {
      console.log(`Usage:
  node scripts/neo4j-import-channel.mjs <channel-json | channelId> [--dry-run]

Graph model:
  (:YouTubeChannel)-[:PUBLISHED]->(:YouTubeVideo)
Environment: NEO4J_URL (default ${DEFAULT_NEO4J_URL}), NEO4J_DATABASE (default ${DEFAULT_DATABASE}), NEO4J_USER, NEO4J_PASSWORD`);
      return;
    }

    const { data, resolved } = loadChannelJson(arg);
    const summary = summarize(data);

    if (dryRun) {
      console.log(JSON.stringify({ ok: true, dryRun: true, sourcePath: resolved, summary }, null, 2));
      return;
    }
    if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
      throw new Error("Set NEO4J_USER and NEO4J_PASSWORD, or run with --dry-run.");
    }

    const config = resolveConfig({});
    progress("channel-graph-schema", "Ensuring schema");
    await ensureSchema(config);
    progress("channel-graph-node", "Writing channel node");
    await importChannelNode(config, data);
    progress("channel-graph-videos", "Linking videos");
    const linked = await importChannelVideos(config, data);

    console.log(JSON.stringify({
      ok: true,
      sourcePath: resolved,
      neo4jUrl: config.url,
      database: config.database,
      summary: { ...summary, linkedVideos: linked },
    }, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

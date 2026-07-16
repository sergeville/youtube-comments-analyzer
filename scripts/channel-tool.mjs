#!/usr/bin/env node
// List every video on a YouTube channel with yt-dlp (flat, no per-video network) and save
// a channel manifest to output/channels/<channelId>.channel.json. Emits NDJSON progress on
// stderr when YCA_PROGRESS is set; the final JSON result goes to stdout.

// fallow-ignore-file complexity -- standalone local CLI is intentionally outside the runtime-service gate.
// fallow-ignore-file code-duplication -- CLI entry-point plumbing is repeated across standalone tools.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ytdlpAuthArgs } from "./ytdlp-auth.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT_DIR = path.join(PROJECT_DIR, "output");
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
export const CHANNEL_ID = /^[A-Za-z0-9_.-]{1,80}$/;

function progress(stage, message) {
  if (process.env.YCA_PROGRESS) {
    process.stderr.write(JSON.stringify({ progress: stage, message: message || "" }) + "\n");
  }
}

// Accept a channel URL (@handle, /channel/UC…, /c/…, /user/…) and normalize to its videos tab.
export function normalizeChannelUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new Error("Invalid URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http/https URLs are supported.");
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) throw new Error(`Not a YouTube channel URL: ${url.hostname}.`);
  const p = url.pathname.replace(/\/+$/, "");
  if (!/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(p)) {
    throw new Error("Provide a channel URL, e.g. https://www.youtube.com/@handle");
  }
  const base = `https://www.youtube.com${p}`;
  return /\/(videos|shorts|streams|playlists|featured)$/.test(p) ? base : `${base}/videos`;
}

export function isChannelUrl(raw) {
  try { normalizeChannelUrl(raw); return true; } catch { return false; }
}

function ensureToolInstalled(name) {
  if (spawnSync("which", [name], { encoding: "utf8" }).status !== 0) {
    throw new Error(`${name} is not installed or not on PATH.`);
  }
}

// Pick a square-ish, high-resolution channel avatar from yt-dlp's thumbnails.
export function pickChannelAvatar(data) {
  const thumbs = (Array.isArray(data.thumbnails) ? data.thumbnails : []).filter((t) => t && t.url);
  if (!thumbs.length) return null;
  const square = thumbs.filter((t) => t.width && t.height && t.width === t.height);
  const pool = square.length ? square : thumbs;
  return pool.sort((a, b) => (b.width || b.preference || 0) - (a.width || a.preference || 0))[0].url;
}

// Turn yt-dlp's flat channel dump into a compact manifest with follow-metrics.
export function parseChannelDump(data) {
  const channelId = data.channel_id || data.uploader_id || data.id || "";
  const name = data.channel || data.uploader || data.title || channelId;
  const handle = (data.uploader_id && data.uploader_id.startsWith("@")) ? data.uploader_id : (data.uploader_id || "");
  const url = data.channel_url || data.webpage_url ||
    (handle ? `https://www.youtube.com/${handle}` : (channelId ? `https://www.youtube.com/channel/${channelId}` : ""));
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const videos = entries
    .filter((e) => e && e.id)
    .map((e) => ({ id: e.id, title: e.title || e.id, duration: e.duration ?? null, views: e.view_count ?? null }));
  const totalViews = videos.reduce((sum, v) => sum + (v.views || 0), 0);
  return {
    channelId,
    name,
    handle,
    url,
    subscribers: data.channel_follower_count ?? null,
    description: data.description ? String(data.description).slice(0, 500) : null,
    avatar: pickChannelAvatar(data),
    videoCount: videos.length,
    totalViews,
    videos,
  };
}

function runYtDlpChannel(target) {
  const result = spawnSync("yt-dlp", ["--flat-playlist", "-J", ...ytdlpAuthArgs(), target], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`yt-dlp failed.\n${result.stderr || result.stdout}`);
  try { return JSON.parse(result.stdout); } catch { throw new Error("Could not parse yt-dlp channel output."); }
}

export function buildChannel({ url, outDir = DEFAULT_OUT_DIR }) {
  const target = normalizeChannelUrl(url);
  ensureToolInstalled("yt-dlp");
  progress("channel-fetch", "Listing channel videos");
  const dump = runYtDlpChannel(target);
  progress("channel-parse", "Parsing video list");
  const parsed = parseChannelDump(dump);
  if (!parsed.channelId || !CHANNEL_ID.test(parsed.channelId)) {
    throw new Error("Could not resolve a channel id.");
  }
  const channelsDir = path.join(outDir, "channels");
  fs.mkdirSync(channelsDir, { recursive: true });
  const jsonPath = path.join(channelsDir, `${parsed.channelId}.channel.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return {
    channelId: parsed.channelId,
    name: parsed.name,
    handle: parsed.handle,
    url: parsed.url,
    subscribers: parsed.subscribers,
    totalViews: parsed.totalViews,
    videoCount: parsed.videos.length,
    jsonPath,
  };
}

function main() {
  try {
    const url = process.argv[2];
    if (!url || url === "-h" || url === "--help") {
      console.log('Usage: node scripts/channel-tool.mjs "<youtube-channel-url>" [--out-dir <path>]');
      return;
    }
    let outDir = DEFAULT_OUT_DIR;
    const outFlag = process.argv.indexOf("--out-dir");
    if (outFlag !== -1 && process.argv[outFlag + 1]) outDir = path.resolve(process.argv[outFlag + 1]);
    console.log(JSON.stringify({ ok: true, ...buildChannel({ url, outDir }) }, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

#!/usr/bin/env node
// Local dashboard for the YouTube Comments Analyzer.
// Lists every analyzed video (scanned from output/*.comments.json) and provides an
// "Add a video" form that runs the extraction pipeline and, when Neo4j credentials are
// present, imports the result. Loopback-only by design — this is a local dev tool, not a
// Synapse runtime service (see README + docs/neo4j/security.md).

// fallow-ignore-file complexity -- standalone local dashboard has no coverage-backed CI baseline yet.
// fallow-ignore-file code-duplication -- dashboard handlers intentionally share local SSE/JSON plumbing.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadDotEnv, resolveConfig, cypher, cypherRows } from "./neo4j-lib.mjs";
import { normalizeGraph, NODE_STYLES } from "./graph-view.mjs";
import { isChannelUrl, CHANNEL_ID } from "./channel-tool.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const OUT_DIR = path.join(PROJECT_DIR, "output");
const TOOL = path.join(SCRIPT_DIR, "youtube-comments-tool.mjs");
const TRANSCRIPT = path.join(SCRIPT_DIR, "transcript-tool.mjs");
const DOCUMENT = path.join(SCRIPT_DIR, "document-tool.mjs");
const MINDMAP = path.join(SCRIPT_DIR, "mindmap-tool.mjs");
const CHANNEL = path.join(SCRIPT_DIR, "channel-tool.mjs");
const CHANNELS_DIR = path.join(OUT_DIR, "channels");
const IMPORTER = path.join(SCRIPT_DIR, "neo4j-import-youtube-comments.mjs");
const CHANNEL_IMPORTER = path.join(SCRIPT_DIR, "neo4j-import-channel.mjs");
const DOCUMENT_GRAPH = path.join(SCRIPT_DIR, "document-graph-tool.mjs");
const DOCUMENT_IMPORTER = path.join(SCRIPT_DIR, "neo4j-import-document.mjs");

const HOST = "127.0.0.1";
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 4478);
const POST_TOKEN = process.env.YCA_POST_TOKEN || randomBytes(24).toString("hex");
const configuredChildTimeoutMs = Number(process.env.YCA_CHILD_TIMEOUT_MS || 15 * 60 * 1000);
const CHILD_TIMEOUT_MS = Number.isFinite(configuredChildTimeoutMs) && configuredChildTimeoutMs > 0
  ? configuredChildTimeoutMs
  : 15 * 60 * 1000;

const YT_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;

// --- Pure, testable helpers -------------------------------------------------

export function isYouTubeUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    return (url.protocol === "http:" || url.protocol === "https:") &&
      YT_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function safeMtime(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return "1970-01-01T00:00:00.000Z"; }
}

// Title fallback for videos that have no comments JSON (transcript/document only):
// read the info JSON, else parse a generated page's <title>.
function fallbackTitle(outDir, videoId, files) {
  const infoPath = path.join(outDir, `${videoId}.info.json`);
  if (fs.existsSync(infoPath)) {
    try { const t = JSON.parse(fs.readFileSync(infoPath, "utf8")).title; if (t) return t; } catch { /* ignore */ }
  }
  for (const name of files) {
    try {
      const m = fs.readFileSync(path.join(outDir, name), "utf8").match(/<title>([\s\S]*?)<\/title>/i);
      if (m) return m[1].replace(/^Transcript\s+[—-]\s+/, "").trim();
    } catch { /* ignore */ }
  }
  return null;
}

// Resolve a video's channel from its comments JSON, falling back to the info JSON.
function videoChannel(outDir, videoId, data) {
  if (data?.video?.channelId || data?.video?.channel) {
    return { channel: data.video.channel || null, channelId: data.video.channelId || null, handle: data.video.handle || null };
  }
  const infoPath = path.join(outDir, `${videoId}.info.json`);
  if (fs.existsSync(infoPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
      return { channel: info.channel || info.uploader || null, channelId: info.channel_id || null, handle: info.uploader_id || null };
    } catch { /* ignore */ }
  }
  return { channel: null, channelId: null, handle: null };
}

// Scan the output directory and summarize every video that has ANY generated artifact —
// a comments report, a transcript, and/or a document — so a chosen video is listable and
// its pages linkable even when its comments were never extracted.
export function listVideos(outDir = OUT_DIR) {
  if (!fs.existsSync(outDir)) return [];
  const ids = new Set();
  for (const file of fs.readdirSync(outDir)) {
    const m = file.match(/^(.+)\.(comments\.json|comments\.html|transcript\.html|document\.html|mindmap\.html)$/);
    if (m) ids.add(m[1]);
  }

  const videos = [];
  for (const videoId of ids) {
    const commentsJson = path.join(outDir, `${videoId}.comments.json`);
    const htmlFile = `${videoId}.comments.html`;
    const transcriptFile = `${videoId}.transcript.html`;
    const documentFile = `${videoId}.document.html`;

    let data = null;
    if (fs.existsSync(commentsJson)) {
      try { data = JSON.parse(fs.readFileSync(commentsJson, "utf8")); } catch { data = null; }
    }

    const hasReport = fs.existsSync(path.join(outDir, htmlFile));
    const hasTranscript = fs.existsSync(path.join(outDir, transcriptFile));
    const hasDocument = fs.existsSync(path.join(outDir, documentFile));
    const hasMindmap = fs.existsSync(path.join(outDir, `${videoId}.mindmap.html`));
    // Skip an id whose only trace is an unreadable comments JSON (nothing to show/link).
    if (!data && !hasReport && !hasTranscript && !hasDocument && !hasMindmap) continue;

    const hasComments = Boolean(data);
    const title = data?.video?.title || fallbackTitle(outDir, videoId, [transcriptFile, documentFile]) || videoId;
    const ch = videoChannel(outDir, videoId, data);
    const stampSource = hasComments ? commentsJson
      : path.join(outDir, hasDocument ? documentFile : (hasTranscript ? transcriptFile : htmlFile));

    videos.push({
      videoId,
      title,
      url: data?.video?.url || `https://www.youtube.com/watch?v=${videoId}`,
      channel: ch.channel,
      channelId: ch.channelId,
      handle: ch.handle,
      hasComments,
      comments: hasComments ? (Array.isArray(data.comments) ? data.comments.length : (data.video?.extractedCommentCount || 0)) : null,
      profile: hasComments ? (data.classification?.profile || "unknown") : null,
      hasReport,
      hasTranscript,
      hasDocument,
      hasMindmap,
      htmlFile,
      transcriptFile,
      documentFile,
      updatedAt: safeMtime(stampSource),
    });
  }
  videos.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return videos;
}

function withVideoDefaults(video) {
  const videoId = video.videoId || video.id;
  return {
    videoId,
    title: video.title || videoId,
    url: video.url || `https://www.youtube.com/watch?v=${videoId}`,
    channel: video.channel || null,
    channelId: video.channelId || null,
    handle: video.handle || null,
    hasComments: Boolean(video.hasComments),
    comments: video.comments ?? null,
    profile: video.profile ?? null,
    hasReport: Boolean(video.hasReport),
    hasTranscript: Boolean(video.hasTranscript),
    hasDocument: Boolean(video.hasDocument),
    hasMindmap: Boolean(video.hasMindmap),
    htmlFile: video.htmlFile || `${videoId}.comments.html`,
    transcriptFile: video.transcriptFile || `${videoId}.transcript.html`,
    documentFile: video.documentFile || `${videoId}.document.html`,
    updatedAt: video.updatedAt || "1970-01-01T00:00:00.000Z",
    inNeo4j: video.inNeo4j ?? null,
    source: video.source || "local",
  };
}

export function mergeVideos(localVideos, graphVideos) {
  const byId = new Map();
  for (const graphVideo of graphVideos || []) {
    const video = withVideoDefaults({ ...graphVideo, source: "graph", inNeo4j: true });
    byId.set(video.videoId, video);
  }
  for (const localVideo of localVideos || []) {
    const local = withVideoDefaults(localVideo);
    const graph = byId.get(local.videoId);
    byId.set(local.videoId, {
      ...graph,
      ...local,
      comments: local.comments ?? graph?.comments ?? null,
      profile: local.profile ?? graph?.profile ?? null,
      channel: local.channel ?? graph?.channel ?? null,
      channelId: local.channelId ?? graph?.channelId ?? null,
      handle: local.handle ?? graph?.handle ?? null,
      inNeo4j: graph ? true : local.inNeo4j,
      source: graph ? "local+graph" : "local",
    });
  }
  return [...byId.values()].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

// Extract the JSON object a child script prints on stdout (tolerates surrounding noise).
export function parseToolJson(stdout) {
  const text = String(stdout || "").trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

export function isValidPostToken(headers, expectedToken = POST_TOKEN) {
  const value = headers?.["x-yca-token"] ?? headers?.["X-YCA-Token"];
  return typeof value === "string" && value.length > 0 && value === expectedToken;
}

function requirePostToken(req, res) {
  if (isValidPostToken(req.headers)) return true;
  sendJson(res, 403, { ok: false, error: "Forbidden: invalid dashboard mutation token." });
  return false;
}

// --- Runtime ----------------------------------------------------------------

export function run(cmd, args, envExtra, timeoutMs = CHILD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: PROJECT_DIR, env: { ...process.env, ...(envExtra || {}) } });
    let stdout = "", stderr = "";
    let settled = false;
    let timedOut = false;
    const commandLabel = path.basename(cmd);
    const finish = (code, finalStderr = stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: finalStderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\n${commandLabel} timed out after ${timeoutMs}ms`;
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 2000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => finish(-1, `${stderr}${stderr ? "\n" : ""}${err.message}`));
    child.on("close", (code) => finish(timedOut ? -2 : code, stderr));
  });
}

// Like run(), but invokes onLine for each complete stderr line as it arrives (for
// streaming per-stage progress). stdout is still buffered for the final JSON result.
function runStreaming(cmd, args, onLine, envExtra, timeoutMs = CHILD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: PROJECT_DIR, env: { ...process.env, ...(envExtra || {}) } });
    let stdout = "", stderr = "", buffer = "";
    let settled = false;
    let timedOut = false;
    const commandLabel = path.basename(cmd);
    const finish = (code, finalStderr = stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: finalStderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const message = `${commandLabel} timed out after ${timeoutMs}ms`;
      stderr += `\n${message}`;
      try { onLine(JSON.stringify({ progress: "timeout", message })); } catch { /* ignore */ }
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, 2000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => {
      stderr += d;
      buffer += d;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) { try { onLine(line); } catch { /* ignore bad line */ } }
      }
    });
    child.on("error", (err) => finish(-1, `${stderr}${stderr ? "\n" : ""}${err.message}`));
    child.on("close", (code) => finish(timedOut ? -2 : code, stderr));
  });
}

// Best-effort: which video ids are already in Neo4j. null when Neo4j is unavailable.
async function neo4jVideoIds() {
  try {
    if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) return null;
    const config = resolveConfig({});
    const rows = await cypherRows(config, "MATCH (v:YouTubeVideo) RETURN v.id");
    return new Set(rows.map((row) => row[0]));
  } catch {
    return null;
  }
}

function hasNeo4jConfig() {
  return Boolean(process.env.NEO4J_USER && process.env.NEO4J_PASSWORD);
}

async function listNeo4jVideos() {
  try {
    if (!hasNeo4jConfig()) return null;
    const config = resolveConfig({});
    const rows = await cypherRows(config, `
      MATCH (v:YouTubeVideo)
      OPTIONAL MATCH (ch:YouTubeChannel)-[:PUBLISHED]->(v)
      OPTIONAL MATCH (v)-[:HAS_COMMENT]->(comment:YouTubeComment)
      OPTIONAL MATCH (v)-[:USES_CLASSIFICATION_PROFILE]->(profile:ClassificationProfile)
      WITH v, ch, count(DISTINCT comment) AS comments, collect(DISTINCT profile.name) AS profiles
      RETURN v.id, v.title, v.url, coalesce(v.channel, ch.name),
             coalesce(v.channelId, ch.id), coalesce(v.handle, ch.handle),
             comments, profiles[0], toString(v.updatedAt)
      ORDER BY toLower(coalesce(v.title, v.id))
    `);
    return rows
      .filter(([id]) => id)
      .map(([videoId, title, url, channel, channelId, handle, comments, profile, updatedAt]) => ({
        videoId,
        title,
        url,
        channel,
        channelId,
        handle,
        comments,
        profile,
        updatedAt: updatedAt || "1970-01-01T00:00:00.000Z",
        inNeo4j: true,
        source: "graph",
      }));
  } catch {
    return null;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error("Request body too large."));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// Serve a data asset (JSON) from OUT_DIR with path-traversal protection.
function serveFile(res, videoId, suffix) {
  if (!VIDEO_ID.test(videoId)) return sendJson(res, 400, { ok: false, error: "Bad video id." });
  const resolved = path.resolve(path.join(OUT_DIR, `${videoId}${suffix}`));
  if (!resolved.startsWith(path.resolve(OUT_DIR) + path.sep)) {
    return sendJson(res, 400, { ok: false, error: "Bad path." });
  }
  if (!fs.existsSync(resolved)) return sendJson(res, 404, { ok: false, error: "Not found." });
  res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(suffix)] || "application/octet-stream" });
  fs.createReadStream(resolved).pipe(res);
}

function escapeHtmlServer(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function videoArtifacts(videoId) {
  return {
    report: fs.existsSync(path.join(OUT_DIR, `${videoId}.comments.html`)),
    transcript: fs.existsSync(path.join(OUT_DIR, `${videoId}.transcript.html`)),
    document: fs.existsSync(path.join(OUT_DIR, `${videoId}.document.html`)),
    mindmap: fs.existsSync(path.join(OUT_DIR, `${videoId}.mindmap.html`)),
  };
}

function videoTitle(videoId) {
  const cj = path.join(OUT_DIR, `${videoId}.comments.json`);
  if (fs.existsSync(cj)) {
    try { const t = JSON.parse(fs.readFileSync(cj, "utf8")).video?.title; if (t) return t; } catch { /* ignore */ }
  }
  return fallbackTitle(OUT_DIR, videoId, [`${videoId}.transcript.html`, `${videoId}.document.html`]);
}

// A consistent site nav bar shared by the dashboard, channel pages, and generated views.
export function renderTopNav({ title = "", current = "", links = [], youtubeUrl = "" } = {}) {
  const sep = ' <span style="color:#475569;">·</span> ';
  const dashboard = current === "dashboard"
    ? `<span style="color:#5eead4;font-weight:800;white-space:nowrap;">Dashboard</span>`
    : `<a href="/" style="color:#99f6e4;text-decoration:none;font-weight:800;white-space:nowrap;">← Dashboard</a>`;
  const siblings = links.map(({ key, label, href }) => current === key
    ? `<span style="color:#5eead4;font-weight:800;white-space:nowrap;">${escapeHtmlServer(label)}</span>`
    : `<a href="${escapeHtmlServer(href)}" style="color:#cbd5e1;text-decoration:none;white-space:nowrap;">${escapeHtmlServer(label)}</a>`
  ).join(sep);
  const youtube = youtubeUrl
    ? `<a href="${escapeHtmlServer(youtubeUrl)}" target="_blank" rel="noreferrer" style="color:#cbd5e1;text-decoration:none;white-space:nowrap;">▶ YouTube</a>`
    : "";
  const right = [siblings, youtube].filter(Boolean).join(sep);
  return `<nav style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:9px 18px;background:#0b1120;color:#cbd5e1;border-bottom:1px solid rgba(148,163,184,0.22);font:600 13px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
    dashboard +
    (title ? `<span style="color:#64748b;min-width:0;max-width:min(44ch,52vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtmlServer(title)}</span>` : "") +
    `<span style="flex:1;min-width:12px;"></span>` +
    right +
    `</nav>`;
}

// Video pages link to the sibling artifacts that actually exist, with the current page highlighted.
function navBar(videoId, current) {
  const A = videoArtifacts(videoId);
  A[current] = true; // the page being served necessarily exists
  const id = encodeURIComponent(videoId);
  const title = videoTitle(videoId);
  const defs = [["report", "Comments", `/report/${id}`], ["transcript", "Transcript", `/transcript/${id}`], ["document", "Document", `/document/${id}`], ["mindmap", "Mind map", `/mindmap/${id}`]];
  return renderTopNav({
    title,
    current,
    links: defs.filter(([key]) => A[key]).map(([key, label, href]) => ({ key, label, href })),
    youtubeUrl: `https://www.youtube.com/watch?v=${id}`,
  });
}

function channelNavBar(channelId) {
  const channel = readChannel(channelId) || {};
  return renderTopNav({
    title: channel.name || channel.handle || channelId,
    current: "channel",
    youtubeUrl: channel.url || "",
  });
}

// Serve a generated video page with the shared nav bar injected right after <body>.
function serveVideoPage(res, videoId, current) {
  if (!VIDEO_ID.test(videoId)) return sendJson(res, 400, { ok: false, error: "Bad video id." });
  const suffix = { report: ".comments.html", transcript: ".transcript.html", document: ".document.html", mindmap: ".mindmap.html" }[current];
  const resolved = path.resolve(path.join(OUT_DIR, `${videoId}${suffix}`));
  if (!resolved.startsWith(path.resolve(OUT_DIR) + path.sep)) {
    return sendJson(res, 400, { ok: false, error: "Bad path." });
  }
  if (!fs.existsSync(resolved)) return sendJson(res, 404, { ok: false, error: "Not found." });
  let html = fs.readFileSync(resolved, "utf8");
  const bar = navBar(videoId, current);
  html = /<body[^>]*>/i.test(html) ? html.replace(/(<body[^>]*>)/i, `$1\n${bar}`) : bar + html;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

// Move a video's generated files into output/.trash/ (recoverable) rather than deleting.
export function trashVideoFiles(videoId, outDir = OUT_DIR, stamp = Date.now()) {
  const trashDir = path.join(outDir, ".trash", `${videoId}-${stamp}`);
  const moved = [];
  const move = (name) => {
    const src = path.join(outDir, name);
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(src, path.join(trashDir, name));
    moved.push(name);
  };
  for (const ext of [".comments.json", ".comments.html", ".info.json", ".transcript.html", ".document.html", ".document.md", ".mindmap.html", ".mindmap.json"]) {
    move(`${videoId}${ext}`);
  }
  // Sweep caption files (<id>.<lang>.json3) and any leftover document frame images.
  if (fs.existsSync(outDir)) {
    for (const file of fs.readdirSync(outDir)) {
      if (file.startsWith(`${videoId}.`) && (file.endsWith(".json3") || /\.frame-\d+\.jpg$/.test(file))) move(file);
    }
  }
  return { trashDir, moved };
}

// Detach-delete a video from Neo4j, then sweep nodes it orphaned (authors/categories/
// profile with no remaining edges). Mirrors the manual cleanup used during testing.
async function removeFromNeo4j(videoId) {
  if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    return { ok: false, skipped: true, reason: "Neo4j credentials not set" };
  }
  try {
    const config = resolveConfig({});
    await cypher(config, "MATCH (:YouTubeVideo {id: $id})-[:HAS_COMMENT]->(c:YouTubeComment) DETACH DELETE c", { id: videoId });
    await cypher(config, "MATCH (v:YouTubeVideo {id: $id}) DETACH DELETE v", { id: videoId });
    await cypher(config, "MATCH (a:YouTubeAuthor) WHERE NOT (a)-[:WROTE]->() DETACH DELETE a");
    await cypher(config, "MATCH (cat:CommentCategory) WHERE NOT ()-[:IN_CATEGORY]->(cat) DETACH DELETE cat");
    await cypher(config, "MATCH (p:ClassificationProfile) WHERE NOT ()-[:USES_CLASSIFICATION_PROFILE]->(p) DETACH DELETE p");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function handleRemove(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req) || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body." });
  }
  const videoId = (body.videoId || "").trim();
  if (!VIDEO_ID.test(videoId)) {
    return sendJson(res, 400, { ok: false, error: "Bad video id." });
  }
  const files = trashVideoFiles(videoId);
  const neo4j = await removeFromNeo4j(videoId);
  return sendJson(res, 200, {
    ok: true,
    videoId,
    removedFiles: files.moved,
    trashDir: path.relative(PROJECT_DIR, files.trashDir),
    neo4j,
  });
}

let busy = false;

// Forward a child's NDJSON progress lines as SSE events.
function sseProgress(send) {
  return (line) => {
    try {
      const p = JSON.parse(line);
      if (p.progress) send({ stage: p.progress, status: "running", message: p.message || "" });
    } catch { /* non-JSON log line */ }
  };
}

// Run the document tool, streaming its per-stage progress. Best-effort; returns a summary.
async function buildDocumentStreaming(url, send) {
  send({ stage: "document", status: "running", message: "Building document" });
  const doc = await runStreaming(process.execPath, [DOCUMENT, url], sseProgress(send), { YCA_PROGRESS: "1" });
  const result = parseToolJson(doc.stdout);
  if (doc.code === 0 && result?.ok) {
    send({ stage: "document", status: "done", message: `${result.images} images · ${result.sections} sections` });
    return { ok: true, sections: result.sections, images: result.images };
  }
  const error = (result?.error || doc.stderr.trim() || `exit ${doc.code}`).slice(0, 200);
  send({ stage: "document", status: "error", message: error });
  return { ok: false, error };
}

// Build the document graph (chapters -> paragraphs -> concepts) and import it into Neo4j,
// streaming progress. Structural by default; YCA_DOCUMENT_GRAPH_SEMANTIC=1 adds Ollama
// concepts (slow — one model call per paragraph). Best-effort: never throws to the caller.
async function importDocumentGraph(videoId, forwardProgress, send, opts = {}) {
  send({ stage: "mindmap", status: "running", message: "Building document mindmap" });
  // opts.semantic forces concept extraction (the on-demand button); otherwise honor the env flag.
  const semantic = opts.semantic ?? (process.env.YCA_DOCUMENT_GRAPH_SEMANTIC === "1");
  const graphArgs = [DOCUMENT_GRAPH, videoId, ...(semantic ? ["--semantic"] : [])];
  const build = await runStreaming(process.execPath, graphArgs, forwardProgress, { YCA_PROGRESS: "1" });
  const built = parseToolJson(build.stdout);
  if (build.code !== 0 || !built?.ok) {
    const error = (built?.error || build.stderr.trim() || `exit ${build.code}`).slice(0, 200);
    send({ stage: "mindmap", status: "error", message: error });
    return { ok: false, error };
  }
  const imp = await run(process.execPath, [DOCUMENT_IMPORTER, built.graphJsonPath]);
  const impResult = parseToolJson(imp.stdout);
  if (imp.code === 0 && impResult?.ok) {
    const parts = `${built.chapters} chapters · ${built.paragraphs} paragraphs${built.concepts ? ` · ${built.concepts} concepts` : ""}`;
    send({ stage: "mindmap", status: "done", message: parts });
    return { ok: true, chapters: built.chapters, paragraphs: built.paragraphs, concepts: built.concepts };
  }
  const error = (impResult?.error || imp.stderr.trim() || `exit ${imp.code}`).slice(0, 200);
  send({ stage: "mindmap", status: "error", message: error });
  return { ok: false, error };
}

// Run the channel tool, streaming its progress; returns a channel summary.
async function buildChannelStreaming(url, send) {
  send({ stage: "channel", status: "running", message: "Listing channel videos" });
  const out = await runStreaming(process.execPath, [CHANNEL, url], sseProgress(send), { YCA_PROGRESS: "1" });
  const result = parseToolJson(out.stdout);
  if (out.code === 0 && result?.ok) {
    send({ stage: "channel", status: "done", message: `${result.videoCount} videos` });
    return { ok: true, channelId: result.channelId, name: result.name, handle: result.handle, url: result.url, videoCount: result.videoCount };
  }
  const error = (result?.error || out.stderr.trim() || `exit ${out.code}`).slice(0, 200);
  send({ stage: "channel", status: "error", message: error });
  return { ok: false, error };
}

// Import the channel + its videos into Neo4j (best-effort, streamed).
async function importChannelGraphStreaming(channelId, send) {
  if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    send({ stage: "graph", status: "skipped", message: "Neo4j credentials not set" });
    return { ok: false, skipped: true };
  }
  send({ stage: "graph", status: "running", message: "Adding channel to Neo4j" });
  const out = await runStreaming(process.execPath, [CHANNEL_IMPORTER, channelId], sseProgress(send), { YCA_PROGRESS: "1" });
  const result = parseToolJson(out.stdout);
  if (out.code === 0 && result?.ok) {
    send({ stage: "graph", status: "done", message: `${result.summary?.linkedVideos ?? result.summary?.videos ?? ""} videos linked` });
    return { ok: true };
  }
  const error = (result?.error || out.stderr.trim() || `exit ${out.code}`).slice(0, 200);
  send({ stage: "graph", status: "error", message: error });
  return { ok: false, error };
}

async function handleAddChannel(req, res) {
  if (busy) {
    return sendJson(res, 409, { ok: false, error: "Another job is already running. Try again shortly." });
  }
  let body;
  try { body = JSON.parse(await readBody(req) || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON body." }); }
  const url = (body.url || "").trim();
  if (!isChannelUrl(url)) {
    return sendJson(res, 400, { ok: false, error: "Provide a valid YouTube channel URL (e.g. https://www.youtube.com/@handle)." });
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  busy = true;
  try {
    send({ stage: "start" });
    const channel = await buildChannelStreaming(url, send);
    if (!channel.ok) { send({ stage: "error", error: channel.error }); return res.end(); }
    const graph = await importChannelGraphStreaming(channel.channelId, send);
    send({ stage: "complete", channel, graph });
    res.end();
  } catch (error) {
    send({ stage: "error", error: error.message });
    res.end();
  } finally {
    busy = false;
  }
}

function processedState(videoId) {
  return {
    hasComments: fs.existsSync(path.join(OUT_DIR, `${videoId}.comments.json`)),
    hasReport: fs.existsSync(path.join(OUT_DIR, `${videoId}.comments.html`)),
    hasTranscript: fs.existsSync(path.join(OUT_DIR, `${videoId}.transcript.html`)),
    hasDocument: fs.existsSync(path.join(OUT_DIR, `${videoId}.document.html`)),
  };
}

export function listChannels(dir = CHANNELS_DIR) {
  if (!fs.existsSync(dir)) return [];
  // Which videos have been analyzed (comments extracted), for a per-channel "analyzed" count.
  const analyzed = new Set();
  if (fs.existsSync(OUT_DIR)) {
    for (const f of fs.readdirSync(OUT_DIR)) {
      const m = f.match(/^(.+)\.comments\.json$/);
      if (m) analyzed.add(m[1]);
    }
  }
  const channels = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".channel.json")) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (!c.channelId) continue;
      const vids = c.videos || [];
      channels.push({
        channelId: c.channelId,
        name: c.name,
        handle: c.handle,
        url: c.url,
        avatar: c.avatar ?? null,
        subscribers: c.subscribers ?? null,
        totalViews: c.totalViews ?? null,
        videoCount: vids.length,
        analyzedCount: vids.reduce((n, v) => n + (v && analyzed.has(v.id) ? 1 : 0), 0),
      });
    } catch { /* skip malformed */ }
  }
  channels.sort((a, b) => (b.subscribers || 0) - (a.subscribers || 0) || String(a.name || "").localeCompare(String(b.name || "")));
  return channels;
}

function withChannelDefaults(channel) {
  return {
    channelId: channel.channelId,
    name: channel.name || channel.channelId,
    handle: channel.handle || null,
    url: channel.url || null,
    avatar: channel.avatar ?? null,
    subscribers: channel.subscribers ?? null,
    totalViews: channel.totalViews ?? null,
    videoCount: channel.videoCount ?? 0,
    analyzedCount: channel.analyzedCount ?? 0,
    source: channel.source || "local",
  };
}

export function mergeChannels(localChannels, graphChannels) {
  const byId = new Map();
  for (const graphChannel of graphChannels || []) {
    if (!graphChannel.channelId) continue;
    const channel = withChannelDefaults({ ...graphChannel, source: "graph" });
    byId.set(channel.channelId, channel);
  }
  for (const localChannel of localChannels || []) {
    if (!localChannel.channelId) continue;
    const local = withChannelDefaults(localChannel);
    const graph = byId.get(local.channelId);
    byId.set(local.channelId, {
      ...graph,
      ...local,
      handle: local.handle ?? graph?.handle ?? null,
      url: local.url ?? graph?.url ?? null,
      avatar: local.avatar ?? graph?.avatar ?? null,
      subscribers: local.subscribers ?? graph?.subscribers ?? null,
      totalViews: local.totalViews ?? graph?.totalViews ?? null,
      videoCount: Math.max(local.videoCount || 0, graph?.videoCount || 0),
      analyzedCount: Math.max(local.analyzedCount || 0, graph?.analyzedCount || 0),
      source: graph ? "local+graph" : "local",
    });
  }
  return [...byId.values()].sort((a, b) =>
    (b.subscribers || 0) - (a.subscribers || 0) ||
    String(a.name || "").localeCompare(String(b.name || "")));
}

async function listNeo4jChannels() {
  try {
    if (!hasNeo4jConfig()) return null;
    const config = resolveConfig({});
    const rows = await cypherRows(config, `
      MATCH (ch:YouTubeChannel)
      OPTIONAL MATCH (ch)-[:PUBLISHED]->(v:YouTubeVideo)
      WITH ch, count(DISTINCT v) AS videoCount
      OPTIONAL MATCH (ch)-[:PUBLISHED]->(processed:YouTubeVideo)-[:HAS_COMMENT]->(:YouTubeComment)
      RETURN ch.id, ch.name, ch.handle, ch.url, ch.avatar, ch.subscribers,
             ch.totalViews, videoCount, count(DISTINCT processed)
      ORDER BY coalesce(ch.subscribers, 0) DESC, toLower(coalesce(ch.name, ch.id))
    `);
    return rows
      .filter(([id]) => id)
      .map(([channelId, name, handle, url, avatar, subscribers, totalViews, videoCount, analyzedCount]) => ({
        channelId,
        name,
        handle,
        url,
        avatar,
        subscribers,
        totalViews,
        videoCount,
        analyzedCount,
        source: "graph",
      }));
  } catch {
    return null;
  }
}

function readChannel(channelId) {
  const p = path.join(CHANNELS_DIR, `${channelId}.channel.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

async function readNeo4jChannel(channelId) {
  try {
    if (!hasNeo4jConfig()) return null;
    const config = resolveConfig({});
    const rows = await cypherRows(config, `
      MATCH (ch:YouTubeChannel {id: $channelId})
      OPTIONAL MATCH (ch)-[:PUBLISHED]->(v:YouTubeVideo)
      OPTIONAL MATCH (v)-[:HAS_COMMENT]->(comment:YouTubeComment)
      OPTIONAL MATCH (v)-[:USES_CLASSIFICATION_PROFILE]->(profile:ClassificationProfile)
      WITH ch, v, count(DISTINCT comment) AS comments, collect(DISTINCT profile.name) AS profiles
      RETURN ch.id, ch.name, ch.handle, ch.url, ch.avatar, ch.subscribers,
             ch.totalViews, v.id, v.title, v.url, v.duration, comments, profiles[0]
      ORDER BY toLower(coalesce(v.title, v.id))
    `, { channelId });
    if (!rows.length || !rows[0][0]) return null;
    const [id, name, handle, url, avatar, subscribers, totalViews] = rows[0];
    return {
      channelId: id,
      name,
      handle,
      url,
      avatar,
      subscribers,
      totalViews,
      videos: rows
        .filter((row) => row[7])
        .map((row) => ({
          id: row[7],
          title: row[8] || row[7],
          url: row[9] || `https://www.youtube.com/watch?v=${row[7]}`,
          duration: row[10] ?? null,
          comments: row[11] ?? 0,
          profile: row[12] ?? null,
        })),
    };
  } catch {
    return null;
  }
}

async function handleChannel(res, channelId) {
  if (!CHANNEL_ID.test(channelId)) return sendJson(res, 400, { ok: false, error: "Bad channel id." });
  const c = readChannel(channelId) || await readNeo4jChannel(channelId);
  if (!c) return sendJson(res, 404, { ok: false, error: "Channel not found." });
  const videos = (c.videos || []).map((v) => {
    const id = v.id || v.videoId;
    const state = processedState(id);
    return { ...v, id, ...state, hasComments: state.hasComments || (v.comments || 0) > 0 };
  });
  sendJson(res, 200, {
    ok: true,
    channel: { channelId: c.channelId, name: c.name, handle: c.handle, url: c.url, videoCount: videos.length },
    videos,
  });
}

// Run the mind-map tool (Ollama), streaming its per-stage progress.
async function buildMindmapStreaming(videoId, send) {
  send({ stage: "mindmap", status: "running", message: "Building mind map" });
  const out = await runStreaming(process.execPath, [MINDMAP, videoId], sseProgress(send), { YCA_PROGRESS: "1" });
  const result = parseToolJson(out.stdout);
  if (out.code === 0 && result?.ok) {
    send({ stage: "mindmap", status: "done", message: `${result.themes} themes · ${result.meanings} meanings` });
    return { ok: true, themes: result.themes, meanings: result.meanings, sentiment: result.sentiment };
  }
  const error = (result?.error || out.stderr.trim() || `exit ${out.code}`).slice(0, 200);
  send({ stage: "mindmap", status: "error", message: error });
  return { ok: false, error };
}

async function handleMindmap(req, res) {
  if (busy) {
    return sendJson(res, 409, { ok: false, error: "Another job is already running. Try again shortly." });
  }
  let body;
  try { body = JSON.parse(await readBody(req) || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON body." }); }
  const videoId = (body.videoId || "").trim();
  if (!VIDEO_ID.test(videoId)) return sendJson(res, 400, { ok: false, error: "Bad video id." });
  if (!fs.existsSync(path.join(OUT_DIR, `${videoId}.comments.json`))) {
    return sendJson(res, 400, { ok: false, error: "Extract this video's comments first." });
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  busy = true;
  try {
    send({ stage: "start" });
    const mindmap = await buildMindmapStreaming(videoId, send);
    if (!mindmap.ok) { send({ stage: "error", error: mindmap.error }); return res.end(); }
    send({ stage: "complete", videoId, mindmap });
    res.end();
  } catch (error) {
    send({ stage: "error", error: error.message });
    res.end();
  } finally {
    busy = false;
  }
}

// On-demand: build the SEMANTIC document mindmap (concepts + summaries via Ollama) for a
// video already fetched, and import it into Neo4j. Complements the add pipeline, which is
// structural-only by default so it stays fast.
async function handleConcepts(req, res) {
  if (busy) {
    return sendJson(res, 409, { ok: false, error: "Another job is already running. Try again shortly." });
  }
  let body;
  try { body = JSON.parse(await readBody(req) || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON body." }); }
  const videoId = (body.videoId || "").trim();
  if (!VIDEO_ID.test(videoId)) return sendJson(res, 400, { ok: false, error: "Bad video id." });
  if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    return sendJson(res, 400, { ok: false, error: "Set NEO4J_USER and NEO4J_PASSWORD to build the concept graph." });
  }
  if (!fs.existsSync(path.join(OUT_DIR, `${videoId}.info.json`))) {
    return sendJson(res, 400, { ok: false, error: "Fetch this video's transcript first." });
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const forwardProgress = sseProgress(send);
  busy = true;
  try {
    send({ stage: "start" });
    const mindmap = await importDocumentGraph(videoId, forwardProgress, send, { semantic: true });
    if (!mindmap.ok) { send({ stage: "error", error: mindmap.error }); return res.end(); }
    send({ stage: "complete", videoId, mindmap });
    res.end();
  } catch (error) {
    send({ stage: "error", error: error.message });
    res.end();
  } finally {
    busy = false;
  }
}

async function handleAdd(req, res) {
  if (busy) {
    return sendJson(res, 409, { ok: false, error: "Another extraction is already running. Try again shortly." });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req) || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body." });
  }
  const url = (body.url || "").trim();
  const buildDoc = Boolean(body.buildDoc);
  if (!isYouTubeUrl(url)) {
    return sendJson(res, 400, { ok: false, error: "Provide a valid YouTube URL (youtube.com or youtu.be)." });
  }

  // Stream progress as Server-Sent Events so the page can show each stage live.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const forwardProgress = sseProgress(send);

  busy = true;
  try {
    send({ stage: "start" });

    // Transcript first (best-effort): fetch captions and build the transcript page.
    // A transcript failure or a caption-less video never blocks comment extraction.
    send({ stage: "transcript", status: "running", message: "Fetching transcript" });
    const tr = await runStreaming(process.execPath, [TRANSCRIPT, url], forwardProgress, { YCA_PROGRESS: "1" });
    const trResult = parseToolJson(tr.stdout);
    let transcript;
    if (tr.code === 0 && trResult?.ok) {
      transcript = { ok: true, hasTranscript: trResult.hasTranscript, sections: trResult.sections };
      send({ stage: "transcript", status: "done", message: trResult.hasTranscript ? `${trResult.sections} sections` : "no captions found" });
    } else {
      transcript = { ok: false, error: (trResult?.error || tr.stderr.trim() || `exit ${tr.code}`).slice(0, 200) };
      send({ stage: "transcript", status: "error", message: transcript.error });
    }

    // Extraction emits per-stage NDJSON on stderr (YCA_PROGRESS); forward each line.
    const extract = await runStreaming(process.execPath, [TOOL, url], forwardProgress, { YCA_PROGRESS: "1" });
    const toolResult = parseToolJson(extract.stdout);
    if (extract.code !== 0 || !toolResult?.ok) {
      send({ stage: "error", error: toolResult?.error || extract.stderr.trim() || `exit ${extract.code}` });
      return res.end();
    }
    const video = {
      videoId: toolResult.videoId,
      title: toolResult.title,
      comments: toolResult.extractedComments,
      profile: toolResult.classificationProfile,
    };
    send({ stage: "extracted", status: "done", message: `${video.comments} comments`, video });

    let neo4j = null;
    if (process.env.NEO4J_USER && process.env.NEO4J_PASSWORD && toolResult.commentsJsonPath) {
      send({ stage: "neo4j", status: "running", message: "Importing to Neo4j" });
      // --update so re-adding an existing video refreshes its graph too. Best-effort:
      // a Neo4j failure does not fail the extraction that already succeeded.
      const imp = await run(process.execPath, [IMPORTER, toolResult.commentsJsonPath, "--update"]);
      const impResult = parseToolJson(imp.stdout);
      neo4j = imp.code === 0 && impResult?.ok
        ? { ok: true, action: impResult.action || "imported" }
        : { ok: false, error: (impResult?.error || imp.stderr.trim() || `exit ${imp.code}`) };
      send({ stage: "neo4j", status: neo4j.ok ? "done" : "error", message: neo4j.ok ? neo4j.action : neo4j.error });
    } else {
      send({ stage: "neo4j", status: "skipped", message: "Neo4j credentials not set" });
    }

    // Import the document mindmap (chapters -> paragraphs -> concepts) into Neo4j.
    // Needs captions + Neo4j creds; independent of the visual document. Structural by
    // default (fast); set YCA_DOCUMENT_GRAPH_SEMANTIC=1 to add Ollama concepts (slow).
    // Best-effort: a failure here never fails the extraction that already succeeded.
    let mindmap = null;
    if (process.env.NEO4J_USER && process.env.NEO4J_PASSWORD && transcript?.ok && transcript.hasTranscript) {
      mindmap = await importDocumentGraph(video.videoId, forwardProgress, send);
    } else {
      const why = !(process.env.NEO4J_USER && process.env.NEO4J_PASSWORD)
        ? "Neo4j credentials not set"
        : "no transcript to map";
      send({ stage: "mindmap", status: "skipped", message: why });
    }

    let document = null;
    if (buildDoc) {
      document = await buildDocumentStreaming(url, send);
    }

    send({ stage: "complete", video, neo4j, mindmap, transcript, document });
    res.end();
  } catch (error) {
    send({ stage: "error", error: error.message });
    res.end();
  } finally {
    busy = false;
  }
}

// Build (or rebuild) the document for an already-listed video, on demand.
async function handleDocument(req, res) {
  if (busy) {
    return sendJson(res, 409, { ok: false, error: "Another job is already running. Try again shortly." });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req) || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON body." });
  }
  const videoId = (body.videoId || "").trim();
  if (!VIDEO_ID.test(videoId)) {
    return sendJson(res, 400, { ok: false, error: "Bad video id." });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  busy = true;
  try {
    send({ stage: "start" });
    const document = await buildDocumentStreaming(`https://www.youtube.com/watch?v=${videoId}`, send);
    if (!document.ok) {
      send({ stage: "error", error: document.error });
      return res.end();
    }
    send({ stage: "complete", videoId, document });
    res.end();
  } catch (error) {
    send({ stage: "error", error: error.message });
    res.end();
  } finally {
    busy = false;
  }
}

async function handleVideos(res) {
  const localVideos = listVideos();
  const graphVideos = await listNeo4jVideos();
  const videos = graphVideos ? mergeVideos(localVideos, graphVideos) : localVideos;
  if (!graphVideos) {
    const inNeo4j = await neo4jVideoIds();
    for (const video of videos) {
      video.inNeo4j = inNeo4j ? inNeo4j.has(video.videoId) : null;
    }
  }
  sendJson(res, 200, {
    ok: true,
    neo4jAvailable: graphVideos !== null || videos.some((video) => video.inNeo4j !== null),
    graphBacked: graphVideos !== null,
    videos,
  });
}

async function handleChannels(res) {
  const localChannels = listChannels();
  const graphChannels = await listNeo4jChannels();
  const channels = graphChannels ? mergeChannels(localChannels, graphChannels) : localChannels;
  sendJson(res, 200, { ok: true, neo4jAvailable: graphChannels !== null, channels });
}

// ---- /graph/3d — Neo4j 3D view (Phase A of docs/neo4j-3d-view-yca-fit.md) -------------
const GRAPH_NODE_CAP = Number(process.env.YCA_GRAPH_NODE_CAP || 300);
const GRAPH_MAX_CONCEPTS = Number(process.env.YCA_GRAPH_MAX_CONCEPTS || 120);

function neo4jReadConfig() {
  if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) return null;
  return resolveConfig({});
}

// Schema + the list of graphed videos (for the picker). Read-only, best-effort.
async function handleGraphSchema(res) {
  const config = neo4jReadConfig();
  if (!config) return sendJson(res, 200, { ok: true, neo4jAvailable: false, labels: [], relationshipTypes: [], videos: [] });
  try {
    const [labels, relationshipTypes, videos] = await Promise.all([
      cypherRows(config, "MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS c ORDER BY c DESC"),
      cypherRows(config, "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c ORDER BY c DESC"),
      cypherRows(config, "MATCH (v:YouTubeVideo)-[:HAS_CHAPTER]->(ch:Chapter) RETURN v.id AS id, v.title AS title, count(ch) AS chapters ORDER BY chapters DESC, title"),
    ]);
    sendJson(res, 200, {
      ok: true,
      neo4jAvailable: true,
      labels: labels.map(([name, count]) => ({ name, count })),
      relationshipTypes: relationshipTypes.map(([name, count]) => ({ name, count })),
      videos: videos.map(([id, title, chapters]) => ({ id, title, chapters })),
    });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: `Neo4j read failed: ${error.message}` });
  }
}

// Overview subgraph for one video. Three views (?mode=):
//   concepts   — Video -> Chapters, plus a derived weighted Chapter-[:MENTIONS]->Concept
//                edge that collapses paragraphs into the readable chapter/concept map.
//   paragraphs — Video -> Chapters -> Paragraphs, each Paragraph shown by its SUMMARY (its
//                "context of the paragraph"), with real HAS_PARAGRAPH + paragraph NEXT.
//   both       — paragraphs plus real Paragraph-[:MENTIONS]->Concept edges.
// Optional ?chapter=<index> scopes to one chapter (avoids truncation for the paragraph
// views). Capped at GRAPH_NODE_CAP with a `truncated` flag (fit-doc §5).
async function handleGraphOverview(req, res, url) {
  const config = neo4jReadConfig();
  if (!config) return sendJson(res, 400, { ok: false, error: "Set NEO4J_USER and NEO4J_PASSWORD." });
  const maxConcepts = Math.max(0, Number(url.searchParams.get("maxConcepts")) || GRAPH_MAX_CONCEPTS);
  const mode = ["concepts", "paragraphs", "both"].includes(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "concepts";
  // Paragraph views need more room than the concept overview (a chapter can hold 120+
  // paragraphs, each with its concepts); the concept view stays tight at GRAPH_NODE_CAP.
  const defaultCap = mode === "concepts" ? GRAPH_NODE_CAP : GRAPH_NODE_CAP + 500;
  const limit = Math.max(1, Number(url.searchParams.get("limit")) || defaultCap);
  const chapterParam = url.searchParams.get("chapter");
  const chapterIndex = chapterParam != null && chapterParam !== "" && chapterParam !== "all" ? Number(chapterParam) : null;
  try {
    let videoId = (url.searchParams.get("videoId") || "").trim();
    if (!videoId) {
      const first = await cypherRows(config, "MATCH (v:YouTubeVideo)-[:HAS_CHAPTER]->() RETURN v.id ORDER BY v.id LIMIT 1");
      videoId = first[0]?.[0] || "";
    }
    if (!videoId || !VIDEO_ID.test(videoId)) return sendJson(res, 400, { ok: false, error: "No graphed video to show." });

    const [videoRow, chapters] = await Promise.all([
      cypherRows(config, "MATCH (v:YouTubeVideo {id:$id}) RETURN v.id, v.title, v.url", { id: videoId }),
      cypherRows(config, "MATCH (v:YouTubeVideo {id:$id})-[:HAS_CHAPTER]->(ch:Chapter) RETURN ch.id, ch.index, ch.title ORDER BY ch.index", { id: videoId }),
    ]);
    if (!videoRow.length) return sendJson(res, 404, { ok: false, error: "Video not found in the graph." });

    const rawNodes = [];
    const rawLinks = [];
    const [vid, vtitle, vurl] = videoRow[0];
    rawNodes.push({ id: vid, primaryLabel: "YouTubeVideo", name: vtitle || vid, properties: { url: vurl } });
    const shownChapters = chapterIndex == null ? chapters : chapters.filter(([, i]) => i === chapterIndex);
    for (const [chId, chIndex, chTitle] of shownChapters) {
      rawNodes.push({ id: chId, primaryLabel: "Chapter", name: chTitle || `Chapter ${chIndex}`, properties: { index: chIndex } });
      rawLinks.push({ source: vid, target: chId, type: "HAS_CHAPTER" });
    }
    if (chapterIndex == null) {
      for (let i = 0; i < chapters.length - 1; i++) rawLinks.push({ source: chapters[i][0], target: chapters[i + 1][0], type: "NEXT" });
    }
    const chapterFilter = chapterIndex == null ? "" : "WHERE ch.index = $chapter";

    if (mode === "concepts") {
      // Derived, weighted Chapter -> Concept (top concepts by weight).
      const chapterConcepts = await cypherRows(config, `
        MATCH (v:YouTubeVideo {id:$id})-[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_PARAGRAPH]->(:Paragraph)-[:MENTIONS]->(co:Concept)
        ${chapterFilter}
        WITH ch, co, count(*) AS weight
        RETURN ch.id AS chId, co.name AS concept, weight ORDER BY weight DESC`, { id: videoId, chapter: chapterIndex });
      const conceptWeight = new Map();
      for (const [, concept, weight] of chapterConcepts) conceptWeight.set(concept, (conceptWeight.get(concept) || 0) + weight);
      const topConcepts = new Set([...conceptWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxConcepts).map(([name]) => name));
      for (const name of topConcepts) rawNodes.push({ id: `concept:${name}`, primaryLabel: "Concept", name, properties: { totalWeight: conceptWeight.get(name) } });
      for (const [chId, concept, weight] of chapterConcepts) {
        if (topConcepts.has(concept)) rawLinks.push({ source: chId, target: `concept:${concept}`, type: "MENTIONS", weight });
      }
    } else {
      // Paragraph views: each Paragraph shown by its summary (its context).
      const paragraphs = await cypherRows(config, `
        MATCH (v:YouTubeVideo {id:$id})-[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_PARAGRAPH]->(p:Paragraph)
        ${chapterFilter}
        RETURN ch.id AS chId, p.id AS pId, p.index AS pIndex, p.start AS start, p.summary AS summary, left(p.text, 160) AS snippet
        ORDER BY ch.index, p.index`, { id: videoId, chapter: chapterIndex });
      const byChapter = new Map();
      for (const [chId, pId, pIndex, start, summary, snippet] of paragraphs) {
        const name = summary && String(summary).trim() ? summary : `${snippet}…`;
        rawNodes.push({ id: pId, primaryLabel: "Paragraph", name, properties: { start, summary: summary || null, index: pIndex } });
        rawLinks.push({ source: chId, target: pId, type: "HAS_PARAGRAPH" });
        if (!byChapter.has(chId)) byChapter.set(chId, []);
        byChapter.get(chId).push(pId);
      }
      for (const ids of byChapter.values()) {
        for (let i = 0; i < ids.length - 1; i++) rawLinks.push({ source: ids[i], target: ids[i + 1], type: "NEXT" });
      }
      if (mode === "both") {
        const mentions = await cypherRows(config, `
          MATCH (v:YouTubeVideo {id:$id})-[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_PARAGRAPH]->(p:Paragraph)-[:MENTIONS]->(co:Concept)
          ${chapterFilter}
          RETURN p.id AS pId, co.name AS concept`, { id: videoId, chapter: chapterIndex });
        const concepts = new Set();
        for (const [pId, concept] of mentions) {
          if (!concepts.has(concept)) { concepts.add(concept); rawNodes.push({ id: `concept:${concept}`, primaryLabel: "Concept", name: concept, properties: {} }); }
          rawLinks.push({ source: pId, target: `concept:${concept}`, type: "MENTIONS" });
        }
      }
    }

    const graph = normalizeGraph(rawNodes, rawLinks, { limit });
    sendJson(res, 200, {
      ok: true, videoId, title: vtitle, mode, chapter: chapterIndex,
      chapters: chapters.map(([, index, title]) => ({ index, title })),
      ...graph,
    });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: `Neo4j read failed: ${error.message}` });
  }
}

export function renderGraph3dPage() {
  const GROUP_COLORS = {
    video: "#f97316", chapter: "#38bdf8", concept: "#a78bfa", paragraph: "#94a3b8",
    author: "#f472b6", comment: "#64748b", category: "#facc15", context: "#34d399",
    channel: "#fb7185", other: "#cbd5e1",
  };
  const legend = Object.entries(GROUP_COLORS)
    .filter(([g]) => ["video", "chapter", "paragraph", "concept"].includes(g))
    .map(([g, c]) => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px;"><span style="width:10px;height:10px;border-radius:50%;background:${c};display:inline-block;"></span>${g}</span>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>3D Graph — YouTube Comments Analyzer</title>
<script src="https://unpkg.com/3d-force-graph@1.73.4/dist/3d-force-graph.min.js"></script>
<style>
  html,body { margin:0; height:100%; background:#05070d; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  #wrap { display:flex; flex-direction:column; height:100vh; }
  .toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:9px 18px; background:#0b1120; border-bottom:1px solid rgba(148,163,184,0.22); font-size:0.82rem; }
  .toolbar select, .toolbar button { min-height:30px; padding:0 10px; border:1px solid rgba(148,163,184,0.4); border-radius:7px; background:transparent; color:#e2e8f0; font:inherit; }
  .toolbar button:hover, .toolbar select:hover { border-color:#5eead4; color:#5eead4; }
  #status { color:#94a3b8; }
  #stage { flex:1; position:relative; min-height:0; }
  #graph { position:absolute; inset:0; }
  #inspector { position:absolute; top:12px; right:12px; width:280px; max-height:calc(100% - 24px); overflow:auto; background:rgba(11,17,32,0.92); border:1px solid rgba(148,163,184,0.3); border-radius:10px; padding:14px; font-size:0.82rem; display:none; }
  #inspector h3 { margin:0 0 6px; font-size:0.95rem; }
  #inspector .lbl { display:inline-block; background:#1c2740; border-radius:5px; padding:1px 7px; font-size:0.72rem; color:#99f6e4; margin-bottom:8px; }
  #inspector .row { margin:3px 0; color:#cbd5e1; word-break:break-word; }
  #inspector .k { color:#64748b; }
  #legend { color:#94a3b8; }
</style>
</head><body>
<div id="wrap">
  ${renderTopNav({ title: "3D Graph", current: "graph3d", links: [{ key: "graph3d", label: "3D Graph", href: "/graph/3d" }] })}
  <div class="toolbar">
    <label>Video <select id="video"></select></label>
    <label>View <select id="mode">
      <option value="concepts">Concepts</option>
      <option value="paragraphs">Paragraph context</option>
      <option value="both">Both</option>
    </select></label>
    <label>Chapter <select id="chapter"><option value="all">All chapters</option></select></label>
    <button id="reload" type="button">Reload</button>
    <button id="reset" type="button">Reset camera</button>
    <span id="legend">${legend}</span>
    <span id="status">Loading…</span>
  </div>
  <div id="stage">
    <div id="graph"></div>
    <div id="inspector"></div>
  </div>
</div>
<script>
  var GROUP_COLORS = ${JSON.stringify(GROUP_COLORS)};
  var el = function (id) { return document.getElementById(id); };
  var statusEl = el("status"), inspectorEl = el("inspector");
  var Graph = ForceGraph3D()(el("graph"))
    .backgroundColor("#05070d")
    .nodeLabel(function (n) { return n.name + " (" + n.primaryLabel + ")"; })
    .nodeColor(function (n) { return GROUP_COLORS[n.group] || GROUP_COLORS.other; })
    .nodeVal(function (n) { return n.size || 5; })
    .nodeOpacity(0.92)
    .linkColor(function () { return "rgba(148,163,184,0.35)"; })
    .linkDirectionalArrowLength(2.5)
    .linkDirectionalArrowRelPos(1)
    .onNodeClick(focusNode)
    .onBackgroundClick(function () { inspectorEl.style.display = "none"; });

  function sizeGraph() { Graph.width(el("stage").clientWidth).height(el("stage").clientHeight); }
  window.addEventListener("resize", sizeGraph);

  function focusNode(node) {
    var rows = "";
    var props = node.properties || {};
    for (var k in props) { if (props[k] != null && props[k] !== "") rows += '<div class="row"><span class="k">' + k + ':</span> ' + String(props[k]) + "</div>"; }
    inspectorEl.innerHTML = '<h3>' + escapeText(node.name) + '</h3><span class="lbl">' + node.primaryLabel + '</span>' +
      '<div class="row"><span class="k">id:</span> ' + escapeText(node.id) + "</div>" + rows;
    inspectorEl.style.display = "block";
    var d = 120, r = 1 + d / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
    Graph.cameraPosition({ x: (node.x || 0) * r, y: (node.y || 0) * r, z: (node.z || 0) * r }, node, 1200);
  }
  function escapeText(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  function params() {
    var q = "?videoId=" + encodeURIComponent(el("video").value) + "&mode=" + encodeURIComponent(el("mode").value);
    if (el("chapter").value !== "all") q += "&chapter=" + encodeURIComponent(el("chapter").value);
    return q;
  }

  function loadGraph(repopulateChapters) {
    statusEl.textContent = "Loading graph…";
    inspectorEl.style.display = "none";
    fetch("/api/graph/overview" + params()).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { statusEl.textContent = "Error: " + (d.error || "failed"); return; }
      if (repopulateChapters && d.chapters) {
        el("chapter").innerHTML = '<option value="all">All chapters</option>' + d.chapters.map(function (c) {
          return '<option value="' + c.index + '">' + escapeText((c.title || ("Chapter " + c.index)).slice(0, 40)) + "</option>";
        }).join("");
      }
      Graph.graphData({ nodes: d.nodes, links: d.links });
      sizeGraph();
      statusEl.textContent = d.metadata.nodeCount + " nodes · " + d.metadata.relationshipCount + " links" +
        (d.metadata.truncated ? " · ⚠ truncated (pick a chapter to see all)" : "") + " — " + (d.title || d.videoId);
    }).catch(function (e) { statusEl.textContent = "Error: " + e.message; });
  }

  fetch("/api/graph/schema").then(function (r) { return r.json(); }).then(function (d) {
    var sel = el("video");
    if (!d.ok || !d.neo4jAvailable) { statusEl.textContent = "Neo4j not available."; return; }
    if (!d.videos.length) { statusEl.textContent = "No graphed videos yet — build a document mindmap first."; return; }
    sel.innerHTML = d.videos.map(function (v) {
      return '<option value="' + escapeText(v.id) + '">' + escapeText((v.title || v.id).slice(0, 60)) + " (" + v.chapters + " ch)</option>";
    }).join("");
    loadGraph(true);
  }).catch(function (e) { statusEl.textContent = "Error: " + e.message; });

  el("video").addEventListener("change", function () { el("chapter").value = "all"; loadGraph(true); });
  el("mode").addEventListener("change", function () { loadGraph(false); });
  el("chapter").addEventListener("change", function () { loadGraph(false); });
  el("reload").addEventListener("click", function () { loadGraph(false); });
  el("reset").addEventListener("click", function () { Graph.zoomToFit(600, 40); });
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const route = url.pathname;

    if (req.method === "GET" && route === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(renderIndexPage());
    }
    if (req.method === "GET" && route === "/graph/3d") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(renderGraph3dPage());
    }
    if (req.method === "GET" && route === "/api/graph/schema") return void handleGraphSchema(res);
    if (req.method === "GET" && route === "/api/graph/overview") return void handleGraphOverview(req, res, url);
    if (req.method === "POST" && !requirePostToken(req, res)) return;
    if (req.method === "GET" && route === "/api/videos") return void handleVideos(res);
    if (req.method === "GET" && route === "/api/channels") return void handleChannels(res);
    if (req.method === "POST" && route === "/api/add") return void handleAdd(req, res);
    if (req.method === "POST" && route === "/api/channel") return void handleAddChannel(req, res);
    if (req.method === "POST" && route === "/api/document") return void handleDocument(req, res);
    if (req.method === "POST" && route === "/api/mindmap") return void handleMindmap(req, res);
    if (req.method === "POST" && route === "/api/concepts") return void handleConcepts(req, res);
    if (req.method === "POST" && route === "/api/remove") return void handleRemove(req, res);

    const channelApi = route.match(/^\/api\/channel\/([^/]+)$/);
    if (req.method === "GET" && channelApi) return void handleChannel(res, decodeURIComponent(channelApi[1]));
    const channelPage = route.match(/^\/channel\/([^/]+)$/);
    if (req.method === "GET" && channelPage) {
      const cid = decodeURIComponent(channelPage[1]);
      if (!CHANNEL_ID.test(cid)) return sendJson(res, 404, { ok: false, error: "Channel not found." });
      const channel = readChannel(cid) || await readNeo4jChannel(cid);
      if (!channel) return sendJson(res, 404, { ok: false, error: "Channel not found." });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(renderChannelPage(cid));
    }
    if (req.method === "GET" && route === "/health") return sendJson(res, 200, { ok: true, busy });

    const report = route.match(/^\/report\/([^/]+)$/);
    if (req.method === "GET" && report) return serveVideoPage(res, decodeURIComponent(report[1]), "report");
    const transcript = route.match(/^\/transcript\/([^/]+)$/);
    if (req.method === "GET" && transcript) return serveVideoPage(res, decodeURIComponent(transcript[1]), "transcript");
    const document = route.match(/^\/document\/([^/]+)$/);
    if (req.method === "GET" && document) return serveVideoPage(res, decodeURIComponent(document[1]), "document");
    const mindmap = route.match(/^\/mindmap\/([^/]+)$/);
    if (req.method === "GET" && mindmap) return serveVideoPage(res, decodeURIComponent(mindmap[1]), "mindmap");
    const raw = route.match(/^\/data\/([^/]+)$/);
    if (req.method === "GET" && raw) return serveFile(res, decodeURIComponent(raw[1]), ".comments.json");

    sendJson(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

function renderChannelPage(channelId) {
  const cid = JSON.stringify(channelId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Channel — YouTube Comments Analyzer</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1120; color: #e2e8f0; }
  main { max-width: 1000px; margin: 0 auto; padding: 26px 20px 70px; }
  .chead { display: flex; align-items: flex-start; gap: 16px; justify-content: space-between; flex-wrap: wrap; margin-bottom: 8px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .sub { color: #94a3b8; margin: 0 0 20px; font-size: 0.9rem; }
  .sub a { color: #99f6e4; text-decoration: none; }
  button { min-height: 34px; padding: 0 13px; border: 1px solid rgba(45,212,191,0.42); border-radius: 8px; background: rgba(15,118,110,0.2); color: #99f6e4; font: inherit; font-weight: 800; cursor: pointer; }
  button.ghost { border-color: rgba(148,163,184,0.4); background: transparent; color: #cbd5e1; font-weight: 700; min-height: 30px; padding: 0 10px; font-size: 0.78rem; }
  button:disabled { opacity: 0.5; cursor: progress; }
  .status { margin: 6px 0 18px; min-height: 20px; font-size: 0.85rem; color: #94a3b8; }
  .status.ok { color: #86efac; } .status.err { color: #fca5a5; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid rgba(148,163,184,0.14); font-size: 0.86rem; vertical-align: middle; }
  th { color: #94a3b8; font-weight: 600; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; color: #94a3b8; }
  a.page { color: #99f6e4; text-decoration: none; font-weight: 700; }
  a.page:hover { text-decoration: underline; }
  .muted { color: #64748b; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; border: 1px solid rgba(134,239,172,0.4); color: #86efac; }
  .graphwrap { margin: 8px 0 26px; border: 1px solid rgba(148,163,184,0.22); border-radius: 10px; background: rgba(2,6,23,0.45); overflow: hidden; }
  .graphwrap h2 { margin: 0; padding: 12px 16px; font-size: 0.95rem; border-bottom: 1px solid rgba(148,163,184,0.16); }
  .graphwrap svg { display: block; width: 100%; height: 520px; background: radial-gradient(circle at 50% 42%, rgba(30,41,59,0.5), rgba(2,6,23,0.15)); }
  .glegend { display: flex; flex-wrap: wrap; gap: 12px; padding: 10px 16px; font-size: 0.76rem; color: #cbd5e1; border-top: 1px solid rgba(148,163,184,0.16); }
  .glegend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 5px; vertical-align: middle; }
  .cyphers { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; padding: 14px 16px; }
  .cyc { border: 1px solid rgba(148,163,184,0.2); border-radius: 8px; padding: 12px; background: rgba(255,255,255,0.05); }
  .cyc h3 { margin: 0 0 8px; font-size: 0.85rem; }
  .cyc pre { margin: 0; overflow: auto; color: #d1fae5; font-size: 0.74rem; line-height: 1.45; white-space: pre-wrap; }
  .cyc button { margin-top: 9px; min-height: 30px; padding: 0 10px; font-size: 0.78rem; }
</style>
</head>
<body>
${channelNavBar(channelId)}
<main>
  <div class="chead">
    <div>
      <h1 id="cname">Channel</h1>
      <p class="sub" id="csub"></p>
    </div>
    <button id="processAll" type="button">Process all unprocessed</button>
  </div>
  <div id="status" class="status">Loading…</div>

  <section class="graphwrap">
    <h2>Channel graph <span class="muted" style="font-weight:400;font-size:0.8rem;">— Channel → Videos in Neo4j</span></h2>
    <svg id="chgraph" viewBox="0 0 820 520" preserveAspectRatio="xMidYMid meet"></svg>
    <div class="glegend">
      <span><i style="background:#f5a623"></i>Channel</span>
      <span><i style="background:#57c7a3"></i>Video with comments</span>
      <span><i style="background:#4c8eda"></i>Transcript/Document</span>
      <span><i style="background:#64748b"></i>Not processed</span>
      <span id="gnote" class="muted"></span>
    </div>
    <div class="cyphers">
      <div class="cyc"><h3>Channel → videos</h3><pre>MATCH (ch:YouTubeChannel {id: '${channelId}'})-[:PUBLISHED]->(v)
RETURN ch, v LIMIT 100;</pre><button class="ghost copy" type="button">Copy Cypher</button></div>
      <div class="cyc"><h3>Videos with comments</h3><pre>MATCH (ch:YouTubeChannel {id: '${channelId}'})-[:PUBLISHED]->(v)-[:HAS_COMMENT]->(c)
RETURN ch, v, c LIMIT 300;</pre><button class="ghost copy" type="button">Copy Cypher</button></div>
      <div class="cyc"><h3>Full chain (channel→video→comment→author)</h3><pre>MATCH (ch:YouTubeChannel {id: '${channelId}'})-[:PUBLISHED]->(v)-[:HAS_COMMENT]->(c)&lt;-[:WROTE]-(a)
RETURN ch, v, c, a LIMIT 200;</pre><button class="ghost copy" type="button">Copy Cypher</button></div>
    </div>
  </section>

  <table>
    <thead><tr><th>#</th><th>Title</th><th class="num">Length</th><th>Pages</th><th>Action</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</main>
<script>
  var POST_TOKEN = ${JSON.stringify(POST_TOKEN)};
  var CHANNEL_ID = ${cid};
  var rows = document.querySelector("#rows");
  var statusEl = document.querySelector("#status");
  var processAllBtn = document.querySelector("#processAll");
  var videos = [];

  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
  function fmt(sec){ if(sec==null) return ""; sec=Math.floor(sec); var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60; function p(n){return (n<10?"0":"")+n;} return h>0? h+":"+p(m)+":"+p(s) : m+":"+p(s); }

  function pagesCell(v){
    var id=encodeURIComponent(v.id), links=[];
    if(v.hasReport) links.push('<a class="page" href="/report/'+id+'" target="_blank">Comments</a>');
    if(v.hasTranscript) links.push('<a class="page" href="/transcript/'+id+'" target="_blank">Transcript</a>');
    if(v.hasDocument) links.push('<a class="page" href="/document/'+id+'" target="_blank">Document</a>');
    return links.length? links.join(' <span class="muted">·</span> ') : '<span class="muted">—</span>';
  }
  function actionCell(v){
    if(!v.hasComments) return '<button class="ghost add" data-id="'+esc(v.id)+'">Add</button>';
    if(!v.hasDocument) return '<button class="ghost builddoc" data-id="'+esc(v.id)+'">Build doc</button>';
    return '<span class="pill">done</span>';
  }
  function render(){
    rows.innerHTML = videos.map(function(v,i){
      return "<tr data-id='"+esc(v.id)+"'>"+
        '<td class="num">'+(i+1)+"</td>"+
        '<td><a class="page" href="https://www.youtube.com/watch?v='+encodeURIComponent(v.id)+'" target="_blank">'+esc(v.title)+"</a></td>"+
        '<td class="num">'+fmt(v.duration)+"</td>"+
        "<td>"+pagesCell(v)+"</td>"+
        "<td>"+actionCell(v)+"</td>"+
      "</tr>";
    }).join("");
  }

  // A self-contained radial preview: the channel at the center, its videos fanned out
  // (sunflower layout), coloured by how far each has been processed. Mirrors the Neo4j
  // (:YouTubeChannel)-[:PUBLISHED]->(:YouTubeVideo) structure.
  function renderChannelGraph(channelName, vids){
    var SVG="http://www.w3.org/2000/svg";
    var svg=document.querySelector("#chgraph");
    while(svg.firstChild) svg.removeChild(svg.firstChild);
    var W=820,H=520,cx=W/2,cy=H/2;
    var processed=vids.filter(function(v){return v.hasComments||v.hasTranscript||v.hasDocument;});
    var rest=vids.filter(function(v){return !(v.hasComments||v.hasTranscript||v.hasDocument);});
    var cap=140, shown=processed.slice();
    var need=cap-shown.length;
    if(need>0 && rest.length){ var step=Math.max(1,Math.floor(rest.length/need)); for(var i=0;i<rest.length && shown.length<cap;i+=step) shown.push(rest[i]); }
    var edgeG=document.createElementNS(SVG,"g"), nodeG=document.createElementNS(SVG,"g");
    svg.appendChild(edgeG); svg.appendChild(nodeG);
    var c=230/Math.sqrt(shown.length||1);
    shown.forEach(function(v,i){
      var theta=i*2.399963, rad=c*Math.sqrt(i+0.5);
      var x=cx+rad*Math.cos(theta), y=cy+rad*Math.sin(theta);
      var line=document.createElementNS(SVG,"line");
      line.setAttribute("x1",cx); line.setAttribute("y1",cy); line.setAttribute("x2",x); line.setAttribute("y2",y);
      line.setAttribute("stroke","rgba(148,163,184,0.16)"); line.setAttribute("stroke-width","1");
      edgeG.appendChild(line);
      var color=v.hasComments?"#57c7a3":((v.hasTranscript||v.hasDocument)?"#4c8eda":"#64748b");
      var r=v.hasComments?7:((v.hasTranscript||v.hasDocument)?6:4);
      var a=document.createElementNS(SVG,"a");
      a.setAttribute("href","https://www.youtube.com/watch?v="+v.id);
      a.setAttribute("target","_blank");
      var circle=document.createElementNS(SVG,"circle");
      circle.setAttribute("cx",x); circle.setAttribute("cy",y); circle.setAttribute("r",r);
      circle.setAttribute("fill",color); circle.setAttribute("stroke","rgba(15,23,42,0.85)"); circle.setAttribute("stroke-width","1");
      circle.style.cursor="pointer";
      var t=document.createElementNS(SVG,"title"); t.textContent=v.title;
      a.appendChild(circle); a.appendChild(t); nodeG.appendChild(a);
    });
    var chc=document.createElementNS(SVG,"circle");
    chc.setAttribute("cx",cx); chc.setAttribute("cy",cy); chc.setAttribute("r",22);
    chc.setAttribute("fill","#f5a623"); chc.setAttribute("stroke","rgba(15,23,42,0.85)"); chc.setAttribute("stroke-width","2");
    nodeG.appendChild(chc);
    var lbl=document.createElementNS(SVG,"text");
    lbl.setAttribute("x",cx); lbl.setAttribute("y",cy+40); lbl.setAttribute("text-anchor","middle");
    lbl.setAttribute("fill","#e2e8f0"); lbl.setAttribute("font-size","12"); lbl.setAttribute("font-weight","800");
    lbl.setAttribute("paint-order","stroke"); lbl.setAttribute("stroke","rgba(2,6,23,0.8)"); lbl.setAttribute("stroke-width","3");
    lbl.textContent=channelName||"Channel";
    nodeG.appendChild(lbl);
    var note=document.querySelector("#gnote");
    if(note) note.textContent = shown.length<vids.length ? ("showing "+shown.length+" of "+vids.length+" videos") : (vids.length+" videos");
  }

  document.addEventListener("click", function(e){
    var b=e.target.closest(".copy"); if(!b) return;
    var pre=b.parentNode.querySelector("pre"); if(!pre) return;
    navigator.clipboard.writeText(pre.textContent).then(function(){ var o=b.textContent; b.textContent="Copied"; setTimeout(function(){b.textContent=o;},1300); }).catch(function(){});
  });

  async function loadChannel(){
    try {
      var res = await fetch("/api/channel/"+encodeURIComponent(CHANNEL_ID));
      var data = await res.json();
      if(!data.ok){ statusEl.className="status err"; statusEl.textContent="Failed to load channel."; return; }
      document.querySelector("#cname").textContent = data.channel.name || CHANNEL_ID;
      var processed = data.videos.filter(function(v){return v.hasComments;}).length;
      document.querySelector("#csub").innerHTML = esc(data.channel.handle||"") + ' &middot; ' + data.videos.length +
        ' videos &middot; ' + processed + ' processed &middot; <a href="'+esc(data.channel.url||"#")+'" target="_blank">Open on YouTube</a>';
      videos = data.videos;
      statusEl.className="status"; statusEl.textContent = "";
      render();
      renderChannelGraph(data.channel.name, videos);
    } catch(err){ statusEl.className="status err"; statusEl.textContent="Failed to load channel: "+err.message; }
  }

  async function consumeStream(res, onEvent){
    var reader=res.body.getReader(), dec=new TextDecoder(), buf="", finalEvent=null;
    while(true){
      var r=await reader.read(); if(r.done) break;
      buf+=dec.decode(r.value,{stream:true});
      var idx;
      while((idx=buf.indexOf("\\n\\n"))>=0){
        var chunk=buf.slice(0,idx); buf=buf.slice(idx+2);
        var line=chunk.split("\\n").find(function(l){return l.indexOf("data:")===0;});
        if(!line) continue;
        var evt; try{ evt=JSON.parse(line.slice(5).trim()); }catch(e){ continue; }
        if(onEvent) onEvent(evt);
        if(evt.stage==="complete"||evt.stage==="error") finalEvent=evt;
      }
    }
    return finalEvent;
  }
  async function postStream(endpoint, payload, label){
    var res=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json","x-yca-token":POST_TOKEN},body:JSON.stringify(payload)});
    var ct=res.headers.get("content-type")||"";
    if(ct.indexOf("text/event-stream")<0){ var d=await res.json().catch(function(){return {error:"HTTP "+res.status};}); throw new Error(d.error||"unknown"); }
    return consumeStream(res, function(evt){
      if(evt.stage && evt.status==="running") { statusEl.className="status"; statusEl.textContent = label + " — " + (evt.message||evt.stage); }
    });
  }

  async function addVideo(videoId){
    var url="https://www.youtube.com/watch?v="+videoId;
    var fe=await postStream("/api/add",{url:url,buildDoc:false}, "Adding "+videoId);
    if(fe && fe.stage==="complete") return true;
    throw new Error((fe&&fe.error)||"add failed");
  }
  async function buildDocFor(videoId){
    var fe=await postStream("/api/document",{videoId:videoId}, "Building document for "+videoId);
    if(fe && fe.stage==="complete") return true;
    throw new Error((fe&&fe.error)||"build failed");
  }

  rows.addEventListener("click", async function(event){
    var add=event.target.closest(".add"), bd=event.target.closest(".builddoc");
    if(add){ add.disabled=true; try{ await addVideo(add.getAttribute("data-id")); statusEl.className="status ok"; statusEl.textContent="Added."; await loadChannel(); }catch(e){ statusEl.className="status err"; statusEl.textContent="Failed: "+e.message; add.disabled=false; } return; }
    if(bd){ bd.disabled=true; try{ await buildDocFor(bd.getAttribute("data-id")); statusEl.className="status ok"; statusEl.textContent="Document built."; await loadChannel(); }catch(e){ statusEl.className="status err"; statusEl.textContent="Failed: "+e.message; bd.disabled=false; } return; }
  });

  processAllBtn.addEventListener("click", async function(){
    var todo=videos.filter(function(v){return !v.hasComments;});
    if(!todo.length){ statusEl.className="status ok"; statusEl.textContent="All videos already processed."; return; }
    if(!window.confirm("Process "+todo.length+" unprocessed video(s)? This runs the full pipeline for each, one at a time, and can take a while.")) return;
    processAllBtn.disabled=true;
    var done=0, failed=0;
    for(var i=0;i<todo.length;i++){
      statusEl.className="status"; statusEl.textContent="Processing "+(i+1)+"/"+todo.length+": "+todo[i].title;
      try{ await addVideo(todo[i].id); done++; }catch(e){ failed++; }
    }
    statusEl.className = failed? "status err":"status ok";
    statusEl.textContent = "Processed "+done+"/"+todo.length+(failed?(" ("+failed+" failed)"):"")+".";
    processAllBtn.disabled=false;
    await loadChannel();
  });

  loadChannel();
</script>
</body>
</html>`;
}

export function renderIndexPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>YouTube Comments Analyzer</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1120; color: #e2e8f0; }
  main { max-width: 940px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .sub { color: #94a3b8; margin: 0 0 26px; font-size: 0.9rem; }
  section { border: 1px solid rgba(148,163,184,0.2); border-radius: 10px; background: #0f172a; padding: 18px; margin-bottom: 22px; }
  h2 { font-size: 1rem; margin: 0 0 14px; }
  form { display: flex; gap: 10px; flex-wrap: wrap; }
  input[type=url] { flex: 1; min-width: 240px; min-height: 42px; padding: 0 12px; border: 1px solid rgba(148,163,184,0.32); border-radius: 8px; background: #0b1120; color: #e2e8f0; font: inherit; }
  button { min-height: 42px; padding: 0 16px; border: 1px solid rgba(45,212,191,0.42); border-radius: 8px; background: rgba(15,118,110,0.2); color: #99f6e4; font: inherit; font-weight: 800; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: progress; }
  .status { margin-top: 12px; font-size: 0.85rem; min-height: 20px; }
  .status.err { color: #fca5a5; }
  .status.ok { color: #86efac; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid rgba(148,163,184,0.14); font-size: 0.88rem; vertical-align: middle; }
  th { color: #94a3b8; font-weight: 600; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  a.report { color: #99f6e4; text-decoration: none; font-weight: 700; }
  a.report:hover { text-decoration: underline; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; border: 1px solid transparent; }
  .pill.in { color: #86efac; border-color: rgba(134,239,172,0.4); background: rgba(134,239,172,0.08); }
  .pill.out { color: #94a3b8; border-color: rgba(148,163,184,0.3); }
  .muted { color: #64748b; }
  .empty { color: #94a3b8; padding: 10px 8px; }
  .site-foot { margin-top: 28px; padding-top: 18px; border-top: 1px solid rgba(148,163,184,0.16); color: #64748b; font-size: 0.82rem; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .site-foot .dot { color: #475569; }
  button.remove { min-height: 30px; padding: 0 10px; border: 1px solid rgba(248,113,113,0.4); border-radius: 7px; background: transparent; color: #fca5a5; font-size: 0.78rem; font-weight: 700; }
  button.remove:hover { background: rgba(248,113,113,0.12); }
  .linkbtn { min-height: auto; padding: 2px 8px; margin-left: 8px; border: 1px solid rgba(153,246,228,0.4); border-radius: 6px; background: transparent; color: #99f6e4; font-size: 0.82rem; font-weight: 800; text-decoration: none; }
  button.builddoc, button.buildmm, button.buildconcepts { min-height: 30px; padding: 0 10px; margin-right: 6px; border: 1px solid rgba(148,163,184,0.4); border-radius: 7px; background: transparent; color: #cbd5e1; font-size: 0.78rem; font-weight: 700; }
  button.builddoc:hover, button.buildmm:hover, button.buildconcepts:hover { border-color: #99f6e4; color: #99f6e4; }
  .opt { display: inline-flex; align-items: center; gap: 7px; color: #94a3b8; font-size: 0.82rem; width: 100%; margin-top: 2px; }
  .opt input { width: 15px; height: 15px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 14px; }
  .tab { min-height: 32px; padding: 0 14px; border: 1px solid rgba(148,163,184,0.28); border-radius: 8px; background: transparent; color: #94a3b8; font: inherit; font-weight: 700; font-size: 0.85rem; cursor: pointer; }
  .tab.active { border-color: rgba(45,212,191,0.5); background: rgba(15,118,110,0.18); color: #99f6e4; }
  .channels { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
  .chan { display: block; padding: 14px; border: 1px solid rgba(148,163,184,0.24); border-radius: 12px; background: #0f172a; text-decoration: none; color: #e2e8f0; transition: border-color 120ms ease, transform 120ms ease; }
  .chan:hover { border-color: rgba(45,212,191,0.5); transform: translateY(-2px); }
  .chan-head { display: flex; align-items: center; gap: 11px; margin-bottom: 13px; }
  .chan-head .avatar { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; flex: none; background: #1e293b; }
  .chan .cn { font-weight: 800; font-size: 0.95rem; line-height: 1.2; }
  .chan .cc { color: #64748b; font-size: 0.78rem; margin-top: 2px; }
  .chan-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .chan-stats > div { border: 1px solid rgba(148,163,184,0.16); border-radius: 8px; padding: 8px 9px; background: rgba(255,255,255,0.03); }
  .chan-stats strong { display: block; font-size: 1.05rem; color: #fff; font-variant-numeric: tabular-nums; }
  .chan-stats span { display: block; margin-top: 2px; color: #94a3b8; font-size: 0.72rem; }
  .chan-stats .hl strong { color: #5eead4; }
  tr.group td { background: rgba(148,163,184,0.06); border-top: 1px solid rgba(148,163,184,0.2); }
  tr.group .gh { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
  tr.group a { color: #99f6e4; text-decoration: none; font-weight: 800; }
  tr.group .gc { color: #64748b; font-size: 0.78rem; font-weight: 600; }
  .steps { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 9px; }
  .steps li { display: flex; align-items: center; gap: 10px; font-size: 0.85rem; color: #64748b; }
  .steps .ico { width: 18px; height: 18px; border-radius: 50%; border: 1.6px solid rgba(148,163,184,0.4); display: inline-flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 800; flex: none; box-sizing: border-box; }
  .steps .msg { color: #64748b; font-size: 0.78rem; }
  .steps li.running { color: #e2e8f0; }
  .steps li.running .ico { border-color: #99f6e4; border-top-color: transparent; animation: spin 0.7s linear infinite; }
  .steps li.done { color: #cbd5e1; }
  .steps li.done .ico { border-color: rgba(134,239,172,0.7); color: #86efac; }
  .steps li.error { color: #fca5a5; }
  .steps li.error .ico { border-color: rgba(248,113,113,0.7); color: #fca5a5; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
${renderTopNav({ title: "YouTube Comments Analyzer", current: "dashboard", links: [{ key: "graph3d", label: "3D Graph", href: "/graph/3d" }] })}
<main>
  <h1>YouTube Comments Analyzer</h1>
  <p class="sub">Local dashboard &middot; loopback only. Add a video to extract, classify, build its report, and load it into Neo4j.</p>

  <section>
    <h2>Add a video</h2>
    <form id="addForm">
      <input id="url" type="url" placeholder="https://www.youtube.com/watch?v=..." autocomplete="off" required />
      <button id="addBtn" type="submit">Add</button>
      <label class="opt" id="docOpt"><input type="checkbox" id="buildDoc" /> Also build the illustrated document (slower — captures a frame per chapter)</label>
    </form>
    <div id="status" class="status muted">Paste a YouTube URL. Extraction can take up to a minute for large threads.</div>
    <ol id="steps" class="steps" hidden></ol>
  </section>

  <section id="channelsSection">
    <h2>Channels (<span id="channelCount">0</span>)</h2>
    <form id="channelForm" class="chanform">
      <input id="channelUrl" type="url" placeholder="https://www.youtube.com/@PaulJLipsky/videos" autocomplete="off" required />
      <button id="channelBtn" type="submit">Add channel</button>
    </form>
    <div id="channels" class="channels"></div>
  </section>

  <section>
    <h2>Videos (<span id="count">0</span>)</h2>
    <table>
      <thead>
        <tr><th>Title</th><th>Video</th><th class="num">Comments</th><th>Profile</th><th>Neo4j</th><th>Pages</th><th></th></tr>
      </thead>
      <tbody id="rows"><tr><td class="empty" colspan="7">Loading…</td></tr></tbody>
    </table>
  </section>
  <footer class="site-foot">
    <span>YouTube Comments Analyzer</span>
    <span class="dot">·</span>
    <span>Each video links to its Report, Transcript, and illustrated Document — and back here.</span>
  </footer>
</main>

<script>
  const POST_TOKEN = ${JSON.stringify(POST_TOKEN)};
  const rows = document.querySelector("#rows");
  const count = document.querySelector("#count");
  const statusEl = document.querySelector("#status");
  const form = document.querySelector("#addForm");
  const urlInput = document.querySelector("#url");
  const addBtn = document.querySelector("#addBtn");
  const channelsEl = document.querySelector("#channels");
  const channelCount = document.querySelector("#channelCount");
  const channelForm = document.querySelector("#channelForm");
  const channelUrlInput = document.querySelector("#channelUrl");
  const channelBtn = document.querySelector("#channelBtn");

  channelForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = channelUrlInput.value.trim();
    if (!url) return;
    channelUrlInput.value = "";
    await submitChannel(url, channelBtn);
  });

  function compact(n) {
    if (n == null) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
    return String(n);
  }

  async function loadChannels() {
    try {
      const res = await fetch("/api/channels");
      const data = await res.json();
      const channels = data.channels || [];
      channelCount.textContent = channels.length;
      if (!channels.length) {
        channelsEl.innerHTML = '<span class="muted">No channels yet — add one above.</span>';
        return;
      }
      channelsEl.innerHTML = channels.map((c) => {
        const id = encodeURIComponent(c.channelId);
        const avatar = c.avatar
          ? '<img class="avatar" src="' + esc(c.avatar) + '" alt="" referrerpolicy="no-referrer" onerror="this.style.display=\\'none\\'" />'
          : '<span class="avatar"></span>';
        const stat = (value, label, hl) => '<div' + (hl ? ' class="hl"' : '') + '><strong>' + value + '</strong><span>' + label + '</span></div>';
        return '<a class="chan" href="/channel/' + id + '">' +
          '<div class="chan-head">' + avatar +
            '<div><div class="cn">' + esc(c.name || c.channelId) + '</div><div class="cc">' + esc(c.handle || "") + '</div></div>' +
          '</div>' +
          '<div class="chan-stats">' +
            stat(compact(c.subscribers), "subscribers") +
            stat(compact(c.videoCount), "videos") +
            stat(compact(c.totalViews), "total views") +
            stat(c.analyzedCount + "/" + c.videoCount, "analyzed", true) +
          '</div></a>';
      }).join("");
    } catch (err) { /* ignore */ }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function loadVideos() {
    try {
      const res = await fetch("/api/videos");
      const data = await res.json();
      const videos = data.videos || [];
      count.textContent = videos.length;
      if (!videos.length) {
        rows.innerHTML = '<tr><td class="empty" colspan="7">No videos yet. Add one above.</td></tr>';
        return;
      }
      const dash = '<span class="muted">—</span>';
      function rowHtml(v) {
        let neo = dash;
        if (data.neo4jAvailable && v.inNeo4j != null) {
          neo = v.inNeo4j
            ? '<span class="pill in">in graph</span>'
            : '<span class="pill out">not imported</span>';
        }
        const isGraphOnly = v.source === "graph";
        const id = encodeURIComponent(v.videoId);
        const links = [];
        if (v.hasReport) links.push('<a class="report" href="/report/' + id + '" target="_blank" rel="noreferrer">Comments</a>');
        if (v.hasTranscript) links.push('<a class="report" href="/transcript/' + id + '" target="_blank" rel="noreferrer">Transcript</a>');
        if (v.hasDocument) links.push('<a class="report" href="/document/' + id + '" target="_blank" rel="noreferrer">Document</a>');
        if (v.hasMindmap) links.push('<a class="report" href="/mindmap/' + id + '" target="_blank" rel="noreferrer">Mind map</a>');
        const pages = links.length ? links.join(' <span class="muted">·</span> ') : (isGraphOnly ? '<span class="muted">graph only</span>' : dash);
        const actions = [
          v.hasDocument ? "" : '<button type="button" class="builddoc" data-id="' + esc(v.videoId) + '">Build doc</button>',
          v.hasComments && !v.hasMindmap ? '<button type="button" class="buildmm" data-id="' + esc(v.videoId) + '">Mind map</button>' : "",
          v.hasTranscript && data.neo4jAvailable ? '<button type="button" class="buildconcepts" data-id="' + esc(v.videoId) + '">Concepts</button>' : "",
          isGraphOnly ? "" : '<button type="button" class="remove" data-id="' + esc(v.videoId) + '">Remove</button>',
        ].join("");
        return "<tr>" +
          "<td>" + esc(v.title) + "</td>" +
          '<td><a class="report" href="' + esc(v.url) + '" target="_blank" rel="noreferrer">' + esc(v.videoId) + "</a></td>" +
          '<td class="num">' + (v.comments == null ? dash : Number(v.comments).toLocaleString()) + "</td>" +
          "<td>" + (v.profile ? esc(v.profile) : dash) + "</td>" +
          "<td>" + neo + "</td>" +
          "<td>" + pages + "</td>" +
          "<td>" + (actions || dash) + "</td>" +
        "</tr>";
      }

      // Group rows under a channel header.
      const groups = new Map();
      for (const v of videos) {
        const key = v.channelId || v.channel || "__unknown";
        if (!groups.has(key)) groups.set(key, { channel: v.channel, channelId: v.channelId, handle: v.handle, items: [] });
        groups.get(key).items.push(v);
      }
      let html = "";
      for (const g of groups.values()) {
        const label = g.channelId
          ? '<a href="/channel/' + encodeURIComponent(g.channelId) + '">' + esc(g.channel || g.channelId) + "</a>"
          : esc(g.channel || "Unknown channel");
        const meta = (g.handle ? esc(g.handle) + " · " : "") + g.items.length + " video" + (g.items.length === 1 ? "" : "s");
        html += '<tr class="group"><td colspan="7"><div class="gh">' + label + '<span class="gc">' + meta + "</span></div></td></tr>";
        html += g.items.map(rowHtml).join("");
      }
      rows.innerHTML = html;
    } catch (err) {
      rows.innerHTML = '<tr><td class="empty" colspan="7">Failed to load videos.</td></tr>';
    }
  }

  async function removeVideo(videoId, options) {
    const opts = options || {};
    const needConfirm = opts.confirm !== false;
    if (needConfirm && !window.confirm(
      "Remove “" + videoId + "”?\\n\\nIts report files move to output/.trash (recoverable) and its Neo4j nodes are deleted. You can re-add it later.")) {
      return;
    }
    statusEl.className = "status muted";
    statusEl.textContent = "Removing " + videoId + "…";
    try {
      const res = await fetch("/api/remove", {
        method: "POST",
        headers: { "content-type": "application/json", "x-yca-token": POST_TOKEN },
        body: JSON.stringify({ videoId }),
      });
      const data = await res.json();
      if (!data.ok) {
        statusEl.className = "status err";
        statusEl.textContent = "Remove failed: " + (data.error || "unknown error");
        return;
      }
      let msg = "Removed " + videoId + ".";
      if (data.neo4j && data.neo4j.ok === false && !data.neo4j.skipped) {
        msg += " (Neo4j cleanup failed: " + data.neo4j.error + ")";
      }
      statusEl.className = "status ok";
      statusEl.textContent = msg + " Files are in " + (data.trashDir || "output/.trash") + ".";
      await loadVideos();
    } catch (err) {
      statusEl.className = "status err";
      statusEl.textContent = "Request failed: " + err.message;
    }
  }

  rows.addEventListener("click", (event) => {
    const rm = event.target.closest(".remove");
    if (rm) { removeVideo(rm.getAttribute("data-id")); return; }
    const bd = event.target.closest(".builddoc");
    if (bd) { buildDocumentFor(bd.getAttribute("data-id")); return; }
    const mm = event.target.closest(".buildmm");
    if (mm) { buildMindmapFor(mm.getAttribute("data-id")); return; }
    const cc = event.target.closest(".buildconcepts");
    if (cc) { buildConceptsFor(cc.getAttribute("data-id")); return; }
  });

  // --- Progress stepper -----------------------------------------------------
  const stepsEl = document.querySelector("#steps");
  const docCheckbox = document.querySelector("#buildDoc");
  let currentSteps = [];
  const STAGE_TO_STEP = {
    "transcript-fetch": "transcript", "transcript-parse": "transcript", "transcript-render": "transcript",
    validate: "validate", "yt-dlp": "download", normalize: "classify",
    classify: "classify", render: "report", extracted: "report", neo4j: "import",
    "document-fetch": "document", "document-extract": "document", "document-frames": "document", "document-render": "document",
    "mindmap-collect": "mindmap", "mindmap-analyze": "mindmap", "mindmap-render": "mindmap",
    "document-graph-load": "mindmap", "document-graph-context": "mindmap", "document-graph-build": "mindmap",
    "channel-fetch": "channel", "channel-parse": "channel",
    "channel-graph-schema": "graph", "channel-graph-node": "graph", "channel-graph-videos": "graph",
  };
  const ICONS = { done: "✓", error: "✕", skipped: "–" };

  function addSteps(includeDoc) {
    const steps = [
      ["transcript", "Fetch transcript"],
      ["validate", "Validate URL"],
      ["download", "Download comments (yt-dlp)"],
      ["classify", "Classify comments"],
      ["report", "Build report"],
      ["import", "Import to Neo4j"],
      ["mindmap", "Build mindmap (Neo4j)"],
    ];
    if (includeDoc) steps.push(["document", "Build document (images)"]);
    return steps;
  }
  function renderSteps(steps) {
    currentSteps = steps;
    stepsEl.hidden = false;
    stepsEl.innerHTML = steps.map(([key, label]) =>
      '<li data-step="' + key + '" class="pending"><span class="ico"></span>' +
      '<span class="label">' + esc(label) + '</span><span class="msg"></span></li>').join("");
  }
  function stepEl(key) { return stepsEl.querySelector('[data-step="' + key + '"]'); }
  function setStep(key, state, message) {
    const li = stepEl(key);
    if (!li) return;
    li.className = state;
    li.querySelector(".ico").textContent = ICONS[state] || "";
    if (message !== undefined) li.querySelector(".msg").textContent = message ? "· " + message : "";
  }
  function advanceTo(key, message) {
    let reached = false;
    for (const [k] of currentSteps) {
      if (k === key) { setStep(k, "running", message); reached = true; }
      else if (!reached) { const li = stepEl(k); if (li && li.className !== "error") setStep(k, "done"); }
    }
  }
  function wrapperStep(step, evt) {
    if (evt.status === "running") advanceTo(step, evt.message);
    else if (evt.status === "skipped") setStep(step, "skipped", evt.message);
    else setStep(step, evt.status === "error" ? "error" : "done", evt.message);
  }
  function handleEvent(evt) {
    if (evt.stage === "start") return;
    if (evt.stage === "complete") {
      for (const [k] of currentSteps) {
        const li = stepEl(k);
        if (li && li.className !== "error" && li.className !== "skipped") setStep(k, "done");
      }
      return;
    }
    if (evt.stage === "error") {
      const running = stepsEl.querySelector("li.running");
      if (running) setStep(running.getAttribute("data-step"), "error", evt.error);
      return;
    }
    if (evt.stage === "transcript") { wrapperStep("transcript", evt); return; }
    if (evt.stage === "extracted") { setStep("report", "done", evt.message); return; }
    if (evt.stage === "neo4j") { wrapperStep("import", evt); return; }
    if (evt.stage === "document") { wrapperStep("document", evt); return; }
    if (evt.stage === "mindmap") { wrapperStep("mindmap", evt); return; }
    if (evt.stage === "channel") { wrapperStep("channel", evt); return; }
    if (evt.stage === "graph") { wrapperStep("graph", evt); return; }
    const step = STAGE_TO_STEP[evt.stage];
    if (step) advanceTo(step, evt.message);
  }

  // Consume an SSE stream, driving the stepper; resolves with the final complete/error event.
  async function consumeStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", finalEvent = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\\n\\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk.split("\\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        let evt;
        try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        handleEvent(evt);
        if (evt.stage === "complete" || evt.stage === "error") finalEvent = evt;
      }
    }
    return finalEvent;
  }

  async function postStream(endpoint, payload) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-yca-token": POST_TOKEN },
      body: JSON.stringify(payload),
    });
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const data = await res.json().catch(() => ({ error: "HTTP " + res.status }));
      throw new Error(data.error || "unknown error");
    }
    return consumeStream(res);
  }

  async function submitChannel(url, btn) {
    if (btn) btn.disabled = true;
    statusEl.className = "status muted";
    statusEl.textContent = "Listing channel videos…";
    renderSteps([["channel", "List channel videos"], ["graph", "Add to Neo4j"]]);
    try {
      const finalEvent = await postStream("/api/channel", { url });
      if (finalEvent && finalEvent.stage === "complete") {
        const c = finalEvent.channel;
        statusEl.className = "status ok";
        let extra = "";
        if (finalEvent.graph && finalEvent.graph.ok) extra = " Added to Neo4j.";
        statusEl.innerHTML = "Added channel “" + esc(c.name) + "” — " + c.videoCount + " videos." + extra + " " +
          '<a class="linkbtn" href="/channel/' + encodeURIComponent(c.channelId) + '">Open channel</a>';
        await loadChannels();
        await loadVideos();
      } else {
        statusEl.className = "status err";
        statusEl.textContent = "Failed: " + ((finalEvent && finalEvent.error) || "could not list the channel");
      }
    } catch (err) {
      statusEl.className = "status err";
      statusEl.textContent = "Failed: " + err.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    const buildDoc = docCheckbox.checked;
    addBtn.disabled = true;
    statusEl.className = "status muted";
    statusEl.textContent = "Working… this can take up to a minute for large threads.";
    renderSteps(addSteps(buildDoc));
    try {
      const finalEvent = await postStream("/api/add", { url, buildDoc });
      if (finalEvent && finalEvent.stage === "complete") {
        const v = finalEvent.video;
        let msg = "Added “" + v.title + "” — " + Number(v.comments).toLocaleString() + " comments.";
        if (finalEvent.neo4j && finalEvent.neo4j.ok) msg += " Neo4j: " + finalEvent.neo4j.action + ".";
        else if (finalEvent.neo4j && !finalEvent.neo4j.skipped) msg += " Neo4j import failed.";
        if (finalEvent.document && finalEvent.document.ok) msg += " Document: " + finalEvent.document.images + " images.";
        statusEl.className = "status ok";
        statusEl.innerHTML = esc(msg) + ' <button type="button" class="linkbtn" id="undoBtn">Undo</button>';
        document.querySelector("#undoBtn").addEventListener("click", () => removeVideo(v.videoId, { confirm: false }));
        urlInput.value = "";
        await loadVideos();
      } else {
        statusEl.className = "status err";
        statusEl.textContent = "Failed: " + ((finalEvent && finalEvent.error) || "the extraction did not complete");
      }
    } catch (err) {
      statusEl.className = "status err";
      statusEl.textContent = "Failed: " + err.message;
    } finally {
      addBtn.disabled = false;
    }
  });

  async function buildDocumentFor(videoId) {
    const restore = beginRowJob(videoId, "builddoc", "Building…");
    statusEl.className = "status muted";
    statusEl.textContent = "Building illustrated document for " + videoId + "… (captures a frame per chapter)";
    renderSteps([["document", "Build document (images)"]]);
    try {
      const finalEvent = await postStream("/api/document", { videoId });
      if (finalEvent && finalEvent.stage === "complete") {
        const doc = finalEvent.document || {};
        statusEl.className = "status ok";
        statusEl.innerHTML = "Built document for " + esc(videoId) + " — " + (doc.images || 0) + " images. " +
          '<a class="linkbtn" href="/document/' + encodeURIComponent(videoId) + '" target="_blank" rel="noreferrer">Open</a>';
        await loadVideos();
      } else {
        statusEl.className = "status err";
        statusEl.textContent = "Failed: " + ((finalEvent && finalEvent.error) || "the build did not complete");
      }
    } catch (err) {
      statusEl.className = "status err";
      statusEl.textContent = "Failed: " + err.message;
    } finally {
      restore();
    }
  }

  async function buildMindmapFor(videoId) {
    const restore = beginRowJob(videoId, "buildmm", "Building…");
    statusEl.className = "status muted";
    statusEl.textContent = "Building mind map for " + videoId + "… (local Ollama, ~1-2 min)";
    renderSteps([["mindmap", "Build mind map (Ollama)"]]);
    try {
      const finalEvent = await postStream("/api/mindmap", { videoId });
      if (finalEvent && finalEvent.stage === "complete") {
        const mm = finalEvent.mindmap || {};
        statusEl.className = "status ok";
        statusEl.innerHTML = "Built mind map for " + esc(videoId) + " — " + (mm.themes || 0) + " themes (" + esc(mm.sentiment || "") + "). " +
          '<a class="linkbtn" href="/mindmap/' + encodeURIComponent(videoId) + '" target="_blank" rel="noreferrer">Open</a>';
        await loadVideos();
      } else {
        statusEl.className = "status err";
        statusEl.textContent = "Failed: " + ((finalEvent && finalEvent.error) || "the build did not complete");
      }
    } catch (err) {
      statusEl.className = "status err";
      statusEl.textContent = "Failed: " + err.message;
    } finally {
      restore();
    }
  }

  // Give a job launched from a table row immediate local feedback (the #status bar sits at
  // the top of the page, far from the button) and bring the status/progress into view.
  // Returns a restore function for the button.
  function beginRowJob(videoId, cls, busyLabel) {
    const btn = rows.querySelector("." + cls + '[data-id="' + videoId + '"]');
    const original = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = busyLabel; btn.style.opacity = "0.6"; }
    statusEl.scrollIntoView({ behavior: "smooth", block: "center" });
    return function () { if (btn) { btn.disabled = false; btn.textContent = original; btn.style.opacity = ""; } };
  }

  async function buildConceptsFor(videoId) {
    if (!window.confirm("Build the concept graph for " + videoId + "?\\n\\nThis runs one local Ollama call per paragraph (several minutes for a long video) and blocks other jobs until it finishes.")) return;
    const restore = beginRowJob(videoId, "buildconcepts", "Building…");
    statusEl.className = "status muted";
    statusEl.textContent = "Building concept graph for " + videoId + "… (local Ollama, one call per paragraph — this can take several minutes)";
    renderSteps([["mindmap", "Build concept graph (Neo4j + Ollama)"]]);
    try {
      const finalEvent = await postStream("/api/concepts", { videoId });
      if (finalEvent && finalEvent.stage === "complete") {
        const mm = finalEvent.mindmap || {};
        statusEl.className = "status ok";
        statusEl.textContent = "Imported concept graph for " + esc(videoId) + " — " +
          (mm.chapters || 0) + " chapters, " + (mm.paragraphs || 0) + " paragraphs, " + (mm.concepts || 0) + " concepts.";
        await loadVideos();
      } else {
        statusEl.className = "status err";
        statusEl.textContent = "Failed: " + ((finalEvent && finalEvent.error) || "the build did not complete");
      }
    } catch (err) {
      statusEl.className = "status err";
      statusEl.textContent = "Failed: " + err.message;
    } finally {
      restore();
    }
  }

  loadChannels();
  loadVideos();
</script>
</body>
</html>`;
}

// Only listen when run directly, so the helpers can be imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv(PROJECT_DIR);
  server.listen(PORT, HOST, () => {
    console.log(`YouTube Comments Analyzer dashboard: http://${HOST}:${PORT}`);
    if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
      console.log("Note: NEO4J_USER / NEO4J_PASSWORD not set — videos will be extracted but not imported to Neo4j.");
    }
  });
}

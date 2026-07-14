#!/usr/bin/env node
// Summarize a video's comments into a themed MIND MAP using a local Ollama model:
// an overall sentiment, 6-8 themes (each a hyphenated title + emoji + representative
// points), an overall takeaway, a one-paragraph summary, and a table of condensed
// per-commenter "main meanings". Renders output/<id>.mindmap.html (+ .mindmap.json).
// Emits NDJSON progress on stderr when YCA_PROGRESS is set; final JSON goes to stdout.

// fallow-ignore-file complexity -- standalone local CLI is intentionally outside the runtime-service gate.
// fallow-ignore-file code-duplication -- CLI entry-point plumbing is repeated across standalone tools.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT_DIR = path.join(PROJECT_DIR, "output");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.YCA_OLLAMA_MODEL || "llama3.2:latest";
const MAX_COMMENTS = 60;

function progress(stage, message) {
  if (process.env.YCA_PROGRESS) {
    process.stderr.write(JSON.stringify({ progress: stage, message: message || "" }) + "\n");
  }
}

function loadComments(arg, outDir) {
  let resolved = path.resolve(arg);
  if (!fs.existsSync(resolved)) {
    const byId = path.join(outDir, `${arg}.comments.json`);
    if (fs.existsSync(byId)) resolved = byId;
    else throw new Error(`Comments JSON not found: ${arg}`);
  }
  const data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!data.video?.id || !Array.isArray(data.comments)) throw new Error(`${resolved} is not a comments JSON.`);
  return data;
}

// Pick the most representative comments (top by likes) for the model, trimmed.
export function selectComments(comments, limit = MAX_COMMENTS) {
  return comments
    .filter((c) => c.text && c.text.trim())
    .slice()
    .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
    .slice(0, limit)
    .map((c) => ({
      author: c.author || "Unknown",
      likes: c.likeCount || 0,
      text: c.text.replace(/\s+/g, " ").trim().slice(0, 220),
    }));
}

function handleOf(author) {
  const a = String(author || "").trim();
  return a.startsWith("@") ? a : `@${a}`;
}

function buildPrompt(video, picked) {
  const lines = picked.map((c) => `- ${handleOf(c.author)} (${c.likes} likes): ${c.text}`).join("\n");
  return `You analyze YouTube comments and produce a MIND MAP as JSON.

Video title: ${video.title}

Return ONLY JSON with this exact shape:
{
  "sentiment": "a 1-3 word overall sentiment, e.g. Overwhelmingly Positive",
  "themes": [
    { "title": "Hyphenated-Theme-Name", "emoji": "single emoji", "points": ["short paraphrased point", "..."] }
  ],
  "takeaway": ["short overall takeaway", "..."],
  "summary": "one concise paragraph summarizing the audience feedback",
  "meanings": [ { "author": "@handle", "meaning": "Hyphenated-Main-Meaning" } ]
}

Rules:
- 6 to 8 themes. Each theme title is 1-3 words, hyphenated (e.g. Equipment-Suggestions).
- Each theme has one relevant emoji and 2-4 short points paraphrased from the comments.
- "takeaway": 3-4 short bullet phrases.
- "meanings": up to 12 entries mapping a commenter to a 1-3 word hyphenated main meaning.
- Base everything ONLY on the comments below. Be specific to their actual content.

Comments:
${lines}`;
}

// A focused second pass that reliably returns per-commenter "main meanings".
function buildMeaningsPrompt(picked) {
  const lines = picked.map((c) => `- ${handleOf(c.author)}: ${c.text}`).join("\n");
  return `For each YouTube comment below, give a 1-3 word hyphenated "main meaning" that captures its core point (e.g. SkidSteer-Recommendation, Izzy-Comfort, Community-Love).

Return ONLY JSON: {"meanings":[{"author":"@handle","meaning":"Hyphenated-Main-Meaning"}]}
Keep the exact @handle for each comment. One entry per comment.

Comments:
${lines}`;
}

export function normalizeMeanings(raw) {
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { obj = {}; } }
  const list = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.meanings) ? obj.meanings : []);
  return list
    .map((m) => ({ author: typeof m?.author === "string" ? m.author.trim().replace(/^@+/, "@") : "", meaning: typeof m?.meaning === "string" ? m.meaning.trim() : "" }))
    .filter((m) => m.author && m.meaning)
    .slice(0, 12);
}

async function callOllama(prompt) {
  const body = {
    model: OLLAMA_MODEL,
    stream: false,
    format: "json",
    prompt,
    options: { temperature: 0.35, num_ctx: 8192 },
  };
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Ollama not reachable at ${OLLAMA_URL} (${error.message}). Is it running?`);
  }
  if (!res.ok) throw new Error(`Ollama error ${res.status}. Is the model "${OLLAMA_MODEL}" pulled?`);
  const payload = await res.json();
  return payload.response || "";
}

// Validate + clamp the model's JSON into a safe shape.
export function normalizeMindmap(raw) {
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { obj = {}; } }
  obj = obj && typeof obj === "object" ? obj : {};
  const str = (v, fallback = "") => (typeof v === "string" ? v.trim() : fallback);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const themes = arr(obj.themes).map((t) => ({
    title: str(t && t.title) || "Theme",
    emoji: str(t && t.emoji).slice(0, 4) || "💬",
    points: arr(t && t.points).map((p) => str(p)).filter(Boolean).slice(0, 4),
  })).filter((t) => t.points.length).slice(0, 8);
  const meanings = arr(obj.meanings).map((m) => ({
    author: str(m && m.author),
    meaning: str(m && m.meaning),
  })).filter((m) => m.author && m.meaning).slice(0, 12);
  return {
    sentiment: str(obj.sentiment) || "Mixed",
    themes,
    takeaway: arr(obj.takeaway).map((t) => str(t)).filter(Boolean).slice(0, 4),
    summary: str(obj.summary),
    meanings,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const THEME_TINTS = ["#e0f2fe", "#dcfce7", "#fef9c3", "#fae8ff", "#ffe4e6", "#e0e7ff", "#fef3c7", "#ccfbf1"];
const THEME_BORDERS = ["#38bdf8", "#4ade80", "#eab308", "#e879f9", "#fb7185", "#818cf8", "#f59e0b", "#2dd4bf"];

export function renderMindmapHtml({ video, url, mindmap }) {
  const W = 1180, H = 760, cx = W / 2, cy = H / 2, rx = 400, ry = 268;
  const n = mindmap.themes.length || 1;
  const placed = mindmap.themes.map((t, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { ...t, i, x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });

  const connectors = placed.map((t) =>
    `<line x1="${cx}" y1="${cy}" x2="${t.x}" y2="${t.y}" stroke="${THEME_BORDERS[t.i % THEME_BORDERS.length]}" stroke-opacity="0.5" stroke-width="2"></line>`).join("");

  const cards = placed.map((t) => {
    const tint = THEME_TINTS[t.i % THEME_TINTS.length];
    const border = THEME_BORDERS[t.i % THEME_BORDERS.length];
    const points = t.points.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
    return `<div class="mm-theme" style="left:${(t.x / W) * 100}%;top:${(t.y / H) * 100}%;background:${tint};border-color:${border};">
      <div class="mm-th"><span class="mm-emoji">${escapeHtml(t.emoji)}</span><strong>${escapeHtml(t.title)}</strong></div>
      <ul>${points}</ul>
    </div>`;
  }).join("");

  const takeaway = mindmap.takeaway.length
    ? `<div class="mm-takeaway"><strong>Overall takeaway</strong>${mindmap.takeaway.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>`
    : "";

  const meaningsRows = mindmap.meanings.map((m) =>
    `<tr><td>${escapeHtml(m.author)}</td><td><span class="mchip">${escapeHtml(m.meaning)}</span></td></tr>`).join("");
  const meaningsTable = mindmap.meanings.length
    ? `<section class="panel"><h2>Condensed comment meanings</h2>
        <table><thead><tr><th>Commenter</th><th>Main meaning</th></tr></thead><tbody>${meaningsRows}</tbody></table></section>`
    : "";

  const summary = mindmap.summary
    ? `<section class="panel"><h2>Summary</h2><p>${escapeHtml(mindmap.summary)}</p></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mind Map — ${escapeHtml(video.title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #eef1f6; color: #1f2430; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  header { background: #fff; border-bottom: 1px solid #e2e6ee; }
  header .in { max-width: 1220px; margin: 0 auto; padding: 18px 22px; }
  h1 { margin: 0 0 4px; font-size: 1.25rem; }
  .sub { margin: 0; color: #6b7280; font-size: 0.88rem; }
  .sub a { color: #0f766e; text-decoration: none; font-weight: 600; }
  main { max-width: 1220px; margin: 0 auto; padding: 22px; }
  .mmwrap { overflow-x: auto; padding-bottom: 8px; }
  .mm { position: relative; width: ${W}px; height: ${H}px; margin: 0 auto; }
  .mm svg.links { position: absolute; inset: 0; width: 100%; height: 100%; }
  .mm-center { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 210px; height: 210px; border-radius: 50%; background: linear-gradient(160deg,#0f766e,#134e4a); color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20px; box-shadow: 0 20px 50px rgba(15,118,110,0.35); z-index: 2; }
  .mm-center h2 { margin: 0 0 8px; font-size: 1.05rem; line-height: 1.2; }
  .mm-center .sent { font-size: 0.82rem; font-weight: 800; color: #99f6e4; background: rgba(153,246,228,0.16); border: 1px solid rgba(153,246,228,0.4); padding: 4px 10px; border-radius: 999px; }
  .mm-theme { position: absolute; transform: translate(-50%,-50%); width: 216px; border: 2px solid; border-radius: 14px; padding: 11px 13px; box-shadow: 0 10px 26px rgba(15,23,42,0.12); z-index: 3; }
  .mm-th { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .mm-emoji { font-size: 1.15rem; }
  .mm-th strong { font-size: 0.92rem; }
  .mm-theme ul { margin: 0; padding-left: 17px; }
  .mm-theme li { font-size: 0.8rem; line-height: 1.4; margin-bottom: 3px; color: #334155; }
  .mm-takeaway { max-width: 1220px; margin: 6px auto 0; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 16px; background: #0f172a; color: #e2e8f0; border-radius: 12px; }
  .mm-takeaway strong { color: #fff; margin-right: 6px; }
  .mm-takeaway span { background: rgba(148,163,184,0.16); border: 1px solid rgba(148,163,184,0.3); padding: 5px 11px; border-radius: 999px; font-size: 0.82rem; }
  .panel { background: #fff; border: 1px solid #e2e6ee; border-radius: 12px; padding: 18px 20px; margin-top: 20px; }
  .panel h2 { margin: 0 0 12px; font-size: 1rem; }
  .panel p { margin: 0; line-height: 1.7; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #eef0f4; font-size: 0.88rem; }
  th { color: #6b7280; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .mchip { display: inline-block; padding: 3px 9px; border-radius: 999px; background: rgba(168,85,247,0.12); color: #7c3aed; font-weight: 700; font-size: 0.8rem; }
  .note { color: #6b7280; font-size: 0.78rem; margin-top: 10px; }
  @media (max-width: 700px) { h1 { font-size: 1.1rem; } }
</style>
</head>
<body>
<header><div class="in">
  <h1>${escapeHtml(video.title)}</h1>
  <p class="sub">Comment mind map &middot; <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Watch on YouTube</a></p>
</div></header>
<main>
  <div class="mmwrap">
    <div class="mm">
      <svg class="links" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${connectors}</svg>
      <div class="mm-center"><h2>Audience Feedback Summary</h2><span class="sent">${escapeHtml(mindmap.sentiment)}</span></div>
      ${cards}
    </div>
  </div>
  ${takeaway}
  ${summary}
  ${meaningsTable}
  <p class="note">Generated locally with Ollama (${escapeHtml(OLLAMA_MODEL)}) from the top ${MAX_COMMENTS} comments by likes.</p>
</main>
</body>
</html>`;
}

export async function buildMindmap({ arg, outDir = DEFAULT_OUT_DIR }) {
  progress("mindmap-collect", "Selecting comments");
  const data = loadComments(arg, outDir);
  const picked = selectComments(data.comments);
  if (!picked.length) throw new Error("No comments to summarize.");

  progress("mindmap-analyze", `Analyzing themes with ${OLLAMA_MODEL}`);
  const mindmap = normalizeMindmap(await callOllama(buildPrompt(data.video, picked)));
  if (!mindmap.themes.length) throw new Error("The model did not return any themes.");

  // Second focused pass for the condensed per-commenter meanings (top comments only).
  progress("mindmap-analyze", "Condensing comment meanings");
  try {
    const meanings = normalizeMeanings(await callOllama(buildMeaningsPrompt(picked.slice(0, 12))));
    if (meanings.length) mindmap.meanings = meanings;
  } catch { /* keep whatever the first pass produced */ }

  progress("mindmap-render", "Building mind map");
  const url = data.video.url || `https://www.youtube.com/watch?v=${data.video.id}`;
  const html = renderMindmapHtml({ video: data.video, url, mindmap });
  const htmlPath = path.join(outDir, `${data.video.id}.mindmap.html`);
  fs.writeFileSync(htmlPath, html, "utf8");
  fs.writeFileSync(path.join(outDir, `${data.video.id}.mindmap.json`), `${JSON.stringify(mindmap, null, 2)}\n`, "utf8");

  return {
    videoId: data.video.id,
    title: data.video.title,
    themes: mindmap.themes.length,
    meanings: mindmap.meanings.length,
    sentiment: mindmap.sentiment,
    mindmapHtmlPath: htmlPath,
  };
}

async function main() {
  try {
    const arg = process.argv[2];
    if (!arg || arg === "-h" || arg === "--help") {
      console.log('Usage: node scripts/mindmap-tool.mjs <videoId | comments.json> [--out-dir <path>]\nEnv: YCA_OLLAMA_MODEL (default llama3.2:latest), OLLAMA_URL (default http://localhost:11434)');
      return;
    }
    let outDir = DEFAULT_OUT_DIR;
    const outFlag = process.argv.indexOf("--out-dir");
    if (outFlag !== -1 && process.argv[outFlag + 1]) outDir = path.resolve(process.argv[outFlag + 1]);
    console.log(JSON.stringify({ ok: true, ...(await buildMindmap({ arg, outDir })) }, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

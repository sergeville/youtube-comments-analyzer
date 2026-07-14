#!/usr/bin/env node
// Fetch a YouTube video's captions with yt-dlp and render a clean, readable transcript
// page (output/<videoId>.transcript.html). Runs just before comment extraction in the
// dashboard's add flow. Emits NDJSON progress on stderr when YCA_PROGRESS is set, so the
// server can stream per-stage status; the final JSON result goes to stdout.

// fallow-ignore-file complexity -- standalone local CLI is intentionally outside the runtime-service gate.
// fallow-ignore-file code-duplication -- CLI entry-point plumbing is repeated across standalone tools.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT_DIR = path.join(PROJECT_DIR, "output");
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function progress(stage, message) {
  if (process.env.YCA_PROGRESS) {
    process.stderr.write(JSON.stringify({ progress: stage, message: message || "" }) + "\n");
  }
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const url = args.shift();
  let outDir = DEFAULT_OUT_DIR;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--out-dir") { outDir = path.resolve(args.shift() || ""); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { url, outDir };
}

function extractVideoId(parsed) {
  if (parsed.hostname.toLowerCase() === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0];
  if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (["embed", "shorts", "live"].includes(parts[0])) return parts[1];
  return null;
}

function validateYouTubeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") throw new Error("Missing YouTube URL.");
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error("Invalid URL."); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http/https URLs are supported.");
  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error(`Invalid host: ${parsed.hostname}.`);
  const videoId = extractVideoId(parsed);
  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) throw new Error("Could not find a valid YouTube video id.");
  return { canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`, videoId };
}

function ensureToolInstalled(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${name} is not installed or not on PATH.`);
}

// Fetch English captions (manual first, then auto) + info json for the title.
function runYtDlpSubs({ canonicalUrl, videoId, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const result = spawnSync("yt-dlp", [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs", "en.*,en,en-orig",
    "--sub-format", "json3",
    "--write-info-json",
    "--paths", outDir,
    "-o", `${videoId}.%(ext)s`,
    canonicalUrl,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  if (result.status !== 0) {
    throw new Error(`yt-dlp failed.\n${result.stderr || result.stdout}`);
  }
}

// Locate the best json3 caption file for this video (prefer plain "en").
export function findCaptionFile(outDir, videoId) {
  if (!fs.existsSync(outDir)) return null;
  const candidates = fs.readdirSync(outDir)
    .filter((f) => f.startsWith(`${videoId}.`) && f.endsWith(".json3"));
  if (!candidates.length) return null;
  const score = (f) => {
    const lang = f.slice(videoId.length + 1, -".json3".length).toLowerCase();
    if (lang === "en") return 0;
    if (lang.startsWith("en") && !lang.includes("orig")) return 1;
    if (lang.startsWith("en")) return 2;
    return 3;
  };
  candidates.sort((a, b) => score(a) - score(b));
  return path.join(outDir, candidates[0]);
}

// Turn a yt-dlp json3 caption file into ordered { start, text } lines (deduped).
export function parseJson3(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  const events = Array.isArray(data.events) ? data.events : [];
  const lines = [];
  for (const event of events) {
    if (!Array.isArray(event.segs)) continue;
    const text = event.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (lines.length && lines[lines.length - 1].text === text) continue; // drop rolling dupes
    lines.push({ start: Math.max(0, Math.round((event.tStartMs || 0) / 1000)), text });
  }
  return lines;
}

// Merge caption lines into readable paragraphs, each keeping its opening timestamp.
export function groupParagraphs(lines, maxChars = 340) {
  const paragraphs = [];
  let current = null;
  for (const line of lines) {
    if (!current) { current = { start: line.start, text: line.text }; continue; }
    if (current.text.length + line.text.length + 1 > maxChars) {
      paragraphs.push(current);
      current = { start: line.start, text: line.text };
    } else {
      current.text += " " + line.text;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

export function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function estimateReadMinutes(paragraphs) {
  const words = paragraphs.reduce((sum, p) => sum + p.text.split(/\s+/).length, 0);
  return Math.max(1, Math.round(words / 200));
}

export function renderTranscriptHtml({ videoId, title, url, paragraphs, language }) {
  const has = paragraphs.length > 0;
  const readMins = has ? estimateReadMinutes(paragraphs) : 0;
  const body = has
    ? paragraphs.map((p) => {
        const at = `${url}${url.includes("?") ? "&" : "?"}t=${p.start}s`;
        return `<p class="seg">` +
          `<a class="ts" href="${escapeHtml(at)}" target="_blank" rel="noreferrer" title="Open on YouTube at ${formatTimestamp(p.start)}">${formatTimestamp(p.start)}</a>` +
          `<span class="txt">${escapeHtml(p.text)}</span></p>`;
      }).join("\n")
    : `<div class="empty">No transcript is available for this video (no captions were found).</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Transcript — ${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #f6f5f2; --panel: #ffffff; --ink: #1f2430; --muted: #6b7280; --line: #e6e4de;
    --accent: #0f766e; --chip: #eef2f1; --mark: #fde68a;
  }
  body.dark {
    --bg: #0e131f; --panel: #131a29; --ink: #e6ebf5; --muted: #94a3b8; --line: #263148;
    --accent: #5eead4; --chip: #1c2740; --mark: #92710a;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  header { position: sticky; top: 0; z-index: 5; background: var(--panel); border-bottom: 1px solid var(--line); }
  .bar { max-width: 820px; margin: 0 auto; padding: 16px 22px; display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
  h1 { margin: 0 0 4px; font-size: 1.15rem; line-height: 1.35; }
  .sub { margin: 0; color: var(--muted); font-size: 0.85rem; }
  .sub a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .sub a:hover { text-decoration: underline; }
  .tools { display: flex; gap: 8px; flex: none; }
  .btn { min-height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--ink); font: inherit; font-size: 0.82rem; font-weight: 700; cursor: pointer; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .searchwrap { max-width: 820px; margin: 0 auto; padding: 0 22px 14px; }
  #search { width: 100%; min-height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--bg); color: var(--ink); font: inherit; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 22px 80px; }
  .seg { display: grid; grid-template-columns: 64px 1fr; gap: 16px; margin: 0 0 18px; align-items: baseline; }
  .ts { color: var(--accent); font-variant-numeric: tabular-nums; font-size: 0.82rem; font-weight: 700; text-decoration: none; padding-top: 3px; }
  .ts:hover { text-decoration: underline; }
  .txt { font-size: 1.075rem; line-height: 1.85; }
  mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 2px; }
  .seg.hide { display: none; }
  .empty { color: var(--muted); padding: 30px 0; font-size: 1rem; }
  .count { color: var(--muted); font-size: 0.8rem; margin: 0 0 18px; }
  @media (max-width: 560px) { .seg { grid-template-columns: 52px 1fr; gap: 12px; } .txt { font-size: 1.02rem; } }
</style>
</head>
<body>
<header>
  <div class="bar">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p class="sub"><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Watch on YouTube</a>${has ? ` &middot; ${paragraphs.length} sections &middot; ~${readMins} min read${language ? ` &middot; ${escapeHtml(language)}` : ""}` : ""}</p>
    </div>
    <div class="tools">
      <button class="btn" id="themeBtn" type="button">Dark</button>
    </div>
  </div>
  ${has ? `<div class="searchwrap"><input id="search" type="search" placeholder="Search the transcript…" autocomplete="off" /></div>` : ""}
</header>
<main>
  ${has ? `<p class="count" id="count">${paragraphs.length} sections</p>` : ""}
  ${body}
</main>
<script>
  const themeBtn = document.querySelector("#themeBtn");
  themeBtn.addEventListener("click", () => {
    const dark = document.body.classList.toggle("dark");
    themeBtn.textContent = dark ? "Light" : "Dark";
  });
  const search = document.querySelector("#search");
  if (search) {
    const segs = Array.from(document.querySelectorAll(".seg"));
    const originals = segs.map((s) => s.querySelector(".txt").textContent);
    const count = document.querySelector("#count");
    function esc(s) { return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"); }
    search.addEventListener("input", () => {
      const q = search.value.trim();
      let shown = 0;
      segs.forEach((seg, i) => {
        const txt = originals[i];
        const match = !q || txt.toLowerCase().includes(q.toLowerCase());
        seg.classList.toggle("hide", !match);
        const span = seg.querySelector(".txt");
        if (q && match) {
          const re = new RegExp("(" + esc(q) + ")", "ig");
          span.innerHTML = txt.replace(re, "<mark>$1</mark>");
        } else {
          span.textContent = txt;
        }
        if (match) shown += 1;
      });
      if (count) count.textContent = q ? shown + " matching sections" : segs.length + " sections";
    });
  }
</script>
</body>
</html>`;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: node scripts/transcript-tool.mjs "<youtube-url>" [--out-dir <path>]');
      return;
    }
    progress("transcript-fetch", "Fetching captions with yt-dlp");
    const { canonicalUrl, videoId } = validateYouTubeUrl(args.url);
    ensureToolInstalled("yt-dlp");
    runYtDlpSubs({ canonicalUrl, videoId, outDir: args.outDir });

    let title = videoId;
    let url = canonicalUrl;
    const infoPath = path.join(args.outDir, `${videoId}.info.json`);
    if (fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
        title = info.title || title;
        url = info.webpage_url || url;
      } catch { /* keep defaults */ }
    }

    progress("transcript-parse", "Parsing captions");
    const captionFile = findCaptionFile(args.outDir, videoId);
    let paragraphs = [];
    let language = null;
    if (captionFile) {
      language = path.basename(captionFile).slice(videoId.length + 1, -".json3".length);
      paragraphs = groupParagraphs(parseJson3(fs.readFileSync(captionFile, "utf8")));
    }

    progress("transcript-render", "Building transcript page");
    const html = renderTranscriptHtml({ videoId, title, url, paragraphs, language });
    const htmlPath = path.join(args.outDir, `${videoId}.transcript.html`);
    fs.writeFileSync(htmlPath, html, "utf8");

    console.log(JSON.stringify({
      ok: true,
      videoId,
      title,
      hasTranscript: paragraphs.length > 0,
      sections: paragraphs.length,
      language,
      transcriptHtmlPath: htmlPath,
    }, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

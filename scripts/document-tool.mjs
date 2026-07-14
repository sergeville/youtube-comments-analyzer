#!/usr/bin/env node
// Build a beautiful, illustrated HTML "document" from a YouTube video's transcript.
// Flow: fetch captions (if needed) -> extract the transcript into a variable -> fold it
// into the video's own chapters as an article (heading + flowing prose per chapter) ->
// grab one real video frame per chapter with ffmpeg as the section image. Emits NDJSON
// progress on stderr when YCA_PROGRESS is set; the final JSON result goes to stdout.

// fallow-ignore-file complexity -- standalone local CLI is intentionally outside the runtime-service gate.
// fallow-ignore-file code-duplication -- CLI entry-point plumbing is repeated across standalone tools.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { findCaptionFile, parseJson3, groupParagraphs, formatTimestamp } from "./transcript-tool.mjs";

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

function extractVideoId(parsed) {
  if (parsed.hostname.toLowerCase() === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0];
  if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (["embed", "shorts", "live"].includes(parts[0])) return parts[1];
  return null;
}

export function validateYouTubeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") throw new Error("Missing YouTube URL.");
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error("Invalid URL."); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http/https URLs are supported.");
  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error(`Invalid host: ${parsed.hostname}.`);
  const videoId = extractVideoId(parsed);
  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) throw new Error("Could not find a valid YouTube video id.");
  return { canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`, videoId };
}

function commandExists(name) {
  return spawnSync("which", [name], { encoding: "utf8" }).status === 0;
}

function ensureToolInstalled(name) {
  if (!commandExists(name)) throw new Error(`${name} is not installed or not on PATH.`);
}

// Fetch captions + info (only when not already on disk from a prior transcript run).
function ensureCaptions({ canonicalUrl, videoId, outDir }) {
  const haveCaption = Boolean(findCaptionFile(outDir, videoId));
  const haveInfo = fs.existsSync(path.join(outDir, `${videoId}.info.json`));
  if (haveCaption && haveInfo) return;
  fs.mkdirSync(outDir, { recursive: true });
  const result = spawnSync("yt-dlp", [
    "--skip-download", "--write-subs", "--write-auto-subs",
    "--sub-langs", "en.*,en,en-orig", "--sub-format", "json3",
    "--write-info-json", "--paths", outDir, "-o", `${videoId}.%(ext)s`, canonicalUrl,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`yt-dlp failed.\n${result.stderr || result.stdout}`);
}

function readVideoInfo(outDir, videoId) {
  const infoPath = path.join(outDir, `${videoId}.info.json`);
  if (!fs.existsSync(infoPath)) return {};
  try { return JSON.parse(fs.readFileSync(infoPath, "utf8")); } catch { return {}; }
}

export function pickThumbnail(info, videoId) {
  if (typeof info.thumbnail === "string" && info.thumbnail) return info.thumbnail;
  if (Array.isArray(info.thumbnails)) {
    const best = info.thumbnails
      .filter((t) => t && t.url)
      .sort((a, b) => (b.width || b.preference || 0) - (a.width || a.preference || 0))[0];
    if (best) return best.url;
  }
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// Choose a few evenly-spaced, well-sized sentences to feature as pull-quotes.
export function pickPullQuotes(fullText, count = 3) {
  const sentences = fullText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 60 && s.length <= 170);
  if (!sentences.length) return [];
  const picked = [];
  for (let i = 1; i <= count; i++) {
    picked.push(sentences[Math.floor((i / (count + 1)) * sentences.length)]);
  }
  return [...new Set(picked.filter(Boolean))];
}

// Split a block of text into readable paragraphs of a few sentences each.
export function paragraphize(text, targetChars = 480) {
  const sentences = String(text).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const paras = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > targetChars) {
      paras.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) paras.push(current);
  return paras;
}

// Fold the flat transcript into the video's chapters (its natural sections). Falls back to
// evenly-sized untitled sections when the video has no chapter markers.
export function buildSections(paragraphs, chapters, duration) {
  if (!paragraphs.length) return [];
  if (Array.isArray(chapters) && chapters.length) {
    return chapters.map((ch, i) => {
      const start = Math.round(ch.start_time || 0);
      const nextStart = chapters[i + 1] ? chapters[i + 1].start_time : (duration || Infinity);
      const end = Math.round(ch.end_time || nextStart || Infinity);
      const text = paragraphs.filter((p) => p.start >= start && p.start < end).map((p) => p.text).join(" ").trim();
      return { title: ch.title || `Part ${i + 1}`, start, end, text, paras: paragraphize(text) };
    }).filter((s) => s.text);
  }
  const n = Math.min(8, paragraphs.length);
  const per = Math.ceil(paragraphs.length / n);
  const sections = [];
  for (let i = 0; i < paragraphs.length; i += per) {
    const slice = paragraphs.slice(i, i + per);
    const text = slice.map((p) => p.text).join(" ").trim();
    sections.push({ title: null, start: slice[0].start, end: slice[slice.length - 1].start, text, paras: paragraphize(text) });
  }
  return sections;
}

// Resolve a single progressive stream URL for frame grabbing.
function getStreamUrl(canonicalUrl) {
  const result = spawnSync("yt-dlp", [
    "-f", "18/mp4[height<=480][vcodec!=none][acodec!=none]/worst[ext=mp4]/worst",
    "--get-url", canonicalUrl,
  ], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const urls = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  return urls[0] || null;
}

// Best-effort: grab one frame per section with ffmpeg (seek + single frame). Mutates each
// section with `.image` on success. Silently skips when ffmpeg/stream is unavailable.
function extractFrames(sections, { videoId, canonicalUrl, outDir }) {
  if (!sections.length || !commandExists("ffmpeg")) return 0;
  const streamUrl = getStreamUrl(canonicalUrl);
  if (!streamUrl) return 0;
  let grabbed = 0;
  sections.forEach((sec, i) => {
    const span = (sec.end && sec.end !== Infinity ? sec.end : sec.start + 10) - sec.start;
    const at = sec.start + Math.min(6, Math.max(1, Math.floor(span / 3)));
    const file = `${videoId}.frame-${i}.jpg`;
    progress("document-frames", `Capturing image ${i + 1}/${sections.length}`);
    const result = spawnSync("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-ss", String(at), "-i", streamUrl,
      "-frames:v", "1", "-q:v", "3", "-vf", "scale=1280:-2", "-y", path.join(outDir, file),
    ], { encoding: "utf8", timeout: 60000 });
    const framePath = path.join(outDir, file);
    if (result.status === 0 && fs.existsSync(framePath)) {
      // Inline as a data URI so the document is fully self-contained — it works opened as a
      // file and when served through the dashboard, with no separate image requests.
      sec.image = `data:image/jpeg;base64,${fs.readFileSync(framePath).toString("base64")}`;
      fs.rmSync(framePath, { force: true });
      grabbed += 1;
    }
  });
  return grabbed;
}

function formatUploadDate(raw) {
  if (!/^\d{8}$/.test(String(raw || ""))) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const y = raw.slice(0, 4), m = Number(raw.slice(4, 6)), d = Number(raw.slice(6, 8));
  return `${months[m - 1]} ${d}, ${y}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function clamp(text, max) {
  const t = String(text || "").trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + "…" : t;
}

// Render the illustrated article from the section list + video metadata.
export function renderDocumentHtml({ videoId, title, url, thumbnail, channel, duration, published, description, sections }) {
  const has = sections.length > 0;
  const fullText = sections.map((s) => s.text).join(" ");
  const words = fullText.split(/\s+/).filter(Boolean).length;
  const readMins = Math.max(1, Math.round(words / 200));
  const pulls = has ? pickPullQuotes(fullText, 2) : [];

  const metaBits = [
    channel ? escapeHtml(channel) : null,
    duration ? formatTimestamp(duration) : null,
    published ? escapeHtml(published) : null,
    has ? `${readMins} min read` : null,
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");

  const toc = has && sections.some((s) => s.title)
    ? `<nav class="toc" aria-label="Contents"><h2>Contents</h2><ol>${sections.map((s, i) =>
        `<li><a href="#s${i}">${escapeHtml(s.title || `Part ${i + 1}`)}</a></li>`).join("")}</ol></nav>`
    : "";

  // Insert pull-quotes between chapters at roughly 1/3 and 2/3 through.
  const pullAt = new Map(pulls.map((q, i) => [Math.floor(((i + 1) / (pulls.length + 1)) * sections.length), q]));

  const body = has
    ? sections.map((sec, i) => {
        const at = `${url}${url.includes("?") ? "&" : "?"}t=${sec.start}s`;
        const heading = sec.title
          ? `<div class="chead"><span class="cnum">${String(i + 1).padStart(2, "0")}</span>` +
            `<h2 id="s${i}">${escapeHtml(sec.title)}</h2>` +
            `<a class="ts" href="${escapeHtml(at)}" target="_blank" rel="noreferrer">${formatTimestamp(sec.start)}</a></div>`
          : `<div class="chead" id="s${i}"></div>`;
        const figure = sec.image
          ? `<figure class="shot"><a href="${escapeHtml(at)}" target="_blank" rel="noreferrer">` +
            `<img loading="lazy" src="${escapeHtml(sec.image)}" alt="${escapeHtml(sec.title || title)}" /></a>` +
            (sec.title ? `<figcaption>${escapeHtml(sec.title)} &middot; ${formatTimestamp(sec.start)}</figcaption>` : "") +
            `</figure>`
          : "";
        const paras = sec.paras.map((p, j) =>
          `<p class="txt${i === 0 && j === 0 ? " lead" : ""}">${escapeHtml(p)}</p>`).join("");
        const quote = pullAt.has(i) ? `<figure class="pull"><blockquote>${escapeHtml(pullAt.get(i))}</blockquote></figure>` : "";
        return `<section class="chapter">${heading}${figure}${paras}${quote}</section>`;
      }).join("\n")
    : `<p class="empty">No transcript captions were found for this video, so there is nothing to document.</p>`;

  const overview = description
    ? `<aside class="overview"><h2>Overview</h2><p>${escapeHtml(clamp(description, 600))}</p></aside>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg:#f4f2ee; --panel:#fffdf9; --ink:#20242c; --soft:#5b6270; --line:#e7e3da;
    --accent:#0f766e; --accent2:#b45309; --quote:#0b3b37;
  }
  body.dark { --bg:#0c111c; --panel:#121a29; --ink:#e8edf6; --soft:#9aa6b8; --line:#243046; --accent:#5eead4; --accent2:#fbbf24; --quote:#a7f3d0; }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  #progress { position:fixed; top:0; left:0; height:3px; width:0; background:linear-gradient(90deg,var(--accent),var(--accent2)); z-index:20; transition:width 80ms linear; }
  .hero { position:relative; min-height:min(58vh,460px); display:flex; align-items:flex-end; color:#fff; overflow:hidden; }
  .hero .thumb { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .hero .scrim { position:absolute; inset:0; background:linear-gradient(180deg,rgba(6,10,18,.12) 0%,rgba(6,10,18,.55) 55%,rgba(6,10,18,.9) 100%); }
  .hero .inner { position:relative; max-width:820px; margin:0 auto; width:100%; padding:40px 28px 34px; }
  .kicker { display:inline-block; font-size:.72rem; letter-spacing:.14em; text-transform:uppercase; font-weight:800; color:#a7f3d0; background:rgba(15,118,110,.34); border:1px solid rgba(94,234,212,.4); padding:5px 11px; border-radius:999px; margin-bottom:14px; }
  .hero h1 { margin:0 0 12px; font-size:clamp(1.7rem,3.6vw,2.75rem); line-height:1.12; letter-spacing:-.01em; text-shadow:0 2px 18px rgba(0,0,0,.4); }
  .hero .meta { margin:0; font-size:.9rem; color:#e6ebf2; opacity:.92; }
  .hero .cta { margin-top:18px; display:inline-flex; align-items:center; gap:8px; min-height:40px; padding:0 16px; border-radius:10px; background:#fff; color:#0b1220; font-weight:800; font-size:.86rem; text-decoration:none; }
  .toolbar { max-width:760px; margin:0 auto; padding:14px 28px 0; display:flex; justify-content:flex-end; }
  .btn { min-height:34px; padding:0 12px; border:1px solid var(--line); border-radius:8px; background:var(--panel); color:var(--ink); font:inherit; font-size:.8rem; font-weight:700; cursor:pointer; }
  .btn:hover { border-color:var(--accent); color:var(--accent); }
  main { max-width:760px; margin:0 auto; padding:26px 28px 90px; }
  .overview { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:12px; padding:18px 20px; margin:6px 0 26px; }
  .overview h2 { margin:0 0 8px; font-size:.78rem; text-transform:uppercase; letter-spacing:.1em; color:var(--soft); }
  .overview p { margin:0; color:var(--ink); line-height:1.7; font-size:.98rem; }
  .toc { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 22px; margin:0 0 34px; }
  .toc h2 { margin:0 0 10px; font-size:.78rem; text-transform:uppercase; letter-spacing:.1em; color:var(--soft); }
  .toc ol { margin:0; padding-left:1.2em; columns:2; column-gap:28px; }
  .toc li { margin:0 0 6px; }
  .toc a { color:var(--accent); text-decoration:none; font-weight:600; font-size:.92rem; }
  .toc a:hover { text-decoration:underline; }
  .chapter { margin:0 0 34px; }
  .chead { display:flex; align-items:baseline; gap:12px; margin:38px 0 6px; padding-top:14px; border-top:1px solid var(--line); }
  .cnum { font-variant-numeric:tabular-nums; font-size:.85rem; font-weight:800; color:var(--accent2); }
  .chead h2 { margin:0; font-size:1.5rem; line-height:1.2; letter-spacing:-.01em; flex:1; }
  .ts { color:var(--accent); font-variant-numeric:tabular-nums; font-size:.8rem; font-weight:700; text-decoration:none; white-space:nowrap; }
  .ts:hover { text-decoration:underline; }
  .shot { margin:16px 0 20px; }
  .shot img { width:100%; display:block; border-radius:12px; border:1px solid var(--line); box-shadow:0 18px 44px rgba(15,23,42,.16); }
  .shot figcaption { margin-top:8px; color:var(--soft); font-size:.8rem; text-align:center; }
  .txt { margin:0 0 16px; font-size:1.12rem; line-height:1.86; }
  .txt.lead::first-letter { font-size:3.3rem; font-weight:800; float:left; line-height:.86; padding:6px 12px 0 0; color:var(--accent); }
  .pull { margin:26px 0 30px; }
  .pull blockquote { margin:0; padding:6px 0 6px 22px; border-left:4px solid var(--accent2); font-size:1.38rem; line-height:1.4; font-weight:600; font-style:italic; color:var(--quote); }
  .empty { color:var(--soft); padding:30px 0; }
  footer { max-width:760px; margin:0 auto; padding:20px 28px 70px; color:var(--soft); font-size:.82rem; border-top:1px solid var(--line); }
  @media (max-width:560px){ .toc ol{ columns:1; } .txt{ font-size:1.06rem; } .chead h2{ font-size:1.28rem; } .pull blockquote{ font-size:1.2rem; } }
</style>
</head>
<body>
<div id="progress"></div>
<header class="hero">
  <img class="thumb" src="${escapeHtml(thumbnail)}" alt="" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${escapeHtml(videoId)}/hqdefault.jpg';" />
  <div class="scrim"></div>
  <div class="inner">
    <span class="kicker">Transcript Document</span>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">${metaBits}</p>
    <a class="cta" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">▶ Watch on YouTube</a>
  </div>
</header>
<div class="toolbar"><button class="btn" id="themeBtn" type="button">Dark</button></div>
<main>
  ${overview}
  ${toc}
  ${body}
</main>
<footer>
  A reading document generated from the video transcript${channel ? ` by ${escapeHtml(channel)}` : ""}. Section images are frames from the source video; headings and timestamps link back to YouTube.
</footer>
<script>
  var bar = document.getElementById("progress");
  function onScroll(){
    var h = document.documentElement;
    var max = (h.scrollHeight - h.clientHeight) || 1;
    bar.style.width = Math.min(100, (h.scrollTop / max) * 100) + "%";
  }
  document.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  var themeBtn = document.getElementById("themeBtn");
  themeBtn.addEventListener("click", function(){
    var dark = document.body.classList.toggle("dark");
    themeBtn.textContent = dark ? "Light" : "Dark";
  });
</script>
</body>
</html>`;
}

// Extract the transcript into a variable, fold it into chapters, illustrate, and render.
export function buildDocument({ url, outDir = DEFAULT_OUT_DIR, images = true }) {
  const { canonicalUrl, videoId } = validateYouTubeUrl(url);
  ensureToolInstalled("yt-dlp");
  progress("document-fetch", "Fetching captions");
  ensureCaptions({ canonicalUrl, videoId, outDir });

  progress("document-extract", "Extracting transcript");
  const info = readVideoInfo(outDir, videoId);
  const captionFile = findCaptionFile(outDir, videoId);
  // The transcript, held in a variable, is the single input to the document.
  const transcript = captionFile ? groupParagraphs(parseJson3(fs.readFileSync(captionFile, "utf8"))) : [];
  const sections = buildSections(transcript, info.chapters, info.duration);

  let images_grabbed = 0;
  if (images) {
    images_grabbed = extractFrames(sections, { videoId, canonicalUrl, outDir });
  }

  progress("document-render", "Building document");
  const html = renderDocumentHtml({
    videoId,
    title: info.title || videoId,
    url: info.webpage_url || canonicalUrl,
    thumbnail: pickThumbnail(info, videoId),
    channel: info.channel || info.uploader || null,
    duration: info.duration || null,
    published: formatUploadDate(info.upload_date),
    description: info.description || null,
    sections,
  });
  const htmlPath = path.join(outDir, `${videoId}.document.html`);
  fs.writeFileSync(htmlPath, html, "utf8");

  return {
    videoId,
    title: info.title || videoId,
    hasTranscript: transcript.length > 0,
    sections: sections.length,
    images: images_grabbed,
    documentHtmlPath: htmlPath,
  };
}

function main() {
  try {
    const url = process.argv[2];
    if (!url || url === "-h" || url === "--help") {
      console.log('Usage: node scripts/document-tool.mjs "<youtube-url>" [--out-dir <path>] [--no-images]');
      return;
    }
    let outDir = DEFAULT_OUT_DIR;
    const outFlag = process.argv.indexOf("--out-dir");
    if (outFlag !== -1 && process.argv[outFlag + 1]) outDir = path.resolve(process.argv[outFlag + 1]);
    const images = !process.argv.includes("--no-images");
    const result = buildDocument({ url, outDir, images });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

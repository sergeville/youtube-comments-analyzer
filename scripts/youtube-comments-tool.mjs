#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { deriveCommentContext, resolveCommentContext } from "./comment-context.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT_DIR = path.join(PROJECT_DIR, "output");
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function printHelp() {
  console.log(`Usage:
  node scripts/youtube-comments-tool.mjs <youtube-url> [--out-dir <path>]
  node scripts/youtube-comments-tool.mjs --from-json <comments-json> [--out-dir <path>]

Examples:
  node scripts/youtube-comments-tool.mjs "https://www.youtube.com/watch?v=WALe2iQvaOk"
  node scripts/youtube-comments-tool.mjs "https://youtu.be/WALe2iQvaOk" --out-dir /tmp/youtube-comments
  node scripts/youtube-comments-tool.mjs --from-json output/neUqTZiFKq4.comments.json

What it does:
  1. Validates the YouTube URL before creating files or calling yt-dlp.
  2. Downloads comment metadata with yt-dlp.
  3. Normalizes comments into JSON.
  4. Categorizes the updated JSON with a video-aware classifier.
  5. Writes the categorized JSON.
  6. Writes a modern static HTML thread-card page with a graph mindmap.

Requirements:
  - yt-dlp must be installed and reachable on PATH.
  - --from-json does not call yt-dlp.
`);
}

// fallow-ignore-next-line complexity
function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  let url = null;
  let fromJson = null;
  let outDir = DEFAULT_OUT_DIR;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--out-dir") {
      const value = args.shift();
      if (!value) {
        throw new Error("Missing value for --out-dir.");
      }
      outDir = path.resolve(value);
      continue;
    }
    if (arg === "--from-json") {
      const value = args.shift();
      if (!value) {
        throw new Error("Missing value for --from-json.");
      }
      fromJson = path.resolve(value);
      continue;
    }
    if (!url) {
      url = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { url, fromJson, outDir };
}

// fallow-ignore-next-line complexity
function validateYouTubeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("Missing YouTube URL.");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL. Provide a full YouTube URL, for example https://www.youtube.com/watch?v=WALe2iQvaOk.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid URL protocol. Only http and https YouTube URLs are supported.");
  }

  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    throw new Error(`Invalid host: ${parsed.hostname}. Expected youtube.com or youtu.be.`);
  }

  const videoId = extractVideoId(parsed);
  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
    throw new Error("Could not find a valid 11-character YouTube video ID in the URL.");
  }

  return {
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

function extractVideoId(parsed) {
  if (parsed.hostname.toLowerCase() === "youtu.be") {
    return parsed.pathname.split("/").filter(Boolean)[0];
  }

  if (parsed.pathname === "/watch") {
    return parsed.searchParams.get("v");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const knownVideoPath = ["embed", "shorts", "live"].includes(parts[0]);
  if (knownVideoPath) {
    return parts[1];
  }

  return null;
}

function ensureToolInstalled(name) {
  const result = spawnSync("which", [name], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`${name} is required but was not found on PATH.`);
  }
}

// fallow-ignore-next-line complexity
function runYtDlp({ canonicalUrl, videoId, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });

  const result = spawnSync(
    "yt-dlp",
    [
      "--skip-download",
      "--write-info-json",
      "--write-comments",
      "--paths",
      outDir,
      "-o",
      `${videoId}.%(ext)s`,
      canonicalUrl,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    throw new Error(`yt-dlp failed.\n${result.stderr || result.stdout}`);
  }

  const infoJsonPath = path.join(outDir, `${videoId}.info.json`);
  if (!fs.existsSync(infoJsonPath)) {
    throw new Error(`yt-dlp completed but did not create ${infoJsonPath}.`);
  }

  return {
    infoJsonPath,
    log: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

// fallow-ignore-next-line complexity
function normalizeComments(infoJsonPath) {
  const info = JSON.parse(fs.readFileSync(infoJsonPath, "utf8"));
  const comments = Array.isArray(info.comments) ? info.comments : [];

  // fallow-ignore-next-line complexity
  const normalizedComments = comments.map((comment) => ({
    id: comment.id ?? null,
    author: comment.author ?? "Unknown author",
    authorId: comment.author_id ?? null,
    authorUrl: comment.author_url ?? null,
    text: comment.text ?? "",
    likeCount: comment.like_count ?? 0,
    parent: comment.parent ?? "root",
    isPinned: Boolean(comment.is_pinned),
    isCreator: Boolean(comment.author_is_uploader),
    timestamp: comment.timestamp ?? null,
  }));

  return {
    video: {
      id: info.id,
      title: info.title,
      url: info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`,
      channel: info.channel ?? info.uploader ?? null,
      channelId: info.channel_id ?? null,
      handle: info.uploader_id ?? null,
      reportedCommentCount: info.comment_count ?? null,
      extractedCommentCount: normalizedComments.length,
    },
    comments: normalizedComments,
  };
}

export function categorizeComments(data) {
  const profile = detectClassificationProfile(data);
  const df = computeDocFreq(data.comments);
  const comments = data.comments.map((comment) => {
    const evaluation = classifyComment(comment, profile);
    evaluation.subcategory = deriveTopic(comment.text, df, data.comments.length);
    evaluation.context = deriveCommentContext({ comment, evaluation });
    return { ...comment, evaluation };
  });

  return {
    ...data,
    classification: {
      profile: profile.name,
      categories: summarizeClassifications(comments).categories,
      sentiments: summarizeClassifications(comments).sentiments,
      priorities: summarizeClassifications(comments).priorities,
    },
    comments,
  };
}

function detectClassificationProfile(data) {
  const corpus = `${data.video.title} ${data.comments.map((comment) => comment.text).join(" ")}`.toLowerCase();
  const profileScores = CLASSIFICATION_PROFILES.map((profile) => ({
    profile,
    score: profile.signals.reduce((sum, signal) => sum + (signal.test(corpus) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score);

  return profileScores[0]?.score > 0 ? profileScores[0].profile : GENERIC_PROFILE;
}

const MUNICIPAL_PROFILE = {
  name: "municipal-property",
  signals: [
    /\bcity\b|\bmunicipal\b|\btown\b|\bcounty\b/,
    /\bbill\b|\bfee\b|\bfine\b|\bcharge\b|\binvoice\b/,
    /\bpermit\b|\binspection\b|\bcode\b|\bordinance\b/,
    /\bproperty\b|\beasement\b|\bsewer\b|\bwater\b|\bdrain/,
  ],
  categories: [
    {
      category: "Municipal bill or process",
      intent: "process",
      sentiment: "concerned",
      priority: "high",
      reasons: ["city billing, fees, permitting, inspection, or code process"],
      pattern: /\bcity\b|\bmunicipal\b|\btown\b|\bcounty\b|\bbill\b|\bfee\b|\bfine\b|\bcharge\b|\binvoice\b|\bpermit\b|\binspection\b|\binspector\b|\bcode\b|\bordinance\b|\bviolation\b|\bpublic works\b/,
    },
    {
      category: "Legal or appeal advice",
      intent: "advice",
      sentiment: "concerned",
      priority: "high",
      reasons: ["legal escalation or formal appeal suggestion"],
      pattern: /\blawyer\b|\battorney\b|\bcourt\b|\blegal\b|\bsue\b|\bsuing\b|\bappeal\b|\bhearing\b|\bcouncil\b|\bmayor\b|\bombudsman\b|\blawsuit\b|\bclaim\b|\bdispute\b/,
    },
    {
      category: "Property or utility issue",
      intent: "diagnosis",
      sentiment: "neutral",
      priority: "medium",
      reasons: ["property, utility, drainage, road, or infrastructure detail"],
      pattern: /\bwater\b|\bsewer\b|\bdrain\b|\bditch\b|\bculvert\b|\broad\b|\bdriveway\b|\bproperty\b|\beasement\b|\bline\b|\bmeter\b|\bpipe\b|\bstreet\b|\bsidewalk\b/,
    },
    {
      category: "Contractor or professional advice",
      intent: "advice",
      sentiment: "neutral",
      priority: "medium",
      reasons: ["contractor, engineer, surveyor, or professional recommendation"],
      pattern: /\bcontractor\b|\bengineer\b|\bsurveyor\b|\bplumber\b|\belectrician\b|\bbuilder\b|\bquote\b|\blicensed\b|\bprofessional\b|\bestimate\b/,
    },
    {
      category: "Documentation or evidence advice",
      intent: "advice",
      sentiment: "neutral",
      priority: "medium",
      reasons: ["documentation, records, receipts, photos, or proof"],
      pattern: /\bdocument\b|\bpaperwork\b|\breceipt\b|\brecord\b|\bphoto\b|\bpictures\b|\bemail\b|\bcertified\b|\bproof\b|\bcopy\b|\bfile\b|\bkeep\b/,
    },
    {
      category: "Cost shock or fairness",
      intent: "reaction",
      sentiment: "concerned",
      priority: "medium",
      reasons: ["cost, fairness, or outrage reaction"],
      pattern: /\binsane\b|\bcrazy\b|\bridiculous\b|\bunfair\b|\bscam\b|\brobbery\b|\bexpensive\b|\bcost\b|\bpay\b|\b20,?000\b|\btwenty thousand\b|\bcorrupt\b/,
    },
    {
      category: "Similar personal experience",
      intent: "experience",
      sentiment: "neutral",
      priority: "medium",
      reasons: ["viewer reports a comparable situation"],
      pattern: /\bhappened\b|\bsame\b|\bmy city\b|\bmy town\b|\bwe had\b|\bi had\b|\bwhen i\b|\bwhere i live\b|\bin my area\b/,
    },
    {
      category: "Support or empathy",
      intent: "support",
      sentiment: "positive",
      priority: "low",
      reasons: ["empathy, encouragement, or support"],
      pattern: /\bsorry\b|\bfeel for\b|\bthat sucks\b|\bgood luck\b|\bhope\b|\bpraying\b|\bstay strong\b|\bhang in\b|\bwishing\b/,
    },
  ],
};

const HOMESTEAD_BUILD_PROFILE = {
  name: "homestead-build",
  signals: [
    /\bhomestead\b|\bhouse\b|\bhome\b|\bcottage\b|\bcasita\b/,
    /\bmexico\b|\bcanada\b|\bback home\b/,
    /\bdozer\b|\btractor\b|\bexcavator\b|\bskid\b|\bbush\s?hog\b/,
    /\bclearing\b|\bclear\b|\bforest\b|\btrail\b|\bvegetation\b|\bmulch/,
    /\bdrainage\b|\bhomesite\b|\bgrading\b|\bbuild\b|\bplans\b/,
  ],
  categories: [
    {
      category: "Land clearing or forestry",
      intent: "advice",
      sentiment: "neutral",
      priority: "medium",
      reasons: ["land clearing, vegetation, trails, forestry, or property maintenance"],
      pattern: /\bclear\b|\bclearing\b|\bvegetation\b|\bbush\s?hog\b|\bbrush\b|\bgoats?\b|\btrail\b|\btrails\b|\bforest\b|\bwoods\b|\bmulch\b|\bmulching\b|\bcut down\b|\blogs?\b|\btrees?\b|\bskiddie\b|\bskid\b/,
    },
    {
      category: "House build or design planning",
      intent: "planning",
      sentiment: "neutral",
      priority: "medium",
      reasons: ["house planning, site design, future build, accessibility, or layout"],
      pattern: /\bhouse\b|\bhome\b|\bcottage\b|\bbuild\b|\bbuilding\b|\bplans?\b|\bbedroom\b|\bbathroom\b|\bshower\b|\bbalcony\b|\bhomesite\b|\bfoundation\b|\bfront door\b|\bage in place\b|\bgrading\b|\bsite\b/,
    },
    {
      category: "Equipment, tools, or repairs",
      intent: "advice",
      sentiment: "neutral",
      priority: "medium",
      reasons: ["equipment, tool, machine, vehicle, or repair discussion"],
      pattern: /\bdozer\b|\btractor\b|\bexcavator\b|\bdeere\b|\btrack loader\b|\bclutch\b|\bdrone\b|\bmachine\b|\bparts?\b|\bserial\b|\bauto parts\b|\boperational\b|\brepair\b|\btool\b/,
    },
    {
      category: "Canada and Mexico project context",
      intent: "reaction",
      sentiment: "positive",
      priority: "low",
      reasons: ["viewer reaction to Canada, Mexico, casita, or project transition"],
      pattern: /\bmexico\b|\bcanada\b|\bcanadian\b|\bback home\b|\bhome now\b|\bcasita\b|\bfresh green\b|\bmaple\b|\bproject types\b|\bcontrast\b/,
    },
    {
      category: "Safety, health, or site risk",
      intent: "advice",
      sentiment: "concerned",
      priority: "high",
      reasons: ["health, safety, drainage, weather, or site risk"],
      pattern: /\bradon\b|\bair quality\b|\btest\b|\bsafety\b|\bsafe\b|\bstorm\b|\bdrainage\b|\bwater\b|\bretrofit\b|\bhydration\b|\belectrolyte\b|\brisk\b|\bhealthy\b|\bhealthier\b/,
    },
    {
      category: "City bill or cost reaction",
      intent: "reaction",
      sentiment: "concerned",
      priority: "medium",
      reasons: ["cost, city bill, money, or fairness reaction"],
      pattern: /\b20,?000\b|\btwenty thousand\b|\bbill\b|\bcity\b|\bmoney\b|\bcost\b|\bworth\b|\bexpensive\b|\bpay\b|\bfine\b|\bfee\b|\bunfair\b|\bscam\b/,
    },
    {
      category: "Future content question",
      intent: "request",
      sentiment: "positive",
      priority: "medium",
      reasons: ["viewer asks what comes next or requests a future episode"],
      pattern: /\bwhen do we see\b|\bwhat type\b|\bwhat'?s next\b|\bcan't wait\b|\bfull episode\b|\bepisode\b|\bplans\b|\bcan you\b|\bare you going\b|\bdid you know\b|\bhow about\b|\bwhere exactly\b/,
    },
    {
      category: "Audience support or praise",
      intent: "praise",
      sentiment: "positive",
      priority: "low",
      reasons: ["support, praise, greetings, encouragement, or community warmth"],
      pattern: /\blove\b|\bgreat\b|\bglad\b|\bcute\b|\bgo-getters\b|\bbless\b|\bgreetings\b|\bbeautiful\b|\bsmart decisions\b|\badmire\b|\bhappy\b|\bthanks?\b|\bty\b|\bwow\b|\bfans\b|\bfire\b|\bsending\b/,
    },
    {
      category: "Pets or family moment",
      intent: "reaction",
      sentiment: "positive",
      priority: "low",
      reasons: ["pet, family, or personal-life reaction"],
      pattern: /\bizzy\b|\bdog\b|\bpup\b|\bthundershirt\b|\bstorms\b|\bgirls\b|\bfamily\b|\blil' heart\b/,
    },
  ],
};

const AI_TOOLS_PROFILE = {
  name: "ai-tools",
  signals: [
    /\bclaude\b|\bgemini\b|\bcodex\b|\bai\b/,
    /\bzapier\b|\bmcp\b|\bconnector\b|\bconnectors\b/,
    /\bautomation\b|\bworkflow\b|\btool\b/,
  ],
  categories: [
    {
      category: "Risk or limitation concern",
      intent: "objection",
      sentiment: "concerned",
      priority: "high",
      reasons: ["safety concern or platform limitation"],
      pattern: /\brisky\b|\brisk\b|\blimit\b|\blimits\b|\blimitation\b|\brefused\b|\bprivacy\b|\bpermission\b|\bsecure\b/,
    },
    {
      category: "Setup troubleshooting",
      intent: "question",
      sentiment: "neutral",
      priority: "high",
      reasons: ["integration setup issue or support question"],
      pattern: /\bcan't see\b|\bconnected\b|\bconnector\b|\bsuggestions\b|\bdoing wrong\b|\bclosing claude\b|\bre-opening\b|\berror\b|\bsetup\b/,
    },
    {
      category: "Future content request",
      intent: "request",
      sentiment: "positive",
      priority: "medium",
      reasons: ["requested topic or content roadmap signal"],
      pattern: /\bkimi\b|\bmanus\b|\banother video\b|\bcompare\b|\bdeep dive\b|\bfuture\b|\bon the list\b|\bmake a video\b/,
    },
    {
      category: "Usage testimonial",
      intent: "experience",
      sentiment: "positive",
      priority: "medium",
      reasons: ["real workflow usage or product proof point"],
      pattern: /\busing\b|\bongoing tasks\b|\badd rows\b|\bgoogle docs\b|\bfind and replace\b|\bstrong tool\b|\bworks for me\b/,
    },
    {
      category: "Production or design question",
      intent: "question",
      sentiment: "positive",
      priority: "medium",
      reasons: ["video production or presentation tooling question"],
      pattern: /\boverlay\b|\banimation\b|\bpresentation\b|\bremotion\b|\bclaude design\b|\bwhat did you use\b/,
    },
    {
      category: "Positive feedback",
      intent: "praise",
      sentiment: "positive",
      priority: "low",
      reasons: ["viewer encouragement"],
      pattern: /\bgreat\b|\bgood stuff\b|\blove\b|\bneeded\b|\bthank\b|\bkeep it going\b|\bamazing\b|\bhelpful\b/,
    },
  ],
};

const GENERIC_PROFILE = {
  name: "generic",
  signals: [],
  categories: [
    {
      category: "Question or help request",
      intent: "question",
      sentiment: "neutral",
      priority: "high",
      reasons: ["explicit question or help request"],
      pattern: /\?|\bhow\b|\bwhat\b|\bwhy\b|\bwhere\b|\bwhen\b|\bcan you\b|\bdoes anyone\b|\bhelp\b|\badvice\b|\bsuggestion\b/,
    },
    {
      category: "Advice or recommendation",
      intent: "advice",
      sentiment: "neutral",
      priority: "medium",
      reasons: ["viewer suggests a next action"],
      pattern: /\bshould\b|\bneed to\b|\bhave to\b|\btry\b|\bcall\b|\bask\b|\bget\b|\bmake sure\b|\bdon't\b|\bnever\b/,
    },
    {
      category: "Personal experience",
      intent: "experience",
      sentiment: "neutral",
      priority: "medium",
      reasons: ["viewer shares a personal example"],
      pattern: /\bi had\b|\bmy\b|\bwe\b|\bwhen i\b|\bhappened to\b|\bwhere i live\b|\bin my\b/,
    },
    {
      category: "Concern or objection",
      intent: "objection",
      sentiment: "concerned",
      priority: "high",
      reasons: ["concern, warning, objection, or negative reaction"],
      pattern: /\brisk\b|\bwrong\b|\bbad\b|\bproblem\b|\bissue\b|\bcrazy\b|\bridiculous\b|\bunfair\b|\bscam\b|\bunsafe\b|\billegal\b/,
    },
    {
      category: "Positive feedback",
      intent: "praise",
      sentiment: "positive",
      priority: "low",
      reasons: ["viewer encouragement"],
      pattern: /\bgreat\b|\bgood\b|\blove\b|\bthank\b|\bthanks\b|\bamazing\b|\bawesome\b|\bhelpful\b|\bnice\b/,
    },
  ],
};

const CLASSIFICATION_PROFILES = [
  HOMESTEAD_BUILD_PROFILE,
  MUNICIPAL_PROFILE,
  AI_TOOLS_PROFILE,
];

// fallow-ignore-next-line complexity
function classifyComment(comment, profile) {
  const text = comment.text.toLowerCase();

  if (comment.isCreator && /#|partner|sponsor|affiliate|bit\.ly|start building|discount|promo/.test(text)) {
    return makeEvaluation("Creator promotion", "commercial", "neutral", "low", [
      "sponsored or promotional creator note",
    ]);
  }

  if (comment.isCreator) {
    return makeEvaluation("Creator reply", "response", "positive", "low", [
      "creator acknowledgement or answer",
    ]);
  }

  for (const category of profile.categories) {
    if (category.pattern.test(text)) {
      return makeEvaluation(category.category, category.intent, category.sentiment, category.priority, category.reasons);
    }
  }

  return makeEvaluation("General comment", "general", "neutral", "low", [
    "uncategorized",
  ]);
}

function makeEvaluation(category, intent, sentiment, priority, reasons) {
  return {
    category,
    intent,
    sentiment,
    priority,
    reasons,
  };
}

// Words too generic to make a useful topic (structural + YouTube-comment filler).
const TOPIC_STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "you", "your", "have", "has", "had", "are", "was", "were",
  "but", "not", "all", "can", "cant", "dont", "did", "does", "just", "like", "really", "very", "much",
  "more", "most", "some", "any", "from", "they", "them", "their", "there", "here", "what", "when", "where",
  "which", "who", "how", "why", "one", "two", "get", "got", "would", "could", "should", "will", "its",
  "about", "into", "out", "over", "than", "then", "been", "being", "because", "also", "even", "still",
  "only", "other", "these", "those", "such", "each", "our", "his", "her", "him", "she", "were", "yourself",
  // generic YouTube filler
  "video", "videos", "channel", "comment", "comments", "content", "watch", "watching", "subscribe",
  "subscriber", "subscribers", "great", "good", "nice", "love", "loved", "awesome", "amazing", "best",
  "thanks", "thank", "please", "guys", "guy", "man", "yeah", "yes", "lol", "haha", "wow", "omg", "new",
  "make", "made", "making", "need", "want", "know", "think", "thing", "things", "people", "time", "way",
  "lot", "big", "little", "first", "last", "every", "always", "never", "gonna", "wanna", "stuff",
  "pretty", "real", "actually", "definitely", "probably", "maybe", "keep", "going", "look", "looks",
  "looking", "see", "seen", "said", "say", "says", "use", "used", "using", "work", "works", "done",
  // URL fragments + apostrophe-collapsed contractions
  "https", "http", "www", "com", "youtube", "youtu", "dont", "cant", "wont", "youre", "theyre",
  "thats", "whats", "ive", "havent", "didnt", "doesnt", "isnt", "arent", "wasnt", "werent",
  "wouldnt", "couldnt", "shouldnt", "hasnt", "hadnt", "lets", "heres", "theres", "youve", "youll",
]);

function tokenizeTopic(text) {
  return String(text || "").toLowerCase().replace(/[^a-z\s']/g, " ").split(/\s+/)
    .map((w) => w.replace(/'/g, ""))
    .filter((w) => w.length >= 3 && !TOPIC_STOPWORDS.has(w));
}

// Document frequency: how many comments each word appears in (for topic salience).
function computeDocFreq(comments) {
  const df = new Map();
  for (const comment of comments) {
    for (const word of new Set(tokenizeTopic(comment.text))) {
      df.set(word, (df.get(word) || 0) + 1);
    }
  }
  return df;
}

// Summarize a comment's context into a 1-2 word topic. We want words that (a) recur across
// the corpus — so they're a real theme, not a typo — but (b) are SPECIFIC, not the handful
// of words common to almost every comment. So among recurring words we rank by ascending
// document frequency (rarer = more distinctive), keep reading order, and Title Case.
// fallow-ignore-next-line complexity
function deriveTopic(text, df, totalDocs = 0) {
  const words = tokenizeTopic(text);
  if (!words.length) return null;
  const order = [];
  const seen = new Set();
  for (const word of words) { if (!seen.has(word)) { seen.add(word); order.push(word); } }
  const freq = (w) => df.get(w) || 1;
  // Drop words so common they behave like corpus stopwords (in >35% of all comments).
  const ceiling = totalDocs > 0 ? Math.max(3, Math.floor(totalDocs * 0.35)) : Infinity;
  let pool = order.filter((w) => freq(w) >= 3 && freq(w) <= ceiling);
  if (!pool.length) pool = order.filter((w) => freq(w) >= 2 && freq(w) <= ceiling);
  if (!pool.length) pool = order.filter((w) => freq(w) <= ceiling);
  if (!pool.length) pool = order.slice();
  const top = new Set([...pool].sort((a, b) => freq(a) - freq(b) || b.length - a.length).slice(0, 2));
  const chosen = order.filter((w) => top.has(w)).slice(0, 2);
  return chosen.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function summarizeClassifications(comments) {
  const summary = {
    categories: {},
    sentiments: {},
    priorities: {},
  };

  for (const comment of comments) {
    increment(summary.categories, comment.evaluation.category);
    increment(summary.sentiments, comment.evaluation.sentiment);
    increment(summary.priorities, comment.evaluation.priority);
  }

  return summary;
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function writeNormalizedJson(data, outDir, videoId) {
  const commentsJsonPath = path.join(outDir, `${videoId}.comments.json`);
  fs.writeFileSync(commentsJsonPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return commentsJsonPath;
}

function writeHtml(data, outDir, videoId) {
  const htmlPath = path.join(outDir, `${videoId}.comments.html`);
  fs.writeFileSync(htmlPath, renderHtml(data), "utf8");
  return htmlPath;
}

// fallow-ignore-next-line complexity
export function loadCategorizedJson(jsonPath) {
  if (!jsonPath) {
    throw new Error("Missing comments JSON path.");
  }
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`File not found: ${jsonPath}`);
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  if (!data.video?.id || !Array.isArray(data.comments)) {
    throw new Error(`${jsonPath} is not a generated comments JSON file.`);
  }
  const categorized = data.classification ? data : categorizeComments(data);
  return ensureContexts(ensureSubcategories(categorized));
}

// Backfill 1-3 word topics onto comments that predate the sub-category feature, so a plain
// HTML refresh (--from-json) surfaces them without re-downloading.
// fallow-ignore-next-line complexity
function ensureSubcategories(data) {
  const needsFill = data.comments.some((c) => c.evaluation && c.evaluation.subcategory === undefined);
  if (!needsFill) return data;
  const df = computeDocFreq(data.comments);
  for (const comment of data.comments) {
    if (comment.evaluation && comment.evaluation.subcategory === undefined) {
      comment.evaluation.subcategory = deriveTopic(comment.text, df, data.comments.length);
    }
  }
  return data;
}

// Legacy reports are upgraded in memory for rendering/import preparation. The source
// JSON is never rewritten by --from-json.
function ensureContexts(data) {
  for (const comment of data.comments) {
    if (!comment.evaluation) {
      comment.evaluation = makeEvaluation("General comment", "general", "neutral", "low", [
        "legacy comment without classification",
      ]);
    }
    comment.evaluation.context = resolveCommentContext(comment);
  }
  return data;
}

function renderHtml(data) {
  const payload = JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.video.title)} - YouTube Comments</title>
  <style>
    :root {
      --bg: #f6f7f9;
      --panel: #fff;
      --ink: #17191f;
      --muted: #667085;
      --line: #dde3ea;
      --accent: #0f766e;
      --accent-soft: #d9f3ef;
      --warn: #a85512;
      --warn-soft: #fff1d6;
      --shadow: 0 16px 45px rgba(25, 31, 44, 0.10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at 16% 8%, rgba(15, 118, 110, 0.10), transparent 28rem), linear-gradient(135deg, #f9fafb 0%, var(--bg) 44%, #eef4f5 100%);
      color: var(--ink);
    }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 38px 0 54px; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 22px; align-items: end; margin-bottom: 22px; }
    .eyebrow { margin: 0 0 9px; color: var(--accent); font-size: 0.78rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
    h1 { margin: 0; max-width: 820px; font-size: clamp(2rem, 5vw, 4.4rem); line-height: 0.98; letter-spacing: 0; }
    .source { margin: 14px 0 0; color: var(--muted); overflow-wrap: anywhere; }
    .source a { color: var(--accent); font-weight: 700; }
    .summary { display: grid; grid-template-columns: repeat(3, minmax(104px, 1fr)); gap: 10px; min-width: 330px; }
    .metric { min-height: 86px; padding: 15px 16px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 255, 255, 0.74); box-shadow: 0 8px 24px rgba(30, 41, 59, 0.06); }
    .metric strong { display: block; font-size: 1.7rem; line-height: 1; }
    .metric span { display: block; margin-top: 8px; color: var(--muted); font-size: 0.82rem; }
    .toolbar { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; margin: 22px 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 255, 255, 0.86); backdrop-filter: blur(16px); box-shadow: 0 10px 30px rgba(30, 41, 59, 0.07); }
    .search { width: 100%; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: #fff; font: inherit; }
    .search:focus { outline: 2px solid rgba(15, 118, 110, 0.24); border-color: var(--accent); }
    .toggle { display: inline-flex; align-items: center; gap: 9px; min-height: 44px; padding: 0 13px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: #fff; white-space: nowrap; cursor: pointer; user-select: none; }
    .toggle input { accent-color: var(--accent); }
    .grid { position: relative; isolation: isolate; display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; overflow: visible; }
    .mindmap { margin: 22px 0; padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 255, 255, 0.84); box-shadow: var(--shadow); overflow: hidden; }
    .mindmap h2 { margin: 0 0 16px; font-size: 1rem; }
    .mindmap-graph { position: relative; isolation: isolate; min-height: 520px; border: 1px solid var(--line); border-radius: 8px; background: linear-gradient(135deg, #ffffff 0%, #f7fbfb 100%); overflow: visible; }
    .mindmap-graph svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .map-link { stroke: rgba(15, 118, 110, 0.34); stroke-width: 0.42; vector-effect: non-scaling-stroke; }
    .map-link.major { stroke: rgba(15, 118, 110, 0.62); stroke-width: 0.72; }
    .map-node { position: absolute; left: var(--x); top: var(--y); z-index: 1; width: min(210px, 38vw); min-height: 92px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 255, 255, 0.96); box-shadow: 0 12px 30px rgba(30, 41, 59, 0.10); transform: translate(-50%, -50%); }
    .map-node[role="button"] { cursor: pointer; transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
    .map-node[role="button"]:hover, .map-node[role="button"]:focus-visible { z-index: 999; border-color: rgba(15, 118, 110, 0.48); box-shadow: 0 24px 64px rgba(15, 118, 110, 0.24); transform: translate(-50%, -50%) scale(1.055); }
    .map-node[role="button"]:focus-visible { outline: 3px solid rgba(15, 118, 110, 0.28); outline-offset: 3px; }
    .map-node.active { z-index: 20; border-color: var(--accent); box-shadow: 0 20px 50px rgba(15, 118, 110, 0.24); }
    .map-node.core { display: grid; place-items: center; width: 188px; min-height: 128px; border: 0; color: #fff; background: linear-gradient(135deg, #0f766e, #334155); text-align: center; box-shadow: 0 18px 42px rgba(15, 23, 42, 0.22); }
    .map-node.core.active { box-shadow: 0 20px 54px rgba(15, 23, 42, 0.30); }
    .map-node.major { border-color: rgba(15, 118, 110, 0.42); box-shadow: 0 18px 40px rgba(15, 118, 110, 0.16); }
    .map-node strong { display: block; padding-right: 38px; font-size: 0.88rem; line-height: 1.18; }
    .map-node small { display: block; margin-top: 8px; color: var(--muted); line-height: 1.32; }
    .map-node.core strong { padding: 0; font-size: 1.02rem; }
    .map-node.core small { color: rgba(255, 255, 255, 0.78); }
    .map-count { position: absolute; right: 10px; top: 10px; display: grid; place-items: center; min-width: 30px; height: 30px; border-radius: 999px; color: var(--accent); background: var(--accent-soft); font-weight: 850; }
    .filter-state { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 14px 0 0; color: var(--muted); font-size: 0.86rem; }
    .filter-state strong { color: var(--ink); }
    .clear-filter { min-height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--accent); background: #fff; font: inherit; font-weight: 800; cursor: pointer; }
    .clear-filter:hover { border-color: var(--accent); }
    .theme-view { margin: 22px 0; padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 255, 255, 0.84); box-shadow: var(--shadow); overflow: hidden; }
    .theme-view h2 { margin: 0 0 6px; font-size: 1rem; }
    .theme-view > p { margin: 0 0 16px; color: var(--muted); font-size: 0.88rem; }
    .theme-board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(280px, 340px); gap: 14px; overflow-x: auto; padding: 2px 2px 14px; scroll-snap-type: x proximity; }
    .theme-lane { display: flex; flex-direction: column; min-height: 360px; border: 1px solid var(--line); border-radius: 8px; background: #fff; scroll-snap-align: start; }
    .lane-header { position: sticky; top: 0; z-index: 1; padding: 13px; border-bottom: 1px solid var(--line); background: rgba(255, 255, 255, 0.96); }
    .lane-header strong { display: block; padding-right: 42px; font-size: 0.94rem; line-height: 1.2; }
    .lane-header span { position: absolute; right: 12px; top: 12px; display: grid; place-items: center; min-width: 30px; height: 30px; border-radius: 999px; color: var(--accent); background: var(--accent-soft); font-weight: 850; }
    .lane-items { display: grid; gap: 10px; padding: 12px; }
    .lane-thread { width: 100%; min-height: 118px; padding: 11px; border: 1px solid var(--line); border-radius: 8px; background: #f9fbfb; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
    .lane-thread:hover, .lane-thread:focus-visible { border-color: rgba(15, 118, 110, 0.46); box-shadow: 0 16px 36px rgba(15, 118, 110, 0.16); transform: translateY(-3px); outline: none; }
    .lane-thread strong { display: block; margin-bottom: 6px; overflow-wrap: anywhere; font-size: 0.84rem; }
    .lane-thread p { display: -webkit-box; margin: 0; overflow: hidden; color: #344054; font-size: 0.84rem; line-height: 1.38; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
    .lane-thread small { display: block; margin-top: 9px; color: var(--muted); font-size: 0.76rem; }
    .neo4j-view { margin: 22px 0; padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: #101828; color: #f8fafc; box-shadow: var(--shadow); overflow: hidden; }
    .neo4j-head { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: start; margin-bottom: 16px; }
    .neo4j-head h2 { margin: 0 0 6px; font-size: 1rem; }
    .neo4j-head p { margin: 0; max-width: 720px; color: #cbd5e1; font-size: 0.88rem; line-height: 1.45; }
    .neo4j-link { display: inline-flex; align-items: center; min-height: 38px; padding: 0 12px; border: 1px solid rgba(45, 212, 191, 0.42); border-radius: 8px; color: #99f6e4; background: rgba(15, 118, 110, 0.16); font-weight: 800; text-decoration: none; white-space: nowrap; }
    .neo4j-stats { display: grid; grid-template-columns: repeat(6, minmax(104px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .neo4j-stat { min-height: 76px; padding: 12px; border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 8px; background: rgba(255, 255, 255, 0.06); }
    .neo4j-stat strong { display: block; color: #fff; font-size: 1.35rem; line-height: 1; }
    .neo4j-stat span { display: block; margin-top: 8px; color: #cbd5e1; font-size: 0.78rem; }
    .neo4j-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .cypher-card { min-width: 0; padding: 13px; border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 8px; background: rgba(255, 255, 255, 0.06); }
    .cypher-card h3 { margin: 0 0 9px; color: #fff; font-size: 0.9rem; }
    .cypher-card pre { margin: 0; min-height: 116px; overflow: auto; color: #d1fae5; font-size: 0.78rem; line-height: 1.45; white-space: pre-wrap; }
    .copy-cypher { margin-top: 11px; min-height: 34px; padding: 0 10px; border: 1px solid rgba(45, 212, 191, 0.38); border-radius: 8px; color: #99f6e4; background: transparent; font: inherit; font-size: 0.82rem; font-weight: 800; cursor: pointer; }
    .copy-cypher:hover { background: rgba(45, 212, 191, 0.12); }
    .neo4j-graph { margin-top: 16px; border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 8px; background: rgba(2, 6, 23, 0.45); overflow: hidden; }
    .neo4j-graph-head { display: flex; flex-wrap: wrap; gap: 12px 18px; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); }
    .neo4j-graph-head h3 { margin: 0; color: #fff; font-size: 0.9rem; }
    .neo4j-graph-head p { margin: 3px 0 0; color: #94a3b8; font-size: 0.76rem; max-width: 560px; }
    .graph-legend { display: flex; flex-wrap: wrap; gap: 9px 14px; }
    .graph-legend span { display: inline-flex; align-items: center; gap: 6px; color: #cbd5e1; font-size: 0.74rem; }
    .graph-legend i { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
    .neo4j-graph svg { display: block; width: 100%; height: 460px; background: radial-gradient(circle at 50% 42%, rgba(30, 41, 59, 0.55), rgba(2, 6, 23, 0.15)); cursor: grab; touch-action: none; }
    .graph-edge { stroke: rgba(148, 163, 184, 0.32); stroke-width: 1; }
    .graph-node circle { stroke: rgba(15, 23, 42, 0.85); stroke-width: 1.5; cursor: grab; transition: stroke 120ms ease; }
    .graph-node text { fill: #e2e8f0; font-size: 9px; pointer-events: none; paint-order: stroke; stroke: rgba(2, 6, 23, 0.85); stroke-width: 2.4px; }
    .graph-node:hover circle { stroke: #fff; }
    .comment-focus { animation: commentFocusFlash 2.2s ease; border-radius: 8px; }
    @keyframes commentFocusFlash {
      0% { background: rgba(76, 142, 218, 0.22); box-shadow: 0 0 0 3px rgba(76, 142, 218, 0.85); }
      100% { background: transparent; box-shadow: 0 0 0 0 rgba(76, 142, 218, 0); }
    }
    .graph-controls { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .graph-reset { min-height: 30px; padding: 0 11px; border: 1px solid rgba(148, 163, 184, 0.35); border-radius: 7px; background: rgba(255, 255, 255, 0.06); color: #e2e8f0; font: inherit; font-size: 0.76rem; font-weight: 700; cursor: pointer; }
    .graph-reset:hover { background: rgba(255, 255, 255, 0.12); }
    .graph-node, .graph-edge { transition: opacity 130ms ease; }
    .graph-node.dim { opacity: 0.12; }
    .graph-edge.dim { opacity: 0.06; }
    .graph-edge.hot { stroke: rgba(148, 197, 255, 0.92); stroke-width: 1.6; }
    .graph-node.hot circle { stroke: #fff; stroke-width: 2.4px; }
    .card { position: relative; z-index: 1; min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 255, 255, 0.9); box-shadow: var(--shadow); overflow: hidden; transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease; }
    .card:hover, .card:focus-within { z-index: 999; border-color: rgba(15, 118, 110, 0.38); box-shadow: 0 30px 80px rgba(25, 31, 44, 0.24); transform: translateY(-8px) scale(1.015); }
    .card-header { display: grid; grid-template-columns: 46px 1fr auto; gap: 12px; align-items: center; padding: 16px; border-bottom: 1px solid var(--line); }
    .avatar { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 50%; color: #fff; background: linear-gradient(135deg, #0f766e, #334155); font-weight: 800; }
    .author { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 1rem; font-weight: 800; }
    .meta { margin: 4px 0 0; color: var(--muted); font-size: 0.84rem; }
    .badge { align-self: start; padding: 6px 9px; border-radius: 999px; color: var(--accent); background: var(--accent-soft); font-size: 0.76rem; font-weight: 800; white-space: nowrap; }
    .badge.creator { color: var(--warn); background: var(--warn-soft); }
    .comments { display: grid; gap: 10px; padding: 14px; }
    blockquote { margin: 0; padding: 12px 13px; border-left: 3px solid var(--accent); border-radius: 7px; color: #252a33; background: #f9fbfb; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }
    .thread-root blockquote { border-left-color: #334155; background: #fff; }
    .reply-stack { display: grid; gap: 10px; margin-left: 18px; padding-left: 18px; border-left: 2px solid rgba(15, 118, 110, 0.32); }
    .reply-item { position: relative; }
    .reply-item::before { content: ""; position: absolute; left: -18px; top: 22px; width: 18px; height: 2px; background: rgba(15, 118, 110, 0.32); }
    .reply-author { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 6px; color: var(--muted); font-size: 0.8rem; font-weight: 750; }
    .comment-match blockquote { border-left-color: var(--warn); background: #fffbeb; }
    .thread-pair { display: grid; gap: 0; }
    .parent-context { position: relative; margin: 0 0 0 13px; padding: 11px 12px 11px 16px; border: 1px solid var(--line); border-left: 3px solid #94a3b8; border-radius: 7px; color: #475467; background: #fff; line-height: 1.38; overflow-wrap: anywhere; white-space: pre-wrap; }
    .parent-context strong { display: block; margin-bottom: 6px; color: var(--ink); font-size: 0.78rem; }
    .thread-connector { width: 2px; height: 22px; margin-left: 27px; background: linear-gradient(180deg, #94a3b8, var(--accent)); }
    .thread-pair blockquote { border-left-color: var(--accent); }
    .comment-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; color: var(--muted); font-size: 0.78rem; }
    .tag { display: inline-flex; align-items: center; min-height: 23px; padding: 0 8px; border-radius: 999px; color: var(--accent); background: var(--accent-soft); font-weight: 750; }
    .tag.topic { color: #a855f7; background: rgba(168, 85, 247, 0.12); }
    .tag.topic::before { content: "#"; opacity: 0.6; margin-right: 1px; }
    .tag.priority-high { color: #b42318; background: #fee4e2; }
    .tag.priority-medium { color: #92400e; background: #fef3c7; }
    .empty { display: none; padding: 28px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); background: rgba(255, 255, 255, 0.72); text-align: center; }
    @media (max-width: 760px) {
      header, .toolbar { grid-template-columns: 1fr; }
      .summary { min-width: 0; }
      .neo4j-head, .neo4j-grid { grid-template-columns: 1fr; }
      .neo4j-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .mindmap-graph { min-height: 760px; }
      .map-node { width: min(230px, 68vw); }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <p class="eyebrow">YouTube comment review</p>
        <h1>${escapeHtml(data.video.title)}</h1>
        <p class="source"><a href="${escapeHtml(data.video.url)}">${escapeHtml(data.video.url)}</a></p>
      </div>
      <section class="summary" aria-label="Comment summary">
        <div class="metric"><strong id="totalComments">0</strong><span>comments</span></div>
        <div class="metric"><strong id="totalAuthors">0</strong><span>authors</span></div>
        <div class="metric"><strong id="creatorReplies">0</strong><span>creator comments</span></div>
      </section>
    </header>
    <section class="toolbar" aria-label="Filters">
      <input id="search" class="search" type="search" placeholder="Search authors or comments">
      <label class="toggle"><input id="creatorOnly" type="checkbox"> Creator only</label>
    </section>
    <section class="mindmap" aria-label="Comment classification mindmap">
      <h2>Comment Classification Mindmap</h2>
      <div id="mindmapGraph" class="mindmap-graph"></div>
      <div class="filter-state" aria-live="polite">
        <span id="categoryFilterState">Showing all classifications</span>
        <button id="clearCategoryFilter" class="clear-filter" type="button" hidden>Show all</button>
      </div>
    </section>
    <section class="theme-view" aria-label="Theme lanes">
      <h2>Theme Lanes</h2>
      <p>Scan categories as lanes, then jump into the matching conversation threads.</p>
      <div id="themeBoard" class="theme-board"></div>
    </section>
    <section class="neo4j-view" aria-label="Neo4j graph database">
      <div class="neo4j-head">
        <div>
          <h2>Neo4j Graph Database</h2>
          <p>This report is loaded into Neo4j as videos, authors, comments, replies, categories, and the classification profile. Queries are shown here for Neo4j Browser; the HTML does not expose database credentials.</p>
        </div>
        <a class="neo4j-link" href="http://localhost:7474" target="_blank" rel="noreferrer">Open Neo4j Browser</a>
      </div>
      <div id="neo4jStats" class="neo4j-stats"></div>
      <div id="cypherQueries" class="neo4j-grid"></div>
      <div id="neo4jGraph" class="neo4j-graph" hidden>
        <div class="neo4j-graph-head">
          <div>
            <h3>Graph Preview</h3>
            <p>A representative subgraph built in the browser from this report's data &mdash; no database connection. Drag a node, or drag the background to pan; scroll to zoom; hover to highlight neighbors. Click a comment node to jump to its card, or a category node to filter the cards. Run the "Video Comment Graph" Cypher above to see the full graph in Neo4j Browser.</p>
          </div>
          <div class="graph-controls">
            <div id="graphLegend" class="graph-legend"></div>
            <button id="graphReset" class="graph-reset" type="button" hidden>Reset view</button>
          </div>
        </div>
      </div>
    </section>
    <section id="cards" class="grid" aria-live="polite"></section>
    <p id="empty" class="empty">No comments match the current filter.</p>
  </main>
  <script>
    const data = ${payload};
    const comments = data.comments;
    const commentById = new Map(comments.map((comment) => [comment.id, comment]));
    const threads = buildThreads(comments);
    const cards = document.querySelector("#cards");
    const empty = document.querySelector("#empty");
    const search = document.querySelector("#search");
    const creatorOnly = document.querySelector("#creatorOnly");
    const mindmapGraph = document.querySelector("#mindmapGraph");
    const themeBoard = document.querySelector("#themeBoard");
    const neo4jStats = document.querySelector("#neo4jStats");
    const cypherQueries = document.querySelector("#cypherQueries");
    const categoryFilterState = document.querySelector("#categoryFilterState");
    const clearCategoryFilter = document.querySelector("#clearCategoryFilter");
    let selectedCategory = null;

    document.querySelector("#totalComments").textContent = comments.length;
    document.querySelector("#totalAuthors").textContent = new Set(comments.map((comment) => comment.author)).size;
    document.querySelector("#creatorReplies").textContent = comments.filter((comment) => comment.isCreator).length;

    const categoryDescriptions = {
      "Creator promotion": "Sponsored or call-to-action content from the creator.",
      "Creator reply": "Creator acknowledgements, answers, or follow-up notes.",
      "Risk or limitation concern": "Safety, connector, model limitation, or reliability concerns.",
      "Setup troubleshooting": "Questions about getting Zapier MCP or Claude connectors working.",
      "Future content request": "Requested follow-up videos, comparisons, or deeper examples.",
      "Usage testimonial": "Viewer reports of real-world Zapier MCP usage.",
      "Production or design question": "Questions about overlays, animation, or presentation tooling.",
      "Positive feedback": "Praise, encouragement, and general approval.",
      "Canada and Mexico project context": "Viewer reactions to the project shift between Canada and Mexico.",
      "Equipment, tools, or repairs": "Machines, tools, repairs, parts, and operating advice.",
      "Audience support or praise": "Encouragement, praise, greetings, and community warmth.",
      "House build or design planning": "House plans, site planning, structure, layout, and future build choices.",
      "Land clearing or forestry": "Brush, trees, trails, vegetation, clearing, and land maintenance.",
      "Safety, health, or site risk": "Safety, storms, drainage, health, and risk-reduction comments.",
      "City bill or cost reaction": "Cost, bill, tax, fee, and fairness reactions.",
      "Future content question": "Questions or requests about what comes next.",
      "Pets or family moment": "Pet, family, or personal-life reactions.",
      "General comment": "Comments that do not fit the stronger categories."
    };

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function getInitials(author) {
      return author.replace("@", "").slice(0, 2).toUpperCase() || "?";
    }

    function buildThreads(items) {
      const roots = [];
      const repliesByParent = new Map();

      for (const item of items) {
        if (item.parent === "root") {
          roots.push(item);
          continue;
        }

        const replies = repliesByParent.get(item.parent) || [];
        replies.push(item);
        repliesByParent.set(item.parent, replies);
      }

      const threadList = roots.map((root) => ({
        id: root.id,
        root,
        replies: repliesByParent.get(root.id) || [],
      }));

      const knownRootIds = new Set(roots.map((root) => root.id));
      for (const item of items) {
        if (item.parent !== "root" && !knownRootIds.has(item.parent)) {
          threadList.push({
            id: item.id,
            root: item,
            replies: [],
          });
        }
      }

      return threadList;
    }

    function matchesCurrentFilters(comment, query) {
      const matchesText = \`\${comment.author} \${comment.text}\`.toLowerCase().includes(query);
      const matchesCreator = !creatorOnly.checked || comment.isCreator;
      const matchesCategory = !selectedCategory || comment.evaluation.category === selectedCategory;
      return matchesText && matchesCreator && matchesCategory;
    }

    function render() {
      const query = search.value.trim().toLowerCase();
      const visibleThreads = threads
        .map((thread) => {
          const threadComments = [thread.root, ...thread.replies];
          const matchingComments = threadComments.filter((comment) => matchesCurrentFilters(comment, query));
          return {
            ...thread,
            matchingComments,
          };
        })
        .filter((thread) => thread.matchingComments.length > 0);

      cards.innerHTML = visibleThreads.map((thread) => renderThreadCard(thread)).join("");

      empty.style.display = visibleThreads.length ? "none" : "block";
      const visibleCommentCount = visibleThreads.reduce((sum, thread) => sum + thread.matchingComments.length, 0);
      updateFilterState(visibleCommentCount, visibleThreads.length);
    }

    function renderThreadCard(thread) {
      const root = thread.root;
      const threadComments = [root, ...thread.replies];
      const matchingIds = new Set(thread.matchingComments.map((comment) => comment.id));
      const totalLikes = threadComments.reduce((sum, item) => sum + item.likeCount, 0);
      const replyLabel = thread.replies.length === 1 ? "reply" : "replies";
      const matchedLabel = thread.matchingComments.length === 1 ? "match" : "matches";
      const rootMatches = matchingIds.has(root.id);

      return \`
        <article class="card">
          <div class="card-header">
            <div class="avatar" aria-hidden="true">\${escapeHtml(getInitials(root.author))}</div>
            <div>
              <h2 class="author">\${escapeHtml(root.author)}</h2>
              <p class="meta">Thread · \${thread.replies.length} \${replyLabel} · \${thread.matchingComments.length} \${matchedLabel} · \${totalLikes} total likes</p>
            </div>
            <span class="badge \${root.isCreator ? "creator" : ""}">\${root.isCreator ? "Creator" : "Viewer"}</span>
          </div>
          <div class="comments">
            <article id="comment-\${escapeHtml(root.id)}" class="thread-root \${rootMatches ? "comment-match" : ""}">
              \${renderCommentBlock(root, "Original comment")}
            </article>
            \${thread.replies.length ? \`
              <div class="reply-stack">
                \${thread.replies.map((reply) => \`
                  <article id="comment-\${escapeHtml(reply.id)}" class="reply-item \${matchingIds.has(reply.id) ? "comment-match" : ""}">
                    <p class="reply-author">Reply from \${escapeHtml(reply.author)} \${reply.isCreator ? '<span class="tag">Creator</span>' : ""}</p>
                    \${renderCommentBlock(reply, "Reply")}
                  </article>
                \`).join("")}
              </div>
            \` : ""}
          </div>
        </article>
      \`;
    }

    function renderCommentBlock(item, label) {
      const likeLabel = \`\${item.likeCount} \${item.likeCount === 1 ? "like" : "likes"}\`;
      const priorityClass = \`priority-\${item.evaluation.priority}\`;

      return \`
        <blockquote>\${escapeHtml(item.text)}</blockquote>
        <div class="comment-meta">
          <span>\${label}</span>
          <span>\${likeLabel}</span>
          <span class="tag">\${escapeHtml(item.evaluation.category)}</span>
          \${item.evaluation.subcategory ? \`<span class="tag topic" title="Topic — a 1-3 word summary of this comment">\${escapeHtml(item.evaluation.subcategory)}</span>\` : ""}
          <span class="tag \${priorityClass}">\${escapeHtml(item.evaluation.priority)} priority</span>
        </div>
      \`;
    }

    function renderMindmap() {
      const categories = Object.entries(data.classification.categories)
        .sort((a, b) => b[1] - a[1]);
      const center = { x: 50, y: 50 };
      const radiusX = 36;
      const radiusY = 34;
      const maxCount = Math.max(...categories.map(([, count]) => count), 1);
      const links = [];
      const nodes = categories.map(([category, count], index) => {
        const angle = -Math.PI / 2 + (index * Math.PI * 2) / categories.length;
        const x = center.x + Math.cos(angle) * radiusX;
        const y = center.y + Math.sin(angle) * radiusY;
        const isMajor = count >= Math.max(2, Math.ceil(maxCount * 0.35));
        links.push(\`<line class="map-link \${isMajor ? "major" : ""}" x1="\${center.x}" y1="\${center.y}" x2="\${x}" y2="\${y}"></line>\`);
        return \`
          <article class="map-node \${isMajor ? "major" : ""}" style="--x: \${x}%; --y: \${y}%;" role="button" tabindex="0" data-category="\${escapeHtml(category)}" aria-label="Show only \${escapeHtml(category)} comments">
            <strong>\${escapeHtml(category)}</strong>
            <span class="map-count">\${count}</span>
            <small>\${escapeHtml(categoryDescriptions[category] || "Detected audience signal.")}</small>
          </article>
        \`;
      }).join("");

      document.querySelector("#mindmapGraph").innerHTML = \`
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">\${links.join("")}</svg>
        <article class="map-node core active" style="--x: \${center.x}%; --y: \${center.y}%;" role="button" tabindex="0" data-category="" aria-label="Show all comments">
          <div>
            <strong>Audience Signals</strong>
            <small>\${comments.length} classified comments</small>
          </div>
        </article>
        \${nodes}
      \`;
    }

    function renderThemeBoard() {
      const categories = Object.entries(data.classification.categories)
        .sort((a, b) => b[1] - a[1]);

      themeBoard.innerHTML = categories.map(([category, count]) => {
        const categoryThreads = threads
          .map((thread) => {
            const threadComments = [thread.root, ...thread.replies];
            const matches = threadComments.filter((comment) => comment.evaluation.category === category);
            return { ...thread, matches };
          })
          .filter((thread) => thread.matches.length > 0)
          .sort((a, b) => b.matches.length - a.matches.length || b.root.likeCount - a.root.likeCount)
          .slice(0, 6);

        const items = categoryThreads.map((thread) => {
          const preview = thread.matches[0] || thread.root;
          const replyLabel = thread.replies.length === 1 ? "reply" : "replies";
          return \`
            <button class="lane-thread" type="button" data-category="\${escapeHtml(category)}">
              <strong>\${escapeHtml(thread.root.author)}</strong>
              <p>\${escapeHtml(preview.text)}</p>
              <small>\${thread.matches.length} category matches · \${thread.replies.length} \${replyLabel}</small>
            </button>
          \`;
        }).join("");

        return \`
          <section class="theme-lane">
            <div class="lane-header">
              <strong>\${escapeHtml(category)}</strong>
              <span>\${count}</span>
            </div>
            <div class="lane-items">\${items}</div>
          </section>
        \`;
      }).join("");
    }

    function renderNeo4jPanel() {
      const rootComments = comments.filter((comment) => comment.parent === "root").length;
      const replyEdges = comments.filter((comment) => comment.parent !== "root").length;
      const authorCount = new Set(comments.map((comment) => comment.authorId || comment.author)).size;
      const categoryCount = Object.keys(data.classification.categories).length;
      const stats = [
        ["1", "video"],
        [comments.length, "comments"],
        [authorCount, "authors"],
        [rootComments, "root comments"],
        [replyEdges, "reply edges"],
        [categoryCount, "categories"],
      ];

      neo4jStats.innerHTML = stats.map(([value, label]) => \`
        <div class="neo4j-stat"><strong>\${value}</strong><span>\${escapeHtml(label)}</span></div>
      \`).join("");

      const videoId = data.video.id.replaceAll("'", "\\\\'");
      const queries = [
        {
          title: "Category Counts",
          cypher: \`MATCH (category:CommentCategory)<-[:IN_CATEGORY]-(comment:YouTubeComment)
RETURN category.name AS category, count(comment) AS comments
ORDER BY comments DESC;\`,
        },
        {
          title: "Video Comment Graph",
          cypher: \`MATCH (video:YouTubeVideo {id: '\${videoId}'})-[:HAS_COMMENT]->(comment:YouTubeComment)
OPTIONAL MATCH (author:YouTubeAuthor)-[:WROTE]->(comment)
RETURN video, author, comment
LIMIT 75;\`,
        },
        {
          title: "Reply Threads",
          cypher: \`MATCH (reply:YouTubeComment)-[:REPLY_TO]->(parent:YouTubeComment)
OPTIONAL MATCH (author:YouTubeAuthor)-[:WROTE]->(reply)
RETURN parent, reply, author
LIMIT 75;\`,
        },
      ];

      cypherQueries.innerHTML = queries.map((query, index) => \`
        <article class="cypher-card">
          <h3>\${escapeHtml(query.title)}</h3>
          <pre><code>\${escapeHtml(query.cypher)}</code></pre>
          <button class="copy-cypher" type="button" data-query-index="\${index}">Copy Cypher</button>
        </article>
      \`).join("");

      cypherQueries.addEventListener("click", async (event) => {
        const button = event.target.closest(".copy-cypher");
        if (!button) return;
        const query = queries[Number(button.getAttribute("data-query-index"))]?.cypher;
        if (!query) return;
        try {
          await navigator.clipboard.writeText(query);
          button.textContent = "Copied";
          setTimeout(() => { button.textContent = "Copy Cypher"; }, 1400);
        } catch {
          button.textContent = "Copy failed";
          setTimeout(() => { button.textContent = "Copy Cypher"; }, 1400);
        }
      });
    }

    function renderNeo4jGraph() {
      const container = document.querySelector("#neo4jGraph");
      if (!container) return;
      const SVG_NS = "http://www.w3.org/2000/svg";
      const W = 820, H = 460;
      const palette = {
        YouTubeVideo: "#f2545b",
        ClassificationProfile: "#f5a623",
        CommentCategory: "#a879e6",
        YouTubeComment: "#4c8eda",
        YouTubeAuthor: "#57c7a3",
      };
      const radiusFor = {
        YouTubeVideo: 24, ClassificationProfile: 17,
        CommentCategory: 15, YouTubeComment: 7, YouTubeAuthor: 7,
      };

      const nodes = [];
      const nodeIndex = new Map();
      function addNode(id, label, caption) {
        if (nodeIndex.has(id)) return nodeIndex.get(id);
        const seed = nodes.length;
        const node = {
          id: id, label: label, caption: caption || id,
          r: radiusFor[label] || 7,
          x: W / 2 + Math.cos(seed) * (60 + seed),
          y: H / 2 + Math.sin(seed) * (60 + seed * 0.6),
          vx: 0, vy: 0, fixed: false,
        };
        nodeIndex.set(id, node);
        nodes.push(node);
        return node;
      }
      const edges = [];
      function addEdge(a, b, type) {
        if (!nodeIndex.has(a) || !nodeIndex.has(b)) return;
        edges.push({ source: nodeIndex.get(a), target: nodeIndex.get(b), type: type });
      }

      const videoKey = "video:" + data.video.id;
      addNode(videoKey, "YouTubeVideo", data.video.title || data.video.id);
      const profileKey = "profile:" + data.classification.profile;
      addNode(profileKey, "ClassificationProfile", data.classification.profile);
      addEdge(videoKey, profileKey, "USES_CLASSIFICATION_PROFILE");

      for (const category of Object.keys(data.classification.categories)) {
        const catNode = addNode("cat:" + category, "CommentCategory", category);
        catNode.nav = { type: "category", value: category };
      }

      const sample = comments.slice()
        .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
        .slice(0, 26);
      const sampleIds = new Set(sample.map((c) => c.id));
      for (const comment of sample) {
        const cKey = "comment:" + comment.id;
        const commentNode = addNode(cKey, "YouTubeComment", (comment.text || "").slice(0, 40) || comment.id);
        commentNode.nav = { type: "comment", value: comment.id };
        addEdge(videoKey, cKey, "HAS_COMMENT");
        const category = comment.evaluation && comment.evaluation.category;
        if (category) addEdge(cKey, "cat:" + category, "IN_CATEGORY");
        const authorKey = "author:" + (comment.authorId || comment.author);
        addNode(authorKey, "YouTubeAuthor", comment.author);
        addEdge(authorKey, cKey, "WROTE");
        if (comment.parent && comment.parent !== "root" && sampleIds.has(comment.parent)) {
          addEdge(cKey, "comment:" + comment.parent, "REPLY_TO");
        }
      }

      const legendLabels = ["YouTubeVideo", "ClassificationProfile", "CommentCategory", "YouTubeComment", "YouTubeAuthor"];
      document.querySelector("#graphLegend").innerHTML = legendLabels.map((label) =>
        '<span><i style="background:' + palette[label] + '"></i>' + escapeHtml(label) + '</span>').join("");

      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      // A viewport group carries the zoom/pan transform; layers live inside it.
      const viewport = document.createElementNS(SVG_NS, "g");
      const edgeLayer = document.createElementNS(SVG_NS, "g");
      const nodeLayer = document.createElementNS(SVG_NS, "g");
      viewport.appendChild(edgeLayer);
      viewport.appendChild(nodeLayer);
      svg.appendChild(viewport);

      const view = { s: 1, tx: 0, ty: 0 };
      let dragging = false;
      function applyView() {
        viewport.setAttribute("transform", "translate(" + view.tx + "," + view.ty + ") scale(" + view.s + ")");
      }
      const resetBtn = document.querySelector("#graphReset");
      function updateResetVisibility() {
        if (resetBtn) resetBtn.hidden = view.s === 1 && view.tx === 0 && view.ty === 0;
      }

      // Adjacency, so hovering a node can highlight its direct neighbors.
      for (const node of nodes) { node.adjNodes = new Set(); node.adjEdges = new Set(); }
      for (const edge of edges) {
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("class", "graph-edge");
        const edgeTitle = document.createElementNS(SVG_NS, "title");
        edgeTitle.textContent = edge.type + ": " + edge.source.label + " \\u2192 " + edge.target.label;
        line.appendChild(edgeTitle);
        edge.el = line;
        edge.source.adjNodes.add(edge.target);
        edge.target.adjNodes.add(edge.source);
        edge.source.adjEdges.add(edge);
        edge.target.adjEdges.add(edge);
        edgeLayer.appendChild(line);
      }

      function svgPoint(evt) {
        const pt = svg.createSVGPoint();
        pt.x = evt.clientX; pt.y = evt.clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: evt.clientX, y: evt.clientY };
        const loc = pt.matrixTransform(ctm.inverse());
        return { x: loc.x, y: loc.y };
      }
      // Convert a viewBox-space point into the (zoomed/panned) layer coordinate space.
      function toLocal(p) {
        return { x: (p.x - view.tx) / view.s, y: (p.y - view.ty) / view.s };
      }
      // Emphasize a node and its neighbors, dim the rest. Pass null to clear.
      function setHighlight(node) {
        if (!node) {
          for (const n of nodes) n.el.classList.remove("hot", "dim");
          for (const e of edges) e.el.classList.remove("hot", "dim");
          return;
        }
        for (const n of nodes) {
          const on = n === node || node.adjNodes.has(n);
          n.el.classList.toggle("hot", on);
          n.el.classList.toggle("dim", !on);
        }
        for (const e of edges) {
          const on = node.adjEdges.has(e);
          e.el.classList.toggle("hot", on);
          e.el.classList.toggle("dim", !on);
        }
      }
      // A comment node jumps to its card; a category node filters the cards by category.
      function activateNode(node) {
        if (!node.nav) return;
        if (node.nav.type === "comment") {
          focusComment(node.nav.value);
        } else if (node.nav.type === "category") {
          setCategoryFilter(node.nav.value);
        }
      }

      function attachDrag(node) {
        node.el.addEventListener("pointerdown", (evt) => {
          evt.preventDefault();
          evt.stopPropagation(); // don't start a background pan
          node.fixed = true;
          dragging = true;
          setHighlight(null);
          node.el.setPointerCapture(evt.pointerId);
          const startX = evt.clientX, startY = evt.clientY;
          let moved = false;
          const move = (e) => {
            if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
              moved = true;
            }
            const p = toLocal(svgPoint(e));
            node.x = p.x; node.y = p.y;
            reheat();
          };
          const up = () => {
            node.fixed = false;
            dragging = false;
            try { node.el.releasePointerCapture(evt.pointerId); } catch (err) {}
            node.el.removeEventListener("pointermove", move);
            node.el.removeEventListener("pointerup", up);
            reheat();
            if (!moved) activateNode(node); // a tap that never dragged = a click
          };
          node.el.addEventListener("pointermove", move);
          node.el.addEventListener("pointerup", up);
        });
        node.el.addEventListener("pointerenter", () => { if (!dragging) setHighlight(node); });
        node.el.addEventListener("pointerleave", () => { if (!dragging) setHighlight(null); });
      }

      for (const node of nodes) {
        const g = document.createElementNS(SVG_NS, "g");
        g.setAttribute("class", "graph-node");
        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("r", String(node.r));
        circle.setAttribute("fill", palette[node.label] || "#94a3b8");
        const title = document.createElementNS(SVG_NS, "title");
        let hint = "";
        if (node.nav && node.nav.type === "comment") hint = " \\u2014 click to open its card";
        else if (node.nav && node.nav.type === "category") hint = " \\u2014 click to filter these comments";
        title.textContent = node.label + ": " + node.caption + hint;
        if (node.nav) circle.style.cursor = "pointer";
        g.appendChild(circle);
        g.appendChild(title);
        if (node.r >= 14) {
          const text = document.createElementNS(SVG_NS, "text");
          text.setAttribute("text-anchor", "middle");
          text.setAttribute("dy", "0.32em");
          text.textContent = node.caption.length > 18 ? node.caption.slice(0, 17) + "\\u2026" : node.caption;
          g.appendChild(text);
        }
        node.el = g;
        attachDrag(node);
        nodeLayer.appendChild(g);
      }

      container.appendChild(svg);
      container.hidden = false;
      applyView();

      // Scroll to zoom toward the cursor.
      svg.addEventListener("wheel", (e) => {
        e.preventDefault();
        const p = svgPoint(e);
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const newS = Math.max(0.4, Math.min(4, view.s * factor));
        const ratio = newS / view.s;
        view.tx = p.x - ratio * (p.x - view.tx);
        view.ty = p.y - ratio * (p.y - view.ty);
        view.s = newS;
        applyView();
        updateResetVisibility();
      }, { passive: false });

      // Drag the empty background to pan.
      svg.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".graph-node")) return; // nodes handle their own drag
        e.preventDefault();
        dragging = true;
        setHighlight(null);
        const start = svgPoint(e);
        const tx0 = view.tx, ty0 = view.ty;
        svg.setPointerCapture(e.pointerId);
        svg.style.cursor = "grabbing";
        const move = (ev) => {
          const p = svgPoint(ev);
          view.tx = tx0 + (p.x - start.x);
          view.ty = ty0 + (p.y - start.y);
          applyView();
          updateResetVisibility();
        };
        const up = () => {
          dragging = false;
          try { svg.releasePointerCapture(e.pointerId); } catch (err) {}
          svg.style.cursor = "";
          svg.removeEventListener("pointermove", move);
          svg.removeEventListener("pointerup", up);
        };
        svg.addEventListener("pointermove", move);
        svg.addEventListener("pointerup", up);
      });

      if (resetBtn) {
        resetBtn.addEventListener("click", () => {
          view.s = 1; view.tx = 0; view.ty = 0;
          applyView();
          updateResetVisibility();
          reheat();
        });
      }

      function paint() {
        for (const edge of edges) {
          edge.el.setAttribute("x1", String(edge.source.x));
          edge.el.setAttribute("y1", String(edge.source.y));
          edge.el.setAttribute("x2", String(edge.target.x));
          edge.el.setAttribute("y2", String(edge.target.y));
        }
        for (const node of nodes) {
          node.el.setAttribute("transform", "translate(" + node.x + "," + node.y + ")");
        }
      }

      let alpha = 1;
      let rafId = null;
      function tick() {
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            let dx = a.x - b.x, dy = a.y - b.y;
            let dist2 = dx * dx + dy * dy;
            if (dist2 < 0.01) { dx = (i - j) * 0.1 + 0.1; dy = 0.13; dist2 = dx * dx + dy * dy; }
            const dist = Math.sqrt(dist2);
            const force = (2600 / dist2) * alpha;
            const fx = (dx / dist) * force, fy = (dy / dist) * force;
            if (!a.fixed) { a.vx += fx; a.vy += fy; }
            if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
          }
        }
        for (const edge of edges) {
          const a = edge.source, b = edge.target;
          const target = (a.r + b.r) * 2.2 + 44;
          let dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const force = (dist - target) * 0.045 * alpha;
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          if (!a.fixed) { a.vx += fx; a.vy += fy; }
          if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
        }
        for (const node of nodes) {
          if (node.fixed) { node.vx = 0; node.vy = 0; continue; }
          node.vx += (W / 2 - node.x) * 0.006 * alpha;
          node.vy += (H / 2 - node.y) * 0.006 * alpha;
          node.vx *= 0.85; node.vy *= 0.85;
          node.x += node.vx; node.y += node.vy;
          node.x = Math.max(node.r, Math.min(W - node.r, node.x));
          node.y = Math.max(node.r, Math.min(H - node.r, node.y));
        }
        alpha *= 0.985;
        paint();
        if (alpha > 0.02) { rafId = requestAnimationFrame(tick); } else { rafId = null; }
      }
      function reheat() {
        alpha = Math.max(alpha, 0.5);
        if (rafId == null) rafId = requestAnimationFrame(tick);
      }
      rafId = requestAnimationFrame(tick);
    }

    // Scroll to the card for a given comment id and flash it. If the comment is currently
    // filtered out, clear the active filters first so its card is rendered.
    function focusComment(commentId) {
      let el = document.getElementById("comment-" + commentId);
      if (!el) {
        selectedCategory = null;
        updateMindmapSelection();
        search.value = "";
        creatorOnly.checked = false;
        render();
        el = document.getElementById("comment-" + commentId);
      }
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("comment-focus");
      void el.offsetWidth; // restart the flash animation if re-clicked
      el.classList.add("comment-focus");
      setTimeout(() => el.classList.remove("comment-focus"), 2300);
    }

    function setCategoryFilter(category) {
      selectedCategory = category || null;
      updateMindmapSelection();
      render();
      cards.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function updateMindmapSelection() {
      mindmapGraph.querySelectorAll(".map-node").forEach((node) => {
        const category = node.getAttribute("data-category") || null;
        node.classList.toggle("active", category === selectedCategory);
      });
    }

    function updateFilterState(visibleCount, visibleThreadCount) {
      if (selectedCategory) {
        categoryFilterState.innerHTML = \`Showing <strong>\${visibleCount}</strong> matching comments across <strong>\${visibleThreadCount}</strong> threads classified as <strong>\${escapeHtml(selectedCategory)}</strong>\`;
        clearCategoryFilter.hidden = false;
        return;
      }

      categoryFilterState.textContent = "Showing all classifications";
      clearCategoryFilter.hidden = true;
    }

    search.addEventListener("input", render);
    creatorOnly.addEventListener("change", render);
    clearCategoryFilter.addEventListener("click", () => setCategoryFilter(null));
    themeBoard.addEventListener("click", (event) => {
      const item = event.target.closest(".lane-thread");
      if (!item) return;
      setCategoryFilter(item.getAttribute("data-category"));
    });
    mindmapGraph.addEventListener("click", (event) => {
      const node = event.target.closest(".map-node");
      if (!node) return;
      setCategoryFilter(node.getAttribute("data-category"));
    });
    mindmapGraph.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const node = event.target.closest(".map-node");
      if (!node) return;
      event.preventDefault();
      setCategoryFilter(node.getAttribute("data-category"));
    });
    renderMindmap();
    renderThemeBoard();
    renderNeo4jPanel();
    renderNeo4jGraph();
    render();
  </script>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Emit a one-line NDJSON progress marker to stderr when YCA_PROGRESS is set, so a parent
// (the dashboard server) can stream per-stage status. stdout stays reserved for the final
// JSON result, so this never pollutes machine-readable output.
function progress(stage, message) {
  if (process.env.YCA_PROGRESS) {
    process.stderr.write(JSON.stringify({ progress: stage, message: message || "" }) + "\n");
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }

    if (args.fromJson) {
      const categorized = loadCategorizedJson(args.fromJson);
      fs.mkdirSync(args.outDir, { recursive: true });
      const htmlPath = writeHtml(categorized, args.outDir, categorized.video.id);

      console.log(JSON.stringify({
        ok: true,
        mode: "from-json",
        videoId: categorized.video.id,
        title: categorized.video.title,
        extractedComments: categorized.video.extractedCommentCount,
        classificationProfile: categorized.classification.profile,
        sourceJsonPath: args.fromJson,
        htmlPath,
      }, null, 2));
      return;
    }

    progress("validate", "Validating URL");
    const validation = validateYouTubeUrl(args.url);
    ensureToolInstalled("yt-dlp");

    progress("yt-dlp", "Downloading comments with yt-dlp");
    const { infoJsonPath } = runYtDlp({
      canonicalUrl: validation.canonicalUrl,
      videoId: validation.videoId,
      outDir: args.outDir,
    });
    progress("normalize", "Normalizing comments");
    const normalized = normalizeComments(infoJsonPath);
    progress("classify", "Classifying comments");
    const categorized = categorizeComments(normalized);
    const commentsJsonPath = writeNormalizedJson(categorized, args.outDir, validation.videoId);
    progress("render", "Building HTML report");
    const htmlPath = writeHtml(categorized, args.outDir, validation.videoId);

    console.log(JSON.stringify({
      ok: true,
      videoId: validation.videoId,
      title: categorized.video.title,
      extractedComments: categorized.video.extractedCommentCount,
      classificationProfile: categorized.classification.profile,
      infoJsonPath,
      commentsJsonPath,
      htmlPath,
    }, null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

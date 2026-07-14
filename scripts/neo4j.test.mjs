// Unit tests for the Neo4j integration (story yca-1).
// Server-free: cypher() takes an injectable fetchImpl, so timeout / oversized / auth /
// idempotency are all exercised without a live database.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  assertTlsForRemote,
  cypher,
  ensureSchema,
  countRows,
  SCHEMA_VERSION,
  SCHEMA_STATEMENTS,
} from "./neo4j-lib.mjs";
import {
  IMPORT_COMMENTS_QUERY,
  REFRESH_AUTHOR_CONTEXT_QUERY,
  REFRESH_VIDEO_CONTEXT_QUERY,
  validateCommentsData,
  summarize,
  normalizeRows,
  resolveExistingVideoAction,
} from "./neo4j-import-youtube-comments.mjs";
import {
  CONTEXT_CLASSIFIER_VERSION,
  buildContextKey,
  deriveCommentContext,
  isValidContextName,
  validateCommentContext,
} from "./comment-context.mjs";
import {
  buildBackfillPlan,
  runContextBackfill,
} from "./neo4j-context-backfill.mjs";
import {
  categorizeComments,
  loadCategorizedJson,
} from "./youtube-comments-tool.mjs";
import {
  isYouTubeUrl,
  isValidPostToken,
  parseToolJson,
  listVideos,
  run,
  trashVideoFiles,
} from "./server.mjs";
import {
  parseJson3,
  groupParagraphs,
  formatTimestamp,
  findCaptionFile,
  renderTranscriptHtml,
} from "./transcript-tool.mjs";
import {
  pickThumbnail,
  pickPullQuotes,
  paragraphize,
  buildSections,
  renderDocumentHtml,
} from "./document-tool.mjs";
import {
  normalizeChannelUrl,
  isChannelUrl,
  parseChannelDump,
} from "./channel-tool.mjs";
import {
  validateChannelData,
  buildVideoRows,
  summarize as summarizeChannel,
} from "./neo4j-import-channel.mjs";
import {
  selectComments,
  normalizeMindmap,
  normalizeMeanings,
  renderMindmapHtml,
} from "./mindmap-tool.mjs";

const LOCAL = { url: "http://localhost:7474", database: "neo4j", user: "neo4j", password: "x" };

// Build a fake fetch that returns a tx/commit-shaped payload.
function okFetch(payload = { results: [{ data: [] }], errors: [] }) {
  return async () => ({ ok: true, status: 200, statusText: "OK", json: async () => payload });
}

test("assertTlsForRemote: localhost http is allowed", () => {
  assert.doesNotThrow(() => assertTlsForRemote("http://localhost:7474"));
  assert.doesNotThrow(() => assertTlsForRemote("http://127.0.0.1:7474"));
});

test("assertTlsForRemote: remote https is allowed", () => {
  assert.doesNotThrow(() => assertTlsForRemote("https://xyz.databases.neo4j.io"));
});

test("assertTlsForRemote: remote http is rejected", () => {
  assert.throws(() => assertTlsForRemote("http://db.example.com:7474"), /not https/);
});

test("validateCommentsData: rejects missing video and missing comment id", () => {
  assert.throws(() => validateCommentsData({}, "x"), /video\.id/);
  assert.throws(
    () => validateCommentsData({ video: { id: "v", title: "t" }, comments: [{ text: "no id" }] }, "x"),
    /must have an id/,
  );
  assert.throws(
    () => validateCommentsData({
      video: { id: "v", title: "t" },
      comments: [{ id: "duplicate" }, { id: "duplicate" }],
    }, "x"),
    /must be unique/,
  );
});

test("summarize + normalizeRows: shape and defaults", () => {
  const data = {
    video: { id: "v1", title: "T" },
    classification: { profile: "default" },
    comments: [
      { id: "c1", parent: "root", author: "A", evaluation: { category: "Praise" } },
      { id: "c2", parent: "c1", author: "B" },
    ],
  };
  const s = summarize(data);
  assert.equal(s.comments, 2);
  assert.equal(s.rootComments, 1);
  assert.equal(s.replies, 1);
  const rows = normalizeRows(data.comments, data.classification.profile);
  assert.equal(rows[1].category, "Uncategorized");
  assert.equal(rows[1].sentiment, "neutral");
  assert.equal(rows[0].contextName, "Praise Discussion");
  assert.equal(rows[1].contextName, "General Reply");
  assert.match(rows[1].contextKey, /^yca-context-v1\|default\|uncategorized\|general-reply$/);
});

test("comment context: deterministic controlled names contain one to three words", () => {
  const input = {
    comment: { id: "c1", text: "Can you explain the connector setup?", parent: "root" },
    evaluation: { category: "Setup troubleshooting", intent: "question", sentiment: "neutral" },
  };
  const first = deriveCommentContext(input);
  const second = deriveCommentContext(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    name: "Setup Question",
    mode: "Question",
    classifierVersion: CONTEXT_CLASSIFIER_VERSION,
  });
  assert.equal(isValidContextName(first.name), true);

  assert.throws(
    () => deriveCommentContext({
      comment: { id: "bad-category" },
      evaluation: { category: { name: "not scalar" } },
    }),
    /category must be a string/,
  );

  const categoryIntentIsNotAbsolute = deriveCommentContext({
    comment: { id: "c-question", text: "Which tractor should I use?", parent: "root" },
    evaluation: { category: "Equipment, tools, or repairs", intent: "advice", sentiment: "neutral" },
  });
  assert.equal(categoryIntentIsNotAbsolute.name, "Equipment Question");

  const newCategory = deriveCommentContext({
    comment: { id: "c2", text: "Try a stronger bracket." },
    evaluation: { category: "Solar panel mounting configuration", intent: "advice" },
  });
  assert.equal(newCategory.name, "Solar Panel Advice");
  assert.equal(isValidContextName(newCategory.name), true);
});

test("comment context: creator state and malformed stored contexts are handled explicitly", () => {
  const creator = deriveCommentContext({
    comment: { id: "creator-1", text: "Thanks for asking", isCreator: true },
    evaluation: { category: "Creator reply", intent: "response", sentiment: "positive" },
  });
  assert.equal(creator.name, "Creator Reply");

  assert.throws(
    () => validateCommentContext(
      { name: "Anything The Model Invented", mode: "Invented", classifierVersion: CONTEXT_CLASSIFIER_VERSION },
      { category: "General comment" },
    ),
    /controlled mode/,
  );
  assert.throws(
    () => validateCommentContext(
      { name: "Wrong Question", mode: "Question", classifierVersion: CONTEXT_CLASSIFIER_VERSION },
      { category: "Setup troubleshooting" },
    ),
    /expected "Setup Question"/,
  );
});

test("extraction classification persists context for every generated comment", () => {
  const result = categorizeComments({
    video: { id: "video-1", title: "Claude connector setup", extractedCommentCount: 2 },
    comments: [
      { id: "c1", text: "How do I connect this?", parent: "root", isCreator: false },
      { id: "c2", text: "Great walkthrough", parent: "root", isCreator: false },
    ],
  });
  assert.equal(result.comments.length, 2);
  for (const comment of result.comments) {
    assert.ok(comment.evaluation.context);
    assert.equal(isValidContextName(comment.evaluation.context.name), true);
    assert.equal(comment.evaluation.context.classifierVersion, CONTEXT_CLASSIFIER_VERSION);
  }
});

test("legacy JSON rendering derives context in memory without rewriting its source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yca-context-legacy-"));
  const source = path.join(dir, "legacy.comments.json");
  const legacy = {
    video: { id: "legacy-1", title: "Legacy", extractedCommentCount: 1 },
    classification: { profile: "generic", categories: {}, sentiments: {}, priorities: {} },
    comments: [{
      id: "c1",
      text: "This fixed my setup problem",
      parent: "root",
      evaluation: { category: "Setup troubleshooting", intent: "experience", sentiment: "positive" },
    }],
  };
  fs.writeFileSync(source, JSON.stringify(legacy));
  try {
    const loaded = loadCategorizedJson(source);
    assert.equal(loaded.comments[0].evaluation.context.name, "Setup Problem");
    const unchanged = JSON.parse(fs.readFileSync(source, "utf8"));
    assert.equal(unchanged.comments[0].evaluation.context, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Neo4j context rows use stable keys and reject malformed context with the comment id", () => {
  const context = deriveCommentContext({
    comment: { id: "c1", text: "How?" },
    evaluation: { category: "Setup troubleshooting", intent: "question" },
  });
  assert.equal(
    buildContextKey("ai-tools", "Setup troubleshooting", context),
    "yca-context-v1|ai-tools|setup-troubleshooting|setup-question",
  );
  const slashCategory = deriveCommentContext({
    comment: { text: "hello" }, evaluation: { category: "foo/bar" },
  });
  const spaceCategory = deriveCommentContext({
    comment: { text: "hello" }, evaluation: { category: "foo bar" },
  });
  assert.notEqual(
    buildContextKey("custom profile", "foo/bar", slashCategory),
    buildContextKey("custom profile", "foo bar", spaceCategory),
  );

  assert.throws(() => normalizeRows([{
    id: "broken-7",
    text: "hello",
    evaluation: {
      category: "General comment",
      context: { name: "Too Many Arbitrary Context Words", mode: "Discussion", classifierVersion: CONTEXT_CLASSIFIER_VERSION },
    },
  }], "generic"), /Comment broken-7/);
});

test("Neo4j relation queries use stable types and refresh bounded aggregates", () => {
  assert.match(IMPORT_COMMENTS_QUERY, /\[ic:IN_CONTEXT\]/);
  assert.match(IMPORT_COMMENTS_QUERY, /ic\.label = row\.contextName/);
  assert.match(IMPORT_COMMENTS_QUERY, /\[:SUBCLASS_OF\]/);
  assert.match(IMPORT_COMMENTS_QUERY, /\[:VALID_FOR\]/);
  assert.match(REFRESH_VIDEO_CONTEXT_QUERY, /\[coverage:COVERS\]/);
  assert.match(REFRESH_VIDEO_CONTEXT_QUERY, /coverage\.commentCount = commentCount/);
  assert.match(REFRESH_AUTHOR_CONTEXT_QUERY, /\[discussion:DISCUSSES\]/);
  assert.doesNotMatch(IMPORT_COMMENTS_QUERY, /\$relationshipType/);
});

test("context backfill plan skips current edges and reports invalid rows", () => {
  const base = {
    id: "c1",
    videoId: "v1",
    profile: "generic",
    text: "How do I fix this?",
    category: "Question or help request",
    intent: "question",
    sentiment: "neutral",
    parent: "root",
    isCreator: false,
    videoCount: 1,
    profileCount: 1,
    contextEdgeCount: 0,
  };
  const expected = deriveCommentContext({ comment: base, evaluation: base });
  const key = buildContextKey(base.profile, base.category, expected);
  const plan = buildBackfillPlan([
    {
      ...base,
      contextEdgeCount: 1,
      contexts: [{
        key,
        name: expected.name,
        nodeMode: expected.mode,
        nodeClassifierVersion: expected.classifierVersion,
        nodeCategory: base.category,
        nodeProfile: base.profile,
        relationLabel: expected.name,
        relationMode: expected.mode,
        relationClassifierVersion: expected.classifierVersion,
        categories: [base.category],
        profiles: [base.profile],
      }],
    },
    { ...base, id: "c2", contexts: [] },
    { ...base, id: null, contexts: [] },
  ]);
  assert.equal(plan.summary.processed, 2);
  assert.equal(plan.summary.skipped, 1);
  assert.equal(plan.summary.proposed, 1);
  assert.equal(plan.summary.invalid, 1);
  assert.deepEqual(plan.videoIds, ["v1"]);
});

test("context backfill dry run performs one read and no graph mutation", async () => {
  const statements = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    statements.push(body.statements[0].statement);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        results: [{ data: [{ row: [{
          id: "c1",
          videoId: "v1",
          profile: "generic",
          text: "What happened?",
          category: "Question or help request",
          intent: "question",
          sentiment: "neutral",
          parent: "root",
          isCreator: false,
          videoCount: 1,
          profileCount: 1,
          contextEdgeCount: 0,
          contexts: [],
        }] }] }],
        errors: [],
      }),
    };
  };
  const result = await runContextBackfill(LOCAL, { write: false, limit: 25, fetchImpl });
  assert.equal(result.dryRun, true);
  assert.equal(result.proposed, 1);
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0], /\b(?:CREATE|DELETE|MERGE|REMOVE|SET)\b/i);
});

test("context backfill refuses partial or invalid writes before mutation", async () => {
  await assert.rejects(
    runContextBackfill(LOCAL, { write: true, limit: 25, fetchImpl: okFetch() }),
    /full writes cannot be partial/,
  );

  const statements = [];
  const invalidFetch = async (_url, init) => {
    statements.push(JSON.parse(init.body).statements[0].statement);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        results: [{ data: [{ row: [{
          id: "orphan",
          videoId: null,
          videoCount: 0,
          profile: "unknown",
          profileCount: 0,
          contexts: [],
        }] }] }],
        errors: [],
      }),
    };
  };
  await assert.rejects(
    runContextBackfill(LOCAL, { write: true, fetchImpl: invalidFetch }),
    /Refusing to write: 1 invalid comment row/,
  );
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0], /\b(?:CREATE|DELETE|MERGE|REMOVE|SET)\b/i);
});

test("context backfill write executes schema, projection, and aggregate refresh", async () => {
  const statements = [];
  const fetchImpl = async (_url, init) => {
    const statement = JSON.parse(init.body).statements[0].statement;
    statements.push(statement);
    const data = statement.includes("ORDER BY item.id") ? [{ row: [{
      id: "c1",
      videoId: "v1",
      videoCount: 1,
      profile: "generic",
      profileCount: 1,
      text: "How do I fix this?",
      category: "Question or help request",
      intent: "question",
      sentiment: "neutral",
      parent: "root",
      isCreator: false,
      contextEdgeCount: 0,
      contexts: [],
    }] }] : [];
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [{ data }], errors: [] }),
    };
  };
  const result = await runContextBackfill(LOCAL, { write: true, batchSize: 1, fetchImpl });
  assert.equal(result.written, 1);
  assert.ok(statements.some((statement) => statement.includes("relation:IN_CONTEXT")));
  assert.ok(statements.some((statement) => statement.includes("coverage:COVERS")));
  assert.ok(statements.some((statement) => statement.includes("discussion:DISCUSSES")));
});

test("cypher: query timeout aborts", async () => {
  const hangingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  await assert.rejects(
    cypher(LOCAL, "RETURN 1", {}, { fetchImpl: hangingFetch, timeoutMs: 20 }),
    /timed out after 20ms/,
  );
});

test("cypher: result-size cap trips", async () => {
  const big = { results: [{ data: Array.from({ length: 5 }, () => ({ row: [1] })) }], errors: [] };
  await assert.rejects(
    cypher(LOCAL, "MATCH (n) RETURN n", {}, { fetchImpl: okFetch(big), maxRows: 2 }),
    /result too large/,
  );
});

test("cypher: authentication failure is a clear error", async () => {
  const authFetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}) });
  await assert.rejects(
    cypher(LOCAL, "RETURN 1", {}, { fetchImpl: authFetch }),
    /authentication failed/,
  );
});

test("cypher: neo4j-reported errors surface", async () => {
  const errFetch = okFetch({ results: [], errors: [{ message: "SyntaxError: bad" }] });
  await assert.rejects(cypher(LOCAL, "BAD", {}, { fetchImpl: errFetch }), /SyntaxError: bad/);
});

test("ensureSchema: issues all statements and is safe to re-run", async () => {
  let calls = 0;
  const countingFetch = okFetch();
  const wrapped = async (...a) => {
    calls += 1;
    return countingFetch(...a);
  };
  await ensureSchema(LOCAL, { fetchImpl: wrapped });
  await ensureSchema(LOCAL, { fetchImpl: wrapped }); // idempotent second run
  // Each run = all constraint/index statements + one version MERGE.
  assert.equal(calls, (SCHEMA_STATEMENTS.length + 1) * 2);
  assert.equal(SCHEMA_VERSION, 3);
  assert.ok(SCHEMA_STATEMENTS.some((statement) => statement.includes("comment_context_key")));
});

test("countRows: sums data rows across results", () => {
  assert.equal(countRows({ results: [{ data: [1, 2] }, { data: [3] }] }), 3);
  assert.equal(countRows({}), 0);
});

test("isYouTubeUrl: accepts youtube hosts, rejects others", () => {
  assert.ok(isYouTubeUrl("https://www.youtube.com/watch?v=abc123"));
  assert.ok(isYouTubeUrl("https://youtu.be/abc123"));
  assert.ok(isYouTubeUrl("http://m.youtube.com/watch?v=abc123"));
  assert.equal(isYouTubeUrl("https://vimeo.com/123"), false);
  assert.equal(isYouTubeUrl("not a url"), false);
  assert.equal(isYouTubeUrl(""), false);
});

test("isValidPostToken: requires the dashboard mutation token", () => {
  assert.equal(isValidPostToken({ "x-yca-token": "abc" }, "abc"), true);
  assert.equal(isValidPostToken({ "X-YCA-Token": "abc" }, "abc"), true);
  assert.equal(isValidPostToken({ "x-yca-token": "wrong" }, "abc"), false);
  assert.equal(isValidPostToken({}, "abc"), false);
});

test("run: terminates child process after timeout", async () => {
  const result = await run(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {}, 30);
  assert.equal(result.code, -2);
  assert.match(result.stderr, /timed out after 30ms/);
});

test("parseToolJson: extracts JSON even with surrounding noise", () => {
  assert.deepEqual(parseToolJson('{"ok":true,"videoId":"v1"}'), { ok: true, videoId: "v1" });
  assert.deepEqual(parseToolJson('warn: something\n{\n  "ok": true\n}\n'), { ok: true });
  assert.equal(parseToolJson("no json here"), null);
});

test("listVideos: summarizes report JSON, newest first, skips malformed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yca-videos-"));
  try {
    fs.writeFileSync(path.join(dir, "v1.comments.json"), JSON.stringify({
      video: { id: "v1", title: "First" },
      classification: { profile: "p1" },
      comments: [{ id: "c1" }, { id: "c2" }],
    }));
    fs.writeFileSync(path.join(dir, "v1.comments.html"), "<html></html>");
    fs.writeFileSync(path.join(dir, "v2.comments.json"), JSON.stringify({
      video: { id: "v2", title: "Second" },
      comments: [{ id: "c3" }],
    }));
    fs.writeFileSync(path.join(dir, "broken.comments.json"), "{ not json");
    // Make v2 newer so it sorts first.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, "v2.comments.json"), future, future);

    const videos = listVideos(dir);
    assert.equal(videos.length, 2); // malformed skipped
    assert.equal(videos[0].videoId, "v2"); // newest first
    const v1 = videos.find((v) => v.videoId === "v1");
    assert.equal(v1.comments, 2);
    assert.equal(v1.profile, "p1");
    assert.equal(v1.hasReport, true);
    assert.equal(videos.find((v) => v.videoId === "v2").hasReport, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trashVideoFiles: moves report files into .trash, recoverable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yca-trash-"));
  try {
    fs.writeFileSync(path.join(dir, "v9.comments.json"), "{}");
    fs.writeFileSync(path.join(dir, "v9.comments.html"), "<html></html>");
    fs.writeFileSync(path.join(dir, "v9.info.json"), "{}");
    const result = trashVideoFiles("v9", dir, 12345);
    // Originals gone from the output dir…
    assert.equal(fs.existsSync(path.join(dir, "v9.comments.json")), false);
    assert.equal(fs.existsSync(path.join(dir, "v9.comments.html")), false);
    // …and recoverable under .trash.
    assert.equal(result.moved.length, 3);
    assert.equal(fs.existsSync(path.join(result.trashDir, "v9.comments.json")), true);
    // Absent files are simply not listed (no throw).
    const empty = trashVideoFiles("does-not-exist", dir, 12345);
    assert.equal(empty.moved.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseJson3: builds ordered lines and drops rolling dupes", () => {
  const raw = JSON.stringify({
    events: [
      { tStartMs: 0, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
      { tStartMs: 1000 },                                  // no segs -> skipped
      { tStartMs: 2000, segs: [{ utf8: "Hello world" }] }, // duplicate of previous -> skipped
      { tStartMs: 3500, segs: [{ utf8: "next line" }] },
    ],
  });
  const lines = parseJson3(raw);
  assert.deepEqual(lines, [
    { start: 0, text: "Hello world" },
    { start: 4, text: "next line" }, // 3500ms rounds to 4s
  ]);
  assert.deepEqual(parseJson3("not json"), []);
});

test("groupParagraphs: merges lines until the char budget", () => {
  const lines = [
    { start: 0, text: "aaaa" },
    { start: 2, text: "bbbb" },
    { start: 4, text: "cccc" },
  ];
  const paras = groupParagraphs(lines, 10);
  assert.equal(paras.length, 2); // "aaaa bbbb" (9) then "cccc"
  assert.equal(paras[0].start, 0);
  assert.equal(paras[0].text, "aaaa bbbb");
  assert.equal(paras[1].text, "cccc");
});

test("formatTimestamp: m:ss and h:mm:ss", () => {
  assert.equal(formatTimestamp(5), "0:05");
  assert.equal(formatTimestamp(75), "1:15");
  assert.equal(formatTimestamp(3661), "1:01:01");
});

test("findCaptionFile: prefers plain 'en' over regional/auto", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yca-caps-"));
  try {
    fs.writeFileSync(path.join(dir, "vid.en-US.json3"), "{}");
    fs.writeFileSync(path.join(dir, "vid.en.json3"), "{}");
    fs.writeFileSync(path.join(dir, "vid.fr.json3"), "{}");
    assert.equal(path.basename(findCaptionFile(dir, "vid")), "vid.en.json3");
    assert.equal(findCaptionFile(dir, "missing"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("renderTranscriptHtml: renders sections, timestamps, and empty state", () => {
  const withText = renderTranscriptHtml({
    videoId: "v1", title: "Title & <stuff>", url: "https://www.youtube.com/watch?v=v1",
    paragraphs: [{ start: 65, text: "hello there" }], language: "en",
  });
  assert.match(withText, /1:05/);                 // timestamp chip
  assert.match(withText, /t=65s/);                // deep-link to YouTube time
  assert.match(withText, /Title &amp; &lt;stuff&gt;/); // escaped title
  const empty = renderTranscriptHtml({
    videoId: "v2", title: "No caps", url: "https://www.youtube.com/watch?v=v2", paragraphs: [], language: null,
  });
  assert.match(empty, /No transcript is available/);
});

test("pickThumbnail: info.thumbnail, then best thumbnails, then fallback", () => {
  assert.equal(pickThumbnail({ thumbnail: "https://x/best.jpg" }, "v1"), "https://x/best.jpg");
  assert.equal(
    pickThumbnail({ thumbnails: [{ url: "a", width: 120 }, { url: "b", width: 1280 }] }, "v1"),
    "b",
  );
  assert.equal(pickThumbnail({}, "abc123"), "https://i.ytimg.com/vi/abc123/hqdefault.jpg");
});

test("pickPullQuotes: returns spaced, well-sized sentences", () => {
  const long = Array.from({ length: 12 }, (_, i) =>
    `This is a reasonably long sentence number ${i} that sits comfortably in range.`).join(" ");
  const quotes = pickPullQuotes(long, 3);
  assert.ok(quotes.length >= 1 && quotes.length <= 3);
  quotes.forEach((q) => assert.ok(q.length >= 60 && q.length <= 170));
  assert.deepEqual(pickPullQuotes("", 3), []);
});

test("paragraphize: groups sentences into readable paragraphs", () => {
  const text = "One two three four. Five six seven eight. Nine ten eleven twelve.";
  const paras = paragraphize(text, 30);
  assert.ok(paras.length >= 2);
  assert.ok(paras.every((p) => p.length <= 45));
  assert.equal(paras.join(" "), text);
});

test("buildSections: folds transcript into chapters by time range", () => {
  const paragraphs = [
    { start: 0, text: "intro one" },
    { start: 30, text: "intro two" },
    { start: 120, text: "middle bit" },
    { start: 400, text: "final bit" },
  ];
  const chapters = [
    { start_time: 0, title: "Intro" },
    { start_time: 100, title: "Middle" },
    { start_time: 300, title: "End" },
  ];
  const sections = buildSections(paragraphs, chapters, 600);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].title, "Intro");
  assert.equal(sections[0].text, "intro one intro two");
  assert.equal(sections[1].text, "middle bit");
  assert.equal(sections[2].text, "final bit");
  // No chapters -> evenly split, untitled.
  const fallback = buildSections(paragraphs, [], 600);
  assert.ok(fallback.length >= 1);
  assert.equal(fallback[0].title, null);
});

test("renderDocumentHtml: hero image, chapters, section frames, escaping, empty state", () => {
  const doc = renderDocumentHtml({
    videoId: "v1", title: "A & B <c>", url: "https://www.youtube.com/watch?v=v1",
    thumbnail: "https://i.ytimg.com/vi/v1/maxresdefault.jpg", channel: "Chan", duration: 3661,
    published: "Jan 1, 2026", description: "Nice desc",
    sections: [{ title: "Chapter One", start: 65, end: 200, text: "hello world", paras: ["hello world"], image: "v1.frame-0.jpg" }],
  });
  assert.match(doc, /class="thumb"/);            // hero image
  assert.match(doc, /Chapter One/);              // chapter heading
  assert.match(doc, /v1\.frame-0\.jpg/);         // section frame image
  assert.match(doc, /1:01:01/);                  // duration formatted
  assert.match(doc, /t=65s/);                    // deep link
  assert.match(doc, /A &amp; B &lt;c&gt;/);      // escaped title
  assert.match(doc, /Overview/);                 // description block
  const empty = renderDocumentHtml({
    videoId: "v2", title: "Empty", url: "https://www.youtube.com/watch?v=v2",
    thumbnail: "https://i.ytimg.com/vi/v2/hqdefault.jpg", channel: null, duration: null,
    published: null, description: null, sections: [],
  });
  assert.match(empty, /nothing to document/);
});

test("normalizeChannelUrl: normalizes to the videos tab, rejects non-channels", () => {
  assert.equal(normalizeChannelUrl("https://www.youtube.com/@indydevdan"), "https://www.youtube.com/@indydevdan/videos");
  assert.equal(normalizeChannelUrl("https://youtube.com/@x/videos"), "https://www.youtube.com/@x/videos");
  assert.equal(normalizeChannelUrl("https://www.youtube.com/channel/UC_abc"), "https://www.youtube.com/channel/UC_abc/videos");
  assert.equal(normalizeChannelUrl("https://www.youtube.com/@x/streams"), "https://www.youtube.com/@x/streams");
  assert.throws(() => normalizeChannelUrl("https://www.youtube.com/watch?v=abc"), /channel URL/);
  assert.throws(() => normalizeChannelUrl("https://vimeo.com/@x"), /Not a YouTube/);
});

test("isChannelUrl: true only for channel URLs", () => {
  assert.equal(isChannelUrl("https://www.youtube.com/@indydevdan"), true);
  assert.equal(isChannelUrl("https://www.youtube.com/watch?v=abc"), false);
  assert.equal(isChannelUrl("nonsense"), false);
});

test("parseChannelDump: extracts channel + video list", () => {
  const parsed = parseChannelDump({
    channel: "IndyDevDan",
    channel_id: "UC_x36zCEGilGpB1m-V4gmjg",
    uploader_id: "@indydevdan",
    webpage_url: "https://www.youtube.com/@indydevdan/videos",
    entries: [
      { id: "aaa", title: "First", duration: 100 },
      { id: "bbb", title: "Second", duration: 200 },
      { id: null, title: "skip me" },
    ],
  });
  assert.equal(parsed.channelId, "UC_x36zCEGilGpB1m-V4gmjg");
  assert.equal(parsed.name, "IndyDevDan");
  assert.equal(parsed.handle, "@indydevdan");
  assert.equal(parsed.videos.length, 2);
  assert.deepEqual(parsed.videos[0], { id: "aaa", title: "First", duration: 100, views: null });
});

test("parseChannelDump: aggregates subscribers, views, avatar", () => {
  const parsed = parseChannelDump({
    channel: "Chan", channel_id: "UC_abc", uploader_id: "@chan",
    channel_follower_count: 136000,
    thumbnails: [{ url: "wide", width: 1280, height: 200 }, { url: "sq", width: 900, height: 900 }],
    entries: [
      { id: "a", title: "A", view_count: 1000 },
      { id: "b", title: "B", view_count: 500 },
    ],
  });
  assert.equal(parsed.subscribers, 136000);
  assert.equal(parsed.totalViews, 1500);
  assert.equal(parsed.avatar, "sq"); // square avatar preferred over the wide banner
  assert.equal(parsed.videoCount, 2);
});

test("channel graph: validate, buildVideoRows, summarize", () => {
  assert.throws(() => validateChannelData({}, "x"), /channelId/);
  assert.throws(() => validateChannelData({ channelId: "c" }, "x"), /videos array/);
  const channel = {
    channelId: "UC_abc", name: "Chan", handle: "@chan",
    videos: [
      { id: "v1", title: "One", duration: 100 },
      { id: "v2", title: "Two" },
      { id: null, title: "skip" },
    ],
  };
  assert.doesNotThrow(() => validateChannelData(channel, "x"));
  const rows = buildVideoRows(channel);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: "v1", title: "One", duration: 100 });
  assert.equal(rows[1].duration, null);
  assert.deepEqual(summarizeChannel(channel), { channelId: "UC_abc", name: "Chan", handle: "@chan", videos: 3 });
});

test("mindmap: selectComments picks top by likes, trims", () => {
  const picked = selectComments([
    { author: "a", text: "  low  ", likeCount: 1 },
    { author: "b", text: "high", likeCount: 100 },
    { author: "c", text: "", likeCount: 999 },
    { author: "d", text: "x".repeat(500), likeCount: 50 },
  ], 2);
  assert.equal(picked.length, 2);
  assert.equal(picked[0].author, "b"); // highest likes, non-empty
  assert.ok(picked[1].text.length <= 220);
});

test("mindmap: normalizeMindmap clamps to a safe shape", () => {
  const mm = normalizeMindmap({
    sentiment: "  Positive ",
    themes: [
      { title: "Equipment-Suggestions", emoji: "🚧", points: ["a", "b", "c", "d", "e"] },
      { title: "Empty", emoji: "x", points: [] },
    ],
    takeaway: ["one", "two", "three", "four", "five"],
    summary: "sum",
    meanings: [{ author: "@x", meaning: "Y" }, { author: "", meaning: "z" }],
  });
  assert.equal(mm.sentiment, "Positive");
  assert.equal(mm.themes.length, 1);              // empty-points theme dropped
  assert.equal(mm.themes[0].points.length, 4);    // capped at 4
  assert.equal(mm.takeaway.length, 4);            // capped at 4
  assert.equal(mm.meanings.length, 1);            // author-less dropped
});

test("mindmap: normalizeMeanings collapses @@ and filters", () => {
  const m = normalizeMeanings({ meanings: [{ author: "@@bob", meaning: "Foo" }, { author: "x", meaning: "" }] });
  assert.equal(m.length, 1);
  assert.equal(m[0].author, "@bob");
});

test("mindmap: renderMindmapHtml renders center, themes, meanings", () => {
  const html = renderMindmapHtml({
    video: { title: "T & <x>", id: "v1" }, url: "https://www.youtube.com/watch?v=v1",
    mindmap: {
      sentiment: "Positive",
      themes: [{ title: "Equipment-Suggestions", emoji: "🚧", points: ["Buy a skid steer"] }],
      takeaway: ["Highly engaged"], summary: "A summary.",
      meanings: [{ author: "@bob", meaning: "SkidSteer-Recommendation" }],
    },
  });
  assert.match(html, /Audience Feedback Summary/);
  assert.match(html, /Equipment-Suggestions/);
  assert.match(html, /SkidSteer-Recommendation/);
  assert.match(html, /T &amp; &lt;x&gt;/);
});

test("resolveExistingVideoAction: existing-video decisions", async () => {
  const existing = { id: "v1", title: "T", extractedCommentCount: 3, updatedAt: "now" };
  const neverAsk = () => {
    throw new Error("should not prompt");
  };
  // Explicit flags never prompt.
  assert.equal(await resolveExistingVideoAction(existing, { update: true }, neverAsk), "update");
  assert.equal(await resolveExistingVideoAction(existing, { skipExisting: true }, neverAsk), "skip");

  const originalIsTTY = process.stdin.isTTY;
  try {
    // Non-TTY without a flag: default to skip, without prompting.
    process.stdin.isTTY = false;
    assert.equal(await resolveExistingVideoAction(existing, {}, neverAsk), "skip");

    // Interactive: the prompt answer decides.
    process.stdin.isTTY = true;
    assert.equal(await resolveExistingVideoAction(existing, {}, async () => true), "update");
    assert.equal(await resolveExistingVideoAction(existing, {}, async () => false), "skip");
  } finally {
    process.stdin.isTTY = originalIsTTY;
  }
});

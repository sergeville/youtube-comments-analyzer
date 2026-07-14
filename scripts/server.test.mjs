import assert from "node:assert/strict";
import test from "node:test";

import { renderTopNav } from "./server.mjs";

test("renderTopNav renders dashboard context and escapes labels", () => {
  const html = renderTopNav({
    title: "A <video> title",
    current: "report",
    links: [
      { key: "report", label: "Comments", href: "/report/video-id" },
      { key: "transcript", label: "Transcript", href: "/transcript/video-id" },
    ],
    youtubeUrl: "https://www.youtube.com/watch?v=video-id",
  });

  assert.match(html, /href="\/"[^>]*>← Dashboard/);
  assert.match(html, /A &lt;video&gt; title/);
  assert.match(html, /<span[^>]*>Comments<\/span>/);
  assert.match(html, /href="\/transcript\/video-id"[^>]*>Transcript/);
  assert.match(html, /https:\/\/www\.youtube\.com\/watch\?v=video-id/);
});

test("renderTopNav marks the dashboard without a misleading back link", () => {
  const html = renderTopNav({ title: "YouTube Comments Analyzer", current: "dashboard" });

  assert.match(html, /<span[^>]*>Dashboard<\/span>/);
  assert.doesNotMatch(html, /← Dashboard/);
  assert.match(html, /YouTube Comments Analyzer/);
});

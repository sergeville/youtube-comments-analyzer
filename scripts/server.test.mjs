import assert from "node:assert/strict";
import test from "node:test";

import { mergeChannels, mergeVideos, renderTopNav } from "./server.mjs";

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

test("mergeVideos keeps local artifacts while adding graph-only videos", () => {
  const videos = mergeVideos(
    [{
      videoId: "local1",
      title: "Local title",
      comments: 2,
      hasComments: true,
      hasReport: true,
      updatedAt: "2026-07-15T10:00:00.000Z",
    }],
    [
      {
        videoId: "local1",
        title: "Graph title",
        comments: 99,
        channel: "Graph channel",
        inNeo4j: true,
        updatedAt: "2026-07-14T10:00:00.000Z",
      },
      {
        videoId: "graph1",
        title: "Graph only",
        comments: 0,
        channel: "Graph channel",
        inNeo4j: true,
      },
    ],
  );

  assert.equal(videos.length, 2);
  const local = videos.find((video) => video.videoId === "local1");
  assert.equal(local.title, "Local title");
  assert.equal(local.comments, 2);
  assert.equal(local.channel, "Graph channel");
  assert.equal(local.hasReport, true);
  assert.equal(local.inNeo4j, true);
  assert.equal(local.source, "local+graph");

  const graph = videos.find((video) => video.videoId === "graph1");
  assert.equal(graph.title, "Graph only");
  assert.equal(graph.url, "https://www.youtube.com/watch?v=graph1");
  assert.equal(graph.hasReport, false);
  assert.equal(graph.inNeo4j, true);
  assert.equal(graph.source, "graph");
});

test("mergeChannels uses graph inventory when local channel manifests are absent", () => {
  const channels = mergeChannels(
    [{ channelId: "uc1", name: "Local", videoCount: 1, analyzedCount: 1 }],
    [
      { channelId: "uc1", name: "Graph", subscribers: 10, videoCount: 3, analyzedCount: 2 },
      { channelId: "uc2", name: "Graph only", subscribers: 20, videoCount: 5, analyzedCount: 0 },
    ],
  );

  assert.equal(channels.length, 2);
  assert.equal(channels[0].channelId, "uc2");
  const merged = channels.find((channel) => channel.channelId === "uc1");
  assert.equal(merged.name, "Local");
  assert.equal(merged.videoCount, 3);
  assert.equal(merged.analyzedCount, 2);
  assert.equal(merged.subscribers, 10);
  assert.equal(merged.source, "local+graph");
});

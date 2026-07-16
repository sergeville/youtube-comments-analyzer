// Unit tests for yt-dlp auth arg assembly (env-driven, pure).
import test from "node:test";
import assert from "node:assert/strict";

import { ytdlpAuthArgs } from "./ytdlp-auth.mjs";

test("no env → no auth args", () => {
  assert.deepEqual(ytdlpAuthArgs({}), []);
});

test("cookies file → --cookies", () => {
  assert.deepEqual(ytdlpAuthArgs({ YCA_YTDLP_COOKIES: "/tmp/c.txt" }), ["--cookies", "/tmp/c.txt"]);
});

test("browser → --cookies-from-browser", () => {
  assert.deepEqual(ytdlpAuthArgs({ YCA_YTDLP_COOKIES_FROM_BROWSER: "safari" }), ["--cookies-from-browser", "safari"]);
});

test("cookies file takes precedence over browser (one auth source)", () => {
  const args = ytdlpAuthArgs({ YCA_YTDLP_COOKIES: "/tmp/c.txt", YCA_YTDLP_COOKIES_FROM_BROWSER: "chrome" });
  assert.deepEqual(args, ["--cookies", "/tmp/c.txt"]);
});

test("player client appends an extractor-args flag", () => {
  assert.deepEqual(ytdlpAuthArgs({ YCA_YTDLP_PLAYER_CLIENT: "web_safari,web" }),
    ["--extractor-args", "youtube:player_client=web_safari,web"]);
});

test("player client composes with a cookie source", () => {
  assert.deepEqual(
    ytdlpAuthArgs({ YCA_YTDLP_COOKIES: "/c.txt", YCA_YTDLP_PLAYER_CLIENT: "web" }),
    ["--cookies", "/c.txt", "--extractor-args", "youtube:player_client=web"],
  );
});

test("whitespace-only values are ignored", () => {
  assert.deepEqual(ytdlpAuthArgs({ YCA_YTDLP_COOKIES: "   ", YCA_YTDLP_COOKIES_FROM_BROWSER: "  " }), []);
});

// Shared yt-dlp authentication args. YouTube increasingly bot-gates unauthenticated
// requests ("Sign in to confirm you're not a bot"); passing cookies fixes it. Configure
// ONE of these in .env (or the environment):
//
//   YCA_YTDLP_COOKIES=/absolute/path/to/cookies.txt      # Netscape cookies file (robust)
//   YCA_YTDLP_COOKIES_FROM_BROWSER=safari                # or chrome/firefox/edge/brave/…
//
// Optional: force a player client if the default gets gated:
//   YCA_YTDLP_PLAYER_CLIENT=web_safari,web
//
// Every tool that shells out to yt-dlp spreads ytdlpAuthArgs() into its arg list, so one
// setting authenticates transcript, document, comments, and channel fetches alike.

// fallow-ignore-next-line complexity
export function ytdlpAuthArgs(env = process.env) {
  const args = [];
  const cookiesFile = (env.YCA_YTDLP_COOKIES || "").trim();
  const cookiesBrowser = (env.YCA_YTDLP_COOKIES_FROM_BROWSER || "").trim();
  const playerClient = (env.YCA_YTDLP_PLAYER_CLIENT || "").trim();

  // A cookies file takes precedence over browser extraction (more robust, no keychain /
  // Full-Disk-Access issues). Only one auth source is passed.
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  } else if (cookiesBrowser) {
    args.push("--cookies-from-browser", cookiesBrowser);
  }
  if (playerClient) {
    args.push("--extractor-args", `youtube:player_client=${playerClient}`);
  }
  return args;
}

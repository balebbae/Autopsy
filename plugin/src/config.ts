export const config = {
  url: process.env.AAG_URL ?? "http://localhost:4000",
  token: process.env.AAG_TOKEN,
  // Tools that warrant a preflight check before they run. Keep tight to avoid
  // adding latency on every read/grep call.
  preflightTools: new Set(["edit", "write", "bash"]),
}

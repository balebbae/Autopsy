// In-memory buffer holding recent user-message text observed on the opencode
// bus. Populated by `chat.message` / `event` hooks and read by preflight
// handlers to enrich the `task` field on `/v1/preflight`.
//
// Keep both a global fallback and a per-session map. opencode can run multiple
// sessions in one plugin process, and `experimental.chat.system.transform`
// only gives us the session id, so session-scoping avoids cross-session bleed.

let _latest: string | null = null
const _latestBySession = new Map<string, string>()

export function setLatestUserMessage(text: string, sessionID?: string | null): void {
  const trimmed = text.trim()
  if (!trimmed) return
  _latest = trimmed
  if (sessionID) _latestBySession.set(sessionID, trimmed)
}

export function latestUserMessage(
  sessionID?: string | null,
  opts: { fallbackGlobal?: boolean } = {},
): string | null {
  if (sessionID) {
    const scoped = _latestBySession.get(sessionID)
    if (scoped) return scoped
    if (opts.fallbackGlobal === false) return null
  }
  return _latest
}

// Test-only reset; do not call from production code paths.
export function _resetLatestUserMessage(): void {
  _latest = null
  _latestBySession.clear()
}

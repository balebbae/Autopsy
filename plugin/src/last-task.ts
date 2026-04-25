// In-memory buffer holding the most recent user-message text observed on the
// opencode bus. Populated by `onEvent` (see handlers/event.ts) and read by
// `onToolBefore` to enrich the `task` field on `/v1/preflight`.
//
// Process-local on purpose: opencode runs one plugin instance per session, so
// this buffer's lifetime matches the run we care about.

let _latest: string | null = null

export function setLatestUserMessage(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  _latest = trimmed
}

export function latestUserMessage(): string | null {
  return _latest
}

// Test-only reset; do not call from production code paths.
export function _resetLatestUserMessage(): void {
  _latest = null
}

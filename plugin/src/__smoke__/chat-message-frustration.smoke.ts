// Smoke test for frustration detection in the chat-message handler.
// Run with:
//   bun plugin/src/__smoke__/chat-message-frustration.smoke.ts
// Exits 0 on success, 1 on failure. No test framework — keep it dumb.

import { firedSessions } from "../handlers/frustration.ts"

// ── Intercept network calls ────────────────────────────────────────
// The handler calls postRejection / postFeedback / postEvents which
// all hit fetch(). We monkey-patch globalThis.fetch to capture those
// calls and assert on them.

type FetchRecord = { url: string; body: unknown }
const fetchCalls: FetchRecord[] = []

const origFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  let body: unknown = null
  if (init?.body && typeof init.body === "string") {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = init.body
    }
  }
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  fetchCalls.push({ url, body })
  return new Response(null, { status: 200 })
}) as typeof fetch

// ── Helpers ────────────────────────────────────────────────────────

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    console.error("fetchCalls:", JSON.stringify(fetchCalls, null, 2))
    process.exit(1)
  }
}

function resetState() {
  fetchCalls.length = 0
  firedSessions.clear()
}

// Dynamic import so the monkey-patched fetch is in place before
// the module's transitive dependencies cache anything.
const { onChatMessage } = await import("../handlers/chat-message.ts")
const { flush: flushBatcher } = await import("../batcher.ts")

const makeParts = (text: string) => [{ type: "text", text }]
const ctx = { project: { id: "proj-1" }, worktree: "/tmp/wt" }

// ── Test 1: frustrated message triggers rejection + feedback ──────

resetState()
await onChatMessage(
  { sessionID: "run-1" },
  { parts: makeParts("this is fucking broken") },
  ctx,
)

const rejectionCalls = fetchCalls.filter((c) => c.url.includes("/rejections"))
assert(rejectionCalls.length === 1, `expected 1 rejection call, got ${rejectionCalls.length}`)
const rejBody = rejectionCalls[0]!.body as Record<string, unknown>
assert(
  rejBody.failure_mode === "frustrated_user",
  `expected failure_mode=frustrated_user, got ${rejBody.failure_mode}`,
)

const feedbackCalls = fetchCalls.filter((c) => c.url.includes("/feedback"))
assert(feedbackCalls.length === 1, `expected 1 feedback call, got ${feedbackCalls.length}`)

// ── Test 2: chat.message event is always emitted ──────────────────

const eventCalls = fetchCalls.filter((c) => c.url.includes("/events"))
assert(eventCalls.length >= 1, `expected at least 1 /events call, got ${eventCalls.length}`)

// Find the chat.message event in the batched payloads.
let chatMsgFound = false
for (const ec of eventCalls) {
  const body = ec.body as { events?: Array<{ type: string; properties?: Record<string, unknown> }> }
  for (const ev of body.events ?? []) {
    if (ev.type === "chat.message") {
      assert(ev.properties?.role === "user", `expected role=user, got ${ev.properties?.role}`)
      assert(
        typeof ev.properties?.text === "string" && ev.properties.text.length > 0,
        `expected non-empty text in chat.message event`,
      )
      chatMsgFound = true
    }
  }
}
assert(chatMsgFound, "expected a chat.message event to be enqueued")

// ── Test 3: dedup — second frustrated message in same session does NOT re-fire ──

const prevRejectionCount = fetchCalls.filter((c) => c.url.includes("/rejections")).length
await onChatMessage(
  { sessionID: "run-1" },
  { parts: makeParts("you totally broke it again") },
  ctx,
)
const newRejectionCount = fetchCalls.filter((c) => c.url.includes("/rejections")).length
assert(
  newRejectionCount === prevRejectionCount,
  `expected dedup to prevent second rejection; had ${prevRejectionCount}, now ${newRejectionCount}`,
)

// ── Test 4: non-frustrated message emits chat.message but no rejection ──

resetState()
await onChatMessage(
  { sessionID: "run-2" },
  { parts: makeParts("please add a login page") },
  ctx,
)

const rej4 = fetchCalls.filter((c) => c.url.includes("/rejections"))
assert(rej4.length === 0, `expected 0 rejections for a calm message, got ${rej4.length}`)

// Flush the batcher so enqueued events are sent to the mock fetch.
await flushBatcher()

const ev4 = fetchCalls.filter((c) => c.url.includes("/events"))
let chatMsg4 = false
for (const ec of ev4) {
  const body = ec.body as { events?: Array<{ type: string }> }
  for (const ev of body.events ?? []) {
    if (ev.type === "chat.message") chatMsg4 = true
  }
}
assert(chatMsg4, "expected chat.message event even for a calm message")

// ── Test 5: shared dedup across event.ts and chat-message.ts ──────
// Verify that the firedSessions Set is the same instance: if we mark
// a session via the chat-message path, the event.ts path should see
// it as already fired (we can only test the Set import is shared).

resetState()
firedSessions.add("run-shared")
await onChatMessage(
  { sessionID: "run-shared" },
  { parts: makeParts("this is garbage") },
  ctx,
)
await flushBatcher()
const rejShared = fetchCalls.filter((c) => c.url.includes("/rejections"))
assert(
  rejShared.length === 0,
  `expected shared dedup to block rejection; got ${rejShared.length}`,
)

// ── Cleanup ────────────────────────────────────────────────────────
globalThis.fetch = origFetch
console.log("ok")

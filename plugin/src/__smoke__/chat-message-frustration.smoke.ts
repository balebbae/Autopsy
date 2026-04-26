// Smoke test for frustration detection in the chat-message handler.
// Run with:
//   bun plugin/src/__smoke__/chat-message-frustration.smoke.ts
// Exits 0 on success, 1 on failure. No test framework — keep it dumb.

import { FRUSTRATION_RE, firedSessions } from "../handlers/frustration.ts"

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

// ── Test 6: subtle frustration ("wasnt great … try again") triggers rejection ──

resetState()
await onChatMessage(
  { sessionID: "run-subtle" },
  { parts: makeParts("that wasnt great can you try again make sure eveything works") },
  ctx,
)
const rejSubtle = fetchCalls.filter((c) => c.url.includes("/rejections"))
assert(rejSubtle.length === 1, `expected 1 rejection for subtle frustration, got ${rejSubtle.length}`)
const rejSubtleBody = rejSubtle[0]!.body as Record<string, unknown>
assert(
  rejSubtleBody.failure_mode === "frustrated_user",
  `expected failure_mode=frustrated_user for subtle frustration, got ${rejSubtleBody.failure_mode}`,
)

// ── Test 7: broad pattern coverage ────────────────────────────────
// Verify that FRUSTRATION_RE catches a wide range of frustration signals.

const shouldMatch = [
  // Profanity
  "shit", "this is fucking broken", "wtf", "ffs", "damn it", "bullshit",
  // Insults
  "trash", "garbage", "useless", "pathetic", "incompetent", "ridiculous",
  // Exasperation
  "this sucks", "omg", "come on", "are you kidding", "unbelievable",
  "seriously", "ugh", "bruh", "smh", "give me a break",
  // Direct negative
  "that's wrong", "this is broken", "not working", "still broken",
  "doesn't work", "didn't work", "way off", "not even close",
  "wasn't great", "not good", "not helpful", "missed the point",
  // Blame
  "you broke it", "you messed up", "what did you do", "what have you done",
  "pay attention", "can you even read", "did you even look",
  // Not what asked
  "not what i asked", "i already said", "i literally told you",
  "read the instructions", "follow instructions", "i didn't ask for that",
  // Redo/revert
  "redo this", "start over", "try again", "do it again", "undo this",
  "revert it", "roll back", "change it back", "put it back",
  // Stop
  "don't do that", "stop it", "just stop", "cut it out", "enough already",
  // Giving up
  "forget it", "never mind", "i'll do it myself", "i give up",
  "waste of time", "thanks for nothing",
  // Worse than before
  "worse than before", "even worse", "it was working before",
  "you just made it worse", "regression",
  // Repeated failure
  "same mistake", "keeps happening", "you keep doing", "over and over",
  "how many times", "already told you",
  // Questioning ability
  "how hard can it be", "it's not that hard", "this should be easy",
  // Disappointment
  "disappointed", "let down", "expected better", "what a mess",
  // Hate
  "hate this", "sick of this", "fed up", "frustrating", "annoying",
  // Subtle compound
  "that wasnt great can you try again make sure eveything works",
  "no no no this is all wrong",
  "i already told you to do it differently",
  "this is a waste of my time",
  "it was fine before you changed it",
]

for (const phrase of shouldMatch) {
  assert(
    FRUSTRATION_RE.test(phrase),
    `expected FRUSTRATION_RE to match: "${phrase}"`,
  )
}

// ── Test 8: neutral / instructional messages should NOT match ──────

const shouldNotMatch = [
  "please add a login page",
  "can you refactor the database module",
  "update the README with instructions",
  "fix the bug in auth.ts line 42",
  "what does this function do",
  "run the tests",
  "looks good to me",
  "thanks that works perfectly",
  "great job",
  "nice work on that feature",
  "can you explain how this works",
  "add error handling to the API",
  "deploy to staging",
  "merge this into main",
  "create a new component for the sidebar",
]

for (const phrase of shouldNotMatch) {
  assert(
    !FRUSTRATION_RE.test(phrase),
    `expected FRUSTRATION_RE NOT to match neutral phrase: "${phrase}"`,
  )
}

// ── Cleanup ────────────────────────────────────────────────────────
globalThis.fetch = origFetch
console.log("ok")

// Smoke test for `handlers/event.ts` lifecycle handling. Run with:
//   bun plugin/src/__smoke__/event-lifecycle.smoke.ts
// Exits 0 on success, 1 on failure. No test framework — keep it dumb.
//
// Covers the new shutdown-detection logic added in R0:
//   - session.deleted on a tracked session POSTs /outcome with aborted
//     and removes that session from the tracked set
//   - server.instance.disposed POSTs /outcome for every tracked session
//   - server.instance.disposed with no tracked sessions is a no-op
//   - session.deleted carries the session id in `properties.info.id`
//     (NOT properties.sessionID), and we extract from there
//   - tracking happens for any event type that has a sessionID, so
//     subsequent shutdowns include sessions whose only event was a
//     mundane one like message.part.updated

import { _activeSessions, _resetEventState, onEvent } from "../handlers/event.ts"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- harness --------------------------------------------------------------

type Captured = { url: string; body: any }
const captured: Captured[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url
  let body: any = undefined
  try {
    body = init?.body ? JSON.parse(init.body) : undefined
  } catch {
    body = init?.body
  }
  captured.push({ url, body })
  return new Response(null, { status: 204 })
}) as typeof fetch

const ctx = { project: { id: "proj" }, worktree: "/tmp/wt" }

const reset = () => {
  captured.length = 0
  _resetEventState()
}

// Helper to filter the captured calls by suffix (avoids hardcoding the
// AAG_URL the plugin's config picked up from env).
const callsTo = (suffix: string) =>
  captured.filter((c) => typeof c.url === "string" && c.url.endsWith(suffix))

const outcomeCalls = () =>
  captured.filter(
    (c) => typeof c.url === "string" && /\/v1\/runs\/[^/]+\/outcome$/.test(c.url),
  )

// Pull the run id out of "<base>/v1/runs/<id>/outcome".
const outcomeRunId = (url: string): string => {
  const m = url.match(/\/v1\/runs\/([^/]+)\/outcome$/)
  return m?.[1] ?? ""
}

// Set.size narrows to a literal under noUncheckedIndexedAccess + control
// flow analysis when used in `assert`s, leading to spurious "this comparison
// appears to be unintentional" errors after we await an event handler that
// mutates the set. Reading via this helper keeps the type as plain `number`.
const trackedCount = (): number => _activeSessions.size

// --- tests ----------------------------------------------------------------

async function test_session_deleted_posts_aborted_outcome() {
  reset()
  // First record some activity so the session is tracked.
  await onEvent(
    {
      event: {
        type: "session.created",
        properties: { sessionID: "ses-A", info: { title: "test" } },
      },
    },
    ctx,
  )
  assert(_activeSessions.has("ses-A"), "session.created should track ses-A")

  await onEvent(
    {
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses-A", title: "test" } },
      },
    },
    ctx,
  )

  const outcomes = outcomeCalls()
  assert(outcomes.length === 1, `expected 1 outcome POST, got ${outcomes.length}`)
  const first = outcomes[0]
  assert(first !== undefined, "outcome[0] should be defined")
  assert(outcomeRunId(first.url) === "ses-A", "outcome URL should target ses-A")
  assert(
    first.body?.outcome === "aborted",
    `outcome body should be aborted, got ${JSON.stringify(first.body)}`,
  )
  assert(!_activeSessions.has("ses-A"), "ses-A should be untracked after session.deleted")

  // The session.deleted event itself should also have been forwarded as an
  // event row so the timeline records when the session ended.
  const eventBatches = callsTo("/v1/events")
  const sentTypes = eventBatches.flatMap((b) =>
    (b.body?.events ?? []).map((e: any) => e.type),
  )
  assert(
    sentTypes.includes("session.deleted"),
    `session.deleted should be persisted on timeline; got ${sentTypes.join(",")}`,
  )

  console.log("ok session.deleted → /outcome aborted")
}

async function test_session_deleted_falls_back_to_session_id_field() {
  reset()
  // Some opencode versions do include sessionID at the top level.
  await onEvent(
    {
      event: {
        type: "session.created",
        properties: { sessionID: "ses-B", info: { title: "t" } },
      },
    },
    ctx,
  )
  await onEvent(
    {
      event: {
        type: "session.deleted",
        // Both sessionID and info.id are present. We should still emit
        // exactly one outcome POST (no double-fire).
        properties: { sessionID: "ses-B", info: { id: "ses-B" } },
      },
    },
    ctx,
  )
  const outcomes = outcomeCalls()
  assert(outcomes.length === 1, `expected 1 outcome POST, got ${outcomes.length}`)
  const first = outcomes[0]
  assert(first !== undefined, "outcome[0] should be defined")
  assert(outcomeRunId(first.url) === "ses-B", "outcome should target ses-B")
  console.log("ok session.deleted with sessionID + info.id present (no double-fire)")
}

async function test_server_instance_disposed_posts_for_all_tracked() {
  reset()
  // Track three sessions via routine events.
  for (const id of ["ses-1", "ses-2", "ses-3"]) {
    await onEvent(
      {
        event: {
          type: "session.created",
          properties: { sessionID: id, info: { title: id } },
        },
      },
      ctx,
    )
  }
  assert(trackedCount() === 3, `expected 3 tracked sessions, got ${trackedCount()}`)

  await onEvent(
    {
      event: {
        type: "server.instance.disposed",
        properties: { directory: "/tmp/wt" },
      },
    },
    ctx,
  )

  const outcomes = outcomeCalls()
  assert(outcomes.length === 3, `expected 3 outcome POSTs, got ${outcomes.length}`)
  const targetedIds = new Set(outcomes.map((o) => outcomeRunId(o.url)))
  for (const id of ["ses-1", "ses-2", "ses-3"]) {
    assert(targetedIds.has(id), `outcome should target ${id}; got ${[...targetedIds].join(",")}`)
  }
  for (const o of outcomes) {
    assert(o.body?.outcome === "aborted", `outcome should be aborted, got ${JSON.stringify(o.body)}`)
  }
  assert(trackedCount() === 0, "all tracked sessions should be cleared")
  console.log("ok server.instance.disposed → /outcome for every tracked session")
}

async function test_server_instance_disposed_no_tracked_sessions_is_noop() {
  reset()
  await onEvent(
    {
      event: {
        type: "server.instance.disposed",
        properties: { directory: "/tmp/wt" },
      },
    },
    ctx,
  )
  const outcomes = outcomeCalls()
  assert(outcomes.length === 0, `expected no outcome POSTs, got ${outcomes.length}`)
  console.log("ok server.instance.disposed with no tracked sessions is a no-op")
}

async function test_chatty_event_still_tracks_session() {
  // Even noisy events that get filtered out before persistence should
  // still cause us to track the session for shutdown handling — otherwise
  // a session that only saw chatty events would never be aborted on
  // server.instance.disposed.
  reset()
  await onEvent(
    {
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses-chatty",
          part: { type: "text", text: "hello world" },
          // no time field — looks like user text
        },
      },
    },
    ctx,
  )
  // Slight wait to let the batcher flush spawn / settle.
  await sleep(10)
  assert(
    _activeSessions.has("ses-chatty"),
    "ses-chatty should be tracked even though message.part.updated is mostly noise",
  )
  console.log("ok chatty event types still track the session")
}

async function main() {
  try {
    await test_session_deleted_posts_aborted_outcome()
    await test_session_deleted_falls_back_to_session_id_field()
    await test_server_instance_disposed_posts_for_all_tracked()
    await test_server_instance_disposed_no_tracked_sessions_is_noop()
    await test_chatty_event_still_tracks_session()
    console.log("\nall lifecycle smoke tests passed ✓")
  } finally {
    globalThis.fetch = realFetch
  }
}

main().catch((err) => {
  console.error("unhandled error:", err)
  process.exit(1)
})

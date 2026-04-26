// Smoke test for `handlers/tool-before.ts`. Run with:
//   bun plugin/src/__smoke__/tool-before.smoke.ts
// Exits 0 on success, 1 on failure. No test framework — keep it dumb.
//
// Covers the Option-2 implementation:
//   - skips tools outside config.preflight.tools
//   - calls preflight for every tool in the set (incl. read/grep)
//   - block: true throws a rich rationale + emits aag.preflight.blocked
//   - non-blocking risk emits aag.preflight.warned (no throw)
//   - duplicate warnings within one session are deduped
//   - distinct (tool, args) pairs are NOT deduped
//   - service timeout / non-200 fails open (no throw, no event)
//   - buildBlockMessage cites similar_runs / failure_modes / fixes

import {
  _resetToolBefore,
  buildBlockMessage,
  onToolBefore,
} from "../handlers/tool-before.ts"
import { _resetLatestUserMessage, setLatestUserMessage } from "../last-task.ts"
import type { PreflightResponse } from "../types.ts"

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

// Per-test scripted preflight response. Set this before each test; the
// fake fetch reads it for `/v1/preflight` calls. Calls to `/v1/events`
// are recorded but always return 204.
let scriptedPreflight: { status: number; body?: PreflightResponse; delayMs?: number } = {
  status: 200,
  body: { risk_level: "none" },
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url
  let body: any = undefined
  try {
    body = init?.body ? JSON.parse(init.body) : undefined
  } catch {
    body = init?.body
  }
  captured.push({ url, body })

  if (typeof url === "string" && url.endsWith("/v1/preflight")) {
    if (scriptedPreflight.delayMs) await sleep(scriptedPreflight.delayMs)
    if (init?.signal?.aborted) {
      // Mirror the abort behaviour real fetch would exhibit: throw and
      // let the client.ts `.catch(() => null)` swallow it.
      const e = new Error("aborted") as Error & { name: string }
      e.name = "AbortError"
      throw e
    }
    return new Response(
      scriptedPreflight.body ? JSON.stringify(scriptedPreflight.body) : null,
      { status: scriptedPreflight.status },
    )
  }

  return new Response(null, { status: 204 })
}) as typeof fetch

const ctx = { project: { id: "proj" }, worktree: "/tmp/wt" }

const reset = () => {
  captured.length = 0
  _resetToolBefore()
  _resetLatestUserMessage()
  setLatestUserMessage("user wants a feature")
  scriptedPreflight = { status: 200, body: { risk_level: "none" } }
}

const flushBatcher = async () => {
  // The batcher flushes every 200ms or on FLUSH_MAX events. Wait long
  // enough for the timer to fire so we can assert on the events POST.
  await sleep(250)
}

const eventTypes = (urls: Captured[]): string[] => {
  const out: string[] = []
  for (const c of urls) {
    if (!c.url.endsWith("/v1/events")) continue
    const evs = c.body?.events ?? []
    for (const e of evs) out.push(e.type)
  }
  return out
}

const eventsOfType = (urls: Captured[], type: string): any[] => {
  const out: any[] = []
  for (const c of urls) {
    if (!c.url.endsWith("/v1/events")) continue
    for (const e of c.body?.events ?? []) {
      if (e.type === type) out.push(e)
    }
  }
  return out
}

// --- tests ----------------------------------------------------------------

async function testSkipsUnknownTool() {
  reset()
  await onToolBefore(
    { sessionID: "s1", tool: "list_directory" },
    { args: { path: "/tmp" } },
    ctx,
  )
  await flushBatcher()
  const preflightCalls = captured.filter((c) => c.url.endsWith("/v1/preflight"))
  assert(
    preflightCalls.length === 0,
    `tool not in preflight set should NOT call preflight; saw ${preflightCalls.length}`,
  )
  assert(eventTypes(captured).length === 0, "no events should be emitted for skipped tool")
}

async function testReadAndGrepArePreflighted() {
  for (const tool of ["read", "grep", "edit", "write", "bash"]) {
    reset()
    await onToolBefore({ sessionID: `s-${tool}`, tool }, { args: { x: 1 } }, ctx)
    const preflightCalls = captured.filter((c) => c.url.endsWith("/v1/preflight"))
    assert(
      preflightCalls.length === 1,
      `tool "${tool}" should be preflighted; saw ${preflightCalls.length}`,
    )
    assert(
      preflightCalls[0]!.body?.tool === tool,
      `preflight body should carry tool="${tool}"; got ${preflightCalls[0]!.body?.tool}`,
    )
  }
}

async function testNoneRiskEmitsNothing() {
  reset()
  scriptedPreflight = { status: 200, body: { risk_level: "none" } }
  await onToolBefore({ sessionID: "s2", tool: "edit" }, { args: { path: "a.ts" } }, ctx)
  await flushBatcher()
  const types = eventTypes(captured)
  assert(
    !types.includes("aag.preflight.warned") && !types.includes("aag.preflight.blocked"),
    `no preflight events on risk=none; saw ${types.join(",")}`,
  )
}

async function testWarnedEventEmittedOnRisk() {
  reset()
  scriptedPreflight = {
    status: 200,
    body: {
      risk_level: "medium",
      similar_runs: ["run-abc"],
      missing_followups: ["frontend_backend_drift"],
      recommended_checks: ["update openapi.yaml"],
      system_addendum: "Past run abc updated only the schema; remember to also touch openapi.yaml.",
    },
  }
  await onToolBefore({ sessionID: "s3", tool: "edit" }, { args: { path: "a.ts" } }, ctx)
  await flushBatcher()
  const warned = eventsOfType(captured, "aag.preflight.warned")
  assert(
    warned.length === 1,
    `expected 1 warned event on medium risk; saw ${warned.length}`,
  )
  const props = warned[0]!.properties
  assert(props.tool === "edit", "warned event should carry tool name")
  assert(props.risk_level === "medium", "warned event should carry risk_level")
  assert(
    Array.isArray(props.similar_runs) && props.similar_runs.includes("run-abc"),
    `warned event should carry similar_runs; got ${JSON.stringify(props.similar_runs)}`,
  )
  assert(
    typeof props.system_addendum === "string" && props.system_addendum.includes("openapi"),
    "warned event should carry system_addendum text",
  )
}

async function testWarnedNeverThrows() {
  reset()
  scriptedPreflight = {
    status: 200,
    body: {
      risk_level: "high",
      block: false,
      missing_followups: ["incomplete_schema_change"],
    },
  }
  let threw = false
  try {
    await onToolBefore(
      { sessionID: "s-nothrow", tool: "edit" },
      { args: { path: "a.ts" } },
      ctx,
    )
  } catch {
    threw = true
  }
  assert(!threw, "non-blocking high risk should NOT throw — only blocks throw")
}

async function testBlockedThrowsRichRationale() {
  reset()
  scriptedPreflight = {
    status: 200,
    body: {
      risk_level: "high",
      block: true,
      reason: "Autopsy: similar past tasks failed with frontend_backend_drift (score 4.20).",
      similar_runs: ["run-1", "run-2"],
      missing_followups: ["frontend_backend_drift"],
      recommended_checks: ["update openapi.yaml"],
      system_addendum: "Update both contracts/openapi.yaml AND the FE client when changing routes.",
    },
  }
  let err: Error | null = null
  try {
    await onToolBefore(
      { sessionID: "s-block", tool: "edit" },
      { args: { path: "service/routes.py" } },
      ctx,
    )
  } catch (e: any) {
    err = e as Error
  }
  assert(err !== null, "block: true should throw")
  const msg = err!.message
  assert(msg.startsWith("[Autopsy]"), `error message should be Autopsy-tagged; got: ${msg}`)
  assert(
    msg.includes("frontend_backend_drift"),
    `error should cite the failure mode; got: ${msg}`,
  )
  assert(msg.includes("openapi.yaml"), `error should cite the recommended fix; got: ${msg}`)
  assert(msg.includes("run-1"), `error should cite at least one similar run id; got: ${msg}`)

  await flushBatcher()
  const blocked = eventsOfType(captured, "aag.preflight.blocked")
  assert(
    blocked.length === 1,
    `expected one aag.preflight.blocked event; saw ${blocked.length}`,
  )
  assert(blocked[0]!.properties.tool === "edit", "blocked event should carry tool name")
  assert(
    typeof blocked[0]!.properties.reason === "string" &&
      blocked[0]!.properties.reason.includes("frontend_backend_drift"),
    "blocked event should carry the rich reason",
  )
}

async function testWarnDedup() {
  reset()
  scriptedPreflight = {
    status: 200,
    body: {
      risk_level: "low",
      missing_followups: ["something"],
    },
  }
  // Same session, tool, args, risk_level → only the first should fire.
  for (let i = 0; i < 4; i++) {
    await onToolBefore({ sessionID: "s-dup", tool: "read" }, { args: { path: "a.ts" } }, ctx)
  }
  await flushBatcher()
  const warned = eventsOfType(captured, "aag.preflight.warned")
  assert(
    warned.length === 1,
    `dedup: identical (session,tool,args) should emit once; saw ${warned.length}`,
  )

  // Distinct args → fires again.
  await onToolBefore({ sessionID: "s-dup", tool: "read" }, { args: { path: "b.ts" } }, ctx)
  await flushBatcher()
  const warned2 = eventsOfType(captured, "aag.preflight.warned")
  assert(
    warned2.length === 2,
    `distinct args should bypass dedup; saw ${warned2.length} after second tool call`,
  )

  // Distinct session → fires again.
  await onToolBefore({ sessionID: "s-other", tool: "read" }, { args: { path: "a.ts" } }, ctx)
  await flushBatcher()
  const warned3 = eventsOfType(captured, "aag.preflight.warned")
  assert(
    warned3.length === 3,
    `distinct session should bypass dedup; saw ${warned3.length}`,
  )
}

async function testBlockNeverDeduped() {
  reset()
  scriptedPreflight = {
    status: 200,
    body: {
      risk_level: "high",
      block: true,
      reason: "test block",
      missing_followups: ["fm"],
    },
  }
  // Each block call should emit an event AND throw — the dedup map is for
  // warnings only.
  let throws = 0
  for (let i = 0; i < 3; i++) {
    try {
      await onToolBefore(
        { sessionID: "s-block-dedup", tool: "edit" },
        { args: { path: "a.ts" } },
        ctx,
      )
    } catch {
      throws++
    }
  }
  await flushBatcher()
  const blocked = eventsOfType(captured, "aag.preflight.blocked")
  assert(throws === 3, `every block call should throw; saw ${throws}`)
  assert(
    blocked.length === 3,
    `every block call should emit a fresh event; saw ${blocked.length}`,
  )
}

async function testTimeoutFailsOpen() {
  reset()
  // Force a fast timeout for this test.
  const cfgMod = await import("../config.ts")
  const orig = cfgMod.config.preflight.timeoutMs
  // @ts-ignore — test-only mutation
  cfgMod.config.preflight.timeoutMs = 25
  scriptedPreflight = {
    status: 200,
    body: { risk_level: "high", block: true, reason: "would block" },
    delayMs: 200, // longer than the 25ms timeout
  }
  let threw = false
  try {
    await onToolBefore(
      { sessionID: "s-timeout", tool: "edit" },
      { args: { path: "a.ts" } },
      ctx,
    )
  } catch {
    threw = true
  } finally {
    // @ts-ignore — restore
    cfgMod.config.preflight.timeoutMs = orig
  }
  assert(!threw, "preflight timeout should fail open (no throw)")
  await flushBatcher()
  const types = eventTypes(captured)
  assert(
    !types.includes("aag.preflight.blocked") && !types.includes("aag.preflight.warned"),
    `timeout should emit no preflight events; saw ${types.join(",")}`,
  )
}

async function testNon200FailsOpen() {
  reset()
  scriptedPreflight = { status: 503 }
  let threw = false
  try {
    await onToolBefore(
      { sessionID: "s-503", tool: "edit" },
      { args: { path: "a.ts" } },
      ctx,
    )
  } catch {
    threw = true
  }
  assert(!threw, "service 5xx should fail open")
}

async function testDisabledFlagSkipsAll() {
  reset()
  const cfgMod = await import("../config.ts")
  // @ts-ignore — test-only mutation
  cfgMod.config.preflight.disabled = true
  scriptedPreflight = {
    status: 200,
    body: { risk_level: "high", block: true, reason: "would block" },
  }
  try {
    let threw = false
    try {
      await onToolBefore(
        { sessionID: "s-off", tool: "edit" },
        { args: { path: "a.ts" } },
        ctx,
      )
    } catch {
      threw = true
    }
    assert(!threw, "disabled preflight should not throw, even on block-script")
    const preflightCalls = captured.filter((c) => c.url.endsWith("/v1/preflight"))
    assert(
      preflightCalls.length === 0,
      `disabled preflight should skip the HTTP call; saw ${preflightCalls.length}`,
    )
  } finally {
    // @ts-ignore — restore
    cfgMod.config.preflight.disabled = false
  }
}

async function testBuildBlockMessageWithoutAddendum() {
  const reason = buildBlockMessage({
    risk_level: "high",
    block: true,
    similar_runs: ["r-1", "r-2"],
    missing_followups: ["incomplete_schema_change"],
    recommended_checks: ["update db-schema.sql"],
  })
  assert(reason.startsWith("[Autopsy]"), "message should be Autopsy-tagged")
  assert(
    reason.includes("incomplete_schema_change"),
    `should fall back to missing_followups; got: ${reason}`,
  )
  assert(reason.includes("db-schema.sql"), `should cite recommended fix; got: ${reason}`)
  assert(reason.includes("r-1"), `should cite a similar past run id; got: ${reason}`)
}

async function testBuildBlockMessagePrefersAddendum() {
  const reason = buildBlockMessage({
    risk_level: "high",
    block: true,
    system_addendum: "Past runs touched openapi.yaml; mirror your edit there.",
    missing_followups: ["fm"],
    recommended_checks: ["check"],
    similar_runs: ["r-1"],
  })
  assert(
    reason.includes("openapi.yaml"),
    `should embed system_addendum verbatim; got: ${reason}`,
  )
  assert(
    !reason.includes("Past failure modes:"),
    `addendum should suppress the structured-fields fallback; got: ${reason}`,
  )
  assert(reason.includes("r-1"), "similar runs should still be appended after the addendum")
}

// --- driver ---------------------------------------------------------------

async function main() {
  try {
    await testSkipsUnknownTool()
    await testReadAndGrepArePreflighted()
    await testNoneRiskEmitsNothing()
    await testWarnedEventEmittedOnRisk()
    await testWarnedNeverThrows()
    await testBlockedThrowsRichRationale()
    await testWarnDedup()
    await testBlockNeverDeduped()
    await testTimeoutFailsOpen()
    await testNon200FailsOpen()
    await testDisabledFlagSkipsAll()
    await testBuildBlockMessageWithoutAddendum()
    await testBuildBlockMessagePrefersAddendum()
    console.log("ok")
  } catch (err) {
    console.error("FAIL: unhandled exception", err)
    process.exit(1)
  } finally {
    globalThis.fetch = realFetch
  }
}

await main()

// Smoke test for `handlers/system.ts`. Run with:
//   bun plugin/src/__smoke__/system-transform.smoke.ts
// Exits 0 on success, 1 on failure. No test framework.
//
// Covers:
//   - injects the baseline rejection-reporting prompt
//   - uses the session-scoped latest-user-message buffer
//   - falls back to opencode `session.messages` when the buffer is empty
//   - emits `aag.system.injected` only when an addendum was pushed

import { onSystemTransform } from "../handlers/system.ts"
import { _resetLatestUserMessage, setLatestUserMessage } from "../last-task.ts"
import type { PreflightResponse } from "../types.ts"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Captured = { url: string; body: any }
const captured: Captured[] = []
const realFetch = globalThis.fetch

let scriptedPreflight: { status: number; body?: PreflightResponse } = {
  status: 200,
  body: {
    risk_level: "medium",
    similar_runs: ["run-1"],
    system_addendum: "Check the OpenAPI and dashboard client together.",
  },
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
    return new Response(
      scriptedPreflight.body ? JSON.stringify(scriptedPreflight.body) : null,
      { status: scriptedPreflight.status },
    )
  }

  return new Response(null, { status: 204 })
}) as typeof fetch

const reset = () => {
  captured.length = 0
  _resetLatestUserMessage()
  scriptedPreflight = {
    status: 200,
    body: {
      risk_level: "medium",
      similar_runs: ["run-1"],
      system_addendum: "Check the OpenAPI and dashboard client together.",
    },
  }
}

const flushBatcher = async () => {
  await sleep(250)
}

const preflightCalls = () => captured.filter((c) => c.url.endsWith("/v1/preflight"))

const injectedEvents = () => {
  const out: any[] = []
  for (const c of captured) {
    if (!c.url.endsWith("/v1/events")) continue
    for (const e of c.body?.events ?? []) {
      if (e.type === "aag.system.injected") out.push(e)
    }
  }
  return out
}

async function testBufferedTaskInjectsAddendum() {
  reset()
  setLatestUserMessage("change the API", "ses-buffer")

  const output = { system: [] as string[] }
  await onSystemTransform(
    { sessionID: "ses-buffer" },
    output,
    { project: { id: "proj" }, worktree: "/tmp/wt", directory: "/tmp/wt" },
  )
  await flushBatcher()

  assert(output.system.length === 2, `expected 2 system entries, got ${output.system.length}`)
  assert(
    output.system[1]?.includes("OpenAPI"),
    `expected addendum in system prompt, got ${JSON.stringify(output.system)}`,
  )
  const calls = preflightCalls()
  assert(calls.length === 1, `expected one preflight call, got ${calls.length}`)
  assert(calls[0]?.body?.task === "change the API", "preflight should use buffered task")
  const injected = injectedEvents()
  assert(injected.length === 1, "should emit aag.system.injected")
  assert(
    injected[0]?.properties?.system_addendum === "Check the OpenAPI and dashboard client together.",
    "injected event should include the addendum text for dashboard/debugging",
  )
  assert(
    injected[0]?.properties?.system_count_after === 2,
    "injected event should include the post-injection system count",
  )
}

async function testSessionMessagesFallbackInjectsAddendum() {
  reset()
  let messagesCalled = 0
  const client = {
    session: {
      messages: async () => {
        messagesCalled += 1
        return [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "older assistant text" }],
          },
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "please update the dashboard" }],
          },
        ]
      },
    },
  }

  const output = { system: [] as string[] }
  await onSystemTransform(
    { sessionID: "ses-fallback" },
    output,
    {
      project: { id: "proj" },
      worktree: "/tmp/wt",
      directory: "/tmp/wt",
      client,
    },
  )
  await flushBatcher()

  assert(messagesCalled === 1, `expected session.messages fallback, got ${messagesCalled}`)
  assert(output.system.length === 2, `expected addendum injection, got ${output.system.length}`)
  const calls = preflightCalls()
  assert(calls.length === 1, `expected one preflight call, got ${calls.length}`)
  assert(
    calls[0]?.body?.task === "please update the dashboard",
    `fallback task mismatch: ${JSON.stringify(calls[0]?.body)}`,
  )
  assert(injectedEvents().length === 1, "fallback path should emit injection event")
}

async function testToastIsOptIn() {
  reset()
  setLatestUserMessage("change the API", "ses-toast")
  let toastCalls = 0
  const client = {
    tui: {
      showToast: async () => {
        toastCalls += 1
      },
    },
  }

  const output = { system: [] as string[] }
  await onSystemTransform(
    { sessionID: "ses-toast" },
    output,
    { project: { id: "proj" }, worktree: "/tmp/wt", directory: "/tmp/wt", client },
  )
  await flushBatcher()

  assert(toastCalls === 0, "TUI toast should be opt-in via AAG_PREFLIGHT_TUI_TOAST")
}

async function testNoTaskOnlyAddsBaselinePrompt() {
  reset()
  const output = { system: [] as string[] }
  await onSystemTransform(
    { sessionID: "ses-empty" },
    output,
    { project: { id: "proj" }, worktree: "/tmp/wt", directory: "/tmp/wt" },
  )
  await flushBatcher()

  assert(output.system.length === 1, `expected only baseline prompt, got ${output.system.length}`)
  assert(preflightCalls().length === 0, "no task should skip preflight")
  assert(injectedEvents().length === 0, "no addendum should skip injection event")
}

async function main() {
  try {
    await testBufferedTaskInjectsAddendum()
    await testSessionMessagesFallbackInjectsAddendum()
    await testToastIsOptIn()
    await testNoTaskOnlyAddsBaselinePrompt()
    console.log("ok")
  } finally {
    globalThis.fetch = realFetch
  }
}

main().catch((err) => {
  console.error("unhandled error:", err)
  process.exit(1)
})

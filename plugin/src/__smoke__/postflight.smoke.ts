// Smoke test for `postflight.ts`. Run with:
//   bun plugin/src/__smoke__/postflight.smoke.ts
// Exits 0 on success, 1 on failure. No test framework — keep it dumb.

import {
  _resetPostflight,
  bindPostflight,
  buildRejectionReason,
  cancelPostflight,
  getPostflightChecks,
  resolvePostflightBaseCwd,
  runPostflight,
  schedulePostflight,
  setPostflightChecks,
  type CheckResult,
} from "../postflight.ts"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- harness --------------------------------------------------------------

// In-memory capture for outbound HTTP. The postflight runner posts to
// `/v1/runs/:id/rejections` and `/v1/runs/:id/feedback` via the global
// `fetch`. We swap fetch with a recorder so we can assert without a real
// service running.
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

// Fake BunShell that returns scripted exit codes / stdout / stderr per
// command. The cwd / nothrow / quiet methods are no-ops for the test —
// we only care about exit-code propagation and the wiring.
type Scripted = {
  exitCode: number
  stdout?: string
  stderr?: string
  delayMs?: number
}
function makeFakeShell(scripts: Record<string, Scripted>): any {
  // The plugin invokes `$\`bash -c ${cmd}\``. Bun's template-literal call
  // receives strings = ["bash -c ", ""], expressions = [cmd]. We just
  // grab the cmd string, look up the script, and return a thenable that
  // simulates a BunShellPromise.
  const make = (cmd: string) => {
    const script = scripts[cmd] ?? { exitCode: 0, stdout: "", stderr: "" }
    const wait = script.delayMs ?? 0
    const mkResult = () => ({
      exitCode: script.exitCode,
      stdout: { toString: () => script.stdout ?? "" },
      stderr: { toString: () => script.stderr ?? "" },
    })
    const promise: any = (async () => {
      if (wait > 0) await sleep(wait)
      return mkResult()
    })()
    promise.cwd = () => promise
    promise.nothrow = () => promise
    promise.quiet = () => promise
    return promise
  }
  const $: any = (strings: TemplateStringsArray, ...exprs: any[]) => {
    // Grab the command argument we passed as `bash -c ${cmd}`.
    const cmd = String(exprs[0] ?? "")
    return make(cmd)
  }
  $.cwd = () => $
  $.nothrow = () => $
  $.throws = () => $
  $.env = () => $
  return $
}

// --- tests ----------------------------------------------------------------

async function testDefaultSuiteShape() {
  _resetPostflight()
  // Default checks should be the Autopsy suite.
  const defaults = getPostflightChecks()
  assert(defaults.length >= 4, `expected ≥4 default checks, got ${defaults.length}`)
  const names = defaults.map((c) => c.name)
  for (const required of [
    "service-lint",
    "service-test",
    "plugin-typecheck",
    "dashboard-typecheck",
  ]) {
    assert(names.includes(required), `default suite missing "${required}"`)
  }
}

async function testRunPostflightAllPass() {
  _resetPostflight()
  captured.length = 0
  setPostflightChecks([
    { name: "fast", cmd: "echo fast" },
    { name: "fast2", cmd: "echo fast2" },
  ])
  bindPostflight({
    $: makeFakeShell({
      "echo fast": { exitCode: 0, stdout: "ok\n" },
      "echo fast2": { exitCode: 0, stdout: "ok\n" },
    }),
  })
  const results = await runPostflight("session-pass")
  assert(results.length === 2, `expected 2 results, got ${results.length}`)
  for (const r of results) {
    assert(r.passed === true, `${r.name} should have passed; exit=${r.exitCode}`)
  }
  // No rejection fetch should have fired when everything passed.
  const rejectionCalls = captured.filter((c) => c.url.includes("/rejections"))
  assert(
    rejectionCalls.length === 0,
    `expected no rejection POST when all pass; saw ${rejectionCalls.length}`,
  )
  // But the events POST (for timeline started/completed) should have fired.
  const eventsCalls = captured.filter((c) => c.url.endsWith("/v1/events"))
  assert(
    eventsCalls.length >= 1,
    `expected ≥1 events POST for timeline rows; saw ${eventsCalls.length}`,
  )
}

async function testRunPostflightFilesRejection() {
  _resetPostflight()
  captured.length = 0
  setPostflightChecks([
    { name: "passing", cmd: "passing-cmd" },
    { name: "failing", cmd: "failing-cmd" },
  ])
  bindPostflight({
    $: makeFakeShell({
      "passing-cmd": { exitCode: 0, stdout: "ok" },
      "failing-cmd": { exitCode: 1, stderr: "lint: 3 errors found" },
    }),
    projectId: "test-project",
    worktree: "/tmp/test",
  })
  const results = await runPostflight("session-fail")
  assert(results.length === 2, `expected 2 results, got ${results.length}`)
  const failing = results.find((r) => r.name === "failing")
  assert(failing !== undefined, "missing 'failing' result")
  assert(failing!.passed === false, "'failing' should have failed")
  assert(failing!.exitCode === 1, `expected exit 1, got ${failing!.exitCode}`)

  const rejectionCalls = captured.filter((c) => c.url.includes("/rejections"))
  assert(
    rejectionCalls.length === 1,
    `expected one rejection POST; saw ${rejectionCalls.length}`,
  )
  const rejBody = rejectionCalls[0]!.body
  assert(
    rejBody.failure_mode === "automated_check_failed",
    `failure_mode should be automated_check_failed, got ${rejBody.failure_mode}`,
  )
  assert(
    typeof rejBody.symptoms === "string" && rejBody.symptoms.includes("failing_failed"),
    `symptoms should include failing_failed; got ${JSON.stringify(rejBody.symptoms)}`,
  )
  assert(
    typeof rejBody.reason === "string" && rejBody.reason.includes("lint: 3 errors found"),
    `reason should include the failing stderr tail; got ${JSON.stringify(rejBody.reason)}`,
  )

  // Feedback should also be filed so the run summary shows the latest reason.
  const feedbackCalls = captured.filter((c) => c.url.includes("/feedback"))
  assert(
    feedbackCalls.length === 1,
    `expected one feedback POST; saw ${feedbackCalls.length}`,
  )
}

async function testTimeoutMarksFailure() {
  _resetPostflight()
  captured.length = 0
  setPostflightChecks([
    { name: "slowpoke", cmd: "slow", timeoutMs: 30 },
  ])
  bindPostflight({
    $: makeFakeShell({
      slow: { exitCode: 0, stdout: "would-have-passed", delayMs: 200 },
    }),
  })
  const results = await runPostflight("session-timeout")
  assert(results.length === 1, "expected one result")
  const r = results[0]!
  assert(r.passed === false, "timeout should mark check as failed")
  assert(r.timedOut === true, "timedOut flag should be set")
  assert(
    r.exitCode === 124,
    `timeout should report exit 124 (the conventional code), got ${r.exitCode}`,
  )

  const rejectionCalls = captured.filter((c) => c.url.includes("/rejections"))
  assert(rejectionCalls.length === 1, "timeout should still file a rejection")
}

async function testInflightDedupe() {
  _resetPostflight()
  captured.length = 0
  setPostflightChecks([
    { name: "slow", cmd: "slowcmd" },
  ])
  bindPostflight({
    $: makeFakeShell({
      slowcmd: { exitCode: 0, stdout: "", delayMs: 60 },
    }),
  })

  // Kick off a run, then immediately try a second one. The second
  // should observe the inflight flag and bail out with [].
  const first = runPostflight("session-inflight")
  const second = runPostflight("session-inflight")
  const [r1, r2] = await Promise.all([first, second])
  assert(r1.length === 1, `first run should produce one result, got ${r1.length}`)
  assert(
    r2.length === 0,
    `second concurrent run should bail (inflight), got ${r2.length} results`,
  )
}

async function testSchedulerDebounce() {
  _resetPostflight()
  captured.length = 0
  process.env.AAG_POSTFLIGHT_DEBOUNCE_MS = "40"
  // Re-import isn't free in bun; force the config override by mutating
  // the process env BEFORE we pull the module. But the module is already
  // pulled in this file. So instead, exercise schedule via a low debounce
  // value baked into the existing config (by re-importing via dynamic
  // import).
  const cfgMod = await import("../config.ts")
  // @ts-ignore — test-only mutation
  cfgMod.config.postflight.debounceMs = 40
  setPostflightChecks([{ name: "scheduled", cmd: "scheduled-cmd" }])
  bindPostflight({
    $: makeFakeShell({
      "scheduled-cmd": { exitCode: 0, stdout: "ok" },
    }),
  })
  schedulePostflight("session-debounce")
  // Reschedule a few times within the debounce window — only the last
  // schedule should actually fire.
  await sleep(10)
  schedulePostflight("session-debounce")
  await sleep(10)
  schedulePostflight("session-debounce")
  // Now wait for the timer to fire and the run to complete.
  await sleep(120)
  // We expect at least one events POST (started + completed).
  const eventsCalls = captured.filter((c) => c.url.endsWith("/v1/events"))
  assert(
    eventsCalls.length >= 1,
    `scheduler should have fired; saw ${eventsCalls.length} events POSTs`,
  )
}

async function testCancelPostflight() {
  _resetPostflight()
  captured.length = 0
  const cfgMod = await import("../config.ts")
  // @ts-ignore — test-only mutation
  cfgMod.config.postflight.debounceMs = 40
  setPostflightChecks([{ name: "scheduled", cmd: "scheduled-cmd" }])
  bindPostflight({
    $: makeFakeShell({
      "scheduled-cmd": { exitCode: 0, stdout: "ok" },
    }),
  })
  schedulePostflight("session-cancel")
  cancelPostflight("session-cancel")
  await sleep(80)
  const eventsCalls = captured.filter((c) => c.url.endsWith("/v1/events"))
  assert(
    eventsCalls.length === 0,
    `cancelled schedule should NOT fire; saw ${eventsCalls.length} events POSTs`,
  )
}

async function testDisabledFlag() {
  _resetPostflight()
  captured.length = 0
  const cfgMod = await import("../config.ts")
  // @ts-ignore — test-only mutation
  cfgMod.config.postflight.disabled = true
  // @ts-ignore — test-only mutation
  cfgMod.config.postflight.debounceMs = 20
  setPostflightChecks([{ name: "scheduled", cmd: "scheduled-cmd" }])
  bindPostflight({
    $: makeFakeShell({
      "scheduled-cmd": { exitCode: 0, stdout: "ok" },
    }),
  })
  schedulePostflight("session-disabled")
  await sleep(60)
  const eventsCalls = captured.filter((c) => c.url.endsWith("/v1/events"))
  assert(
    eventsCalls.length === 0,
    `disabled postflight should NOT fire; saw ${eventsCalls.length} events POSTs`,
  )
  // @ts-ignore — restore for any subsequent tests
  cfgMod.config.postflight.disabled = false
}

async function testRepeatedFailureDedup() {
  _resetPostflight()
  captured.length = 0
  // Two checks; one always fails with the same error. We expect the FIRST
  // run to file a rejection, and the SECOND identical run to suppress it
  // (still emit the timeline event with `repeated: true`).
  setPostflightChecks([
    { name: "stable", cmd: "stable-cmd" },
    { name: "broken", cmd: "broken-cmd" },
  ])
  bindPostflight({
    $: makeFakeShell({
      "stable-cmd": { exitCode: 0, stdout: "ok" },
      "broken-cmd": { exitCode: 1, stderr: "still broken on the same line" },
    }),
  })

  await runPostflight("session-repeat")
  await runPostflight("session-repeat")
  await runPostflight("session-repeat")

  const rejectionCalls = captured.filter((c) => c.url.includes("/rejections"))
  assert(
    rejectionCalls.length === 1,
    `expected ONE rejection POST across three identical runs (dedup); saw ${rejectionCalls.length}`,
  )

  const completed = captured
    .filter((c) => c.url.endsWith("/v1/events"))
    .flatMap((c) => (Array.isArray(c.body?.events) ? c.body.events : [c.body]))
    .filter((e: any) => e?.type === "aag.postflight.completed")
  assert(completed.length === 3, `expected three completed events, got ${completed.length}`)
  assert(
    completed[0]!.properties.repeated === false,
    `first completed event should NOT be marked repeated`,
  )
  assert(
    completed[1]!.properties.repeated === true,
    `second completed event SHOULD be marked repeated`,
  )
  assert(
    completed[2]!.properties.repeated === true,
    `third completed event SHOULD be marked repeated`,
  )
}

async function testNewFailureClearsDedup() {
  _resetPostflight()
  captured.length = 0
  setPostflightChecks([{ name: "flaky", cmd: "flaky-cmd" }])
  // First run: fails with error A. Second: fails with DIFFERENT error B.
  // Third: passes. Fourth: fails with B again. We expect a rejection POST
  // for runs 1, 2, and 4 — but NOT 3 (passed) and NOT a dup of run 4.
  let invocation = 0
  const $ = makeFakeShell({})
  // Override the template handler to vary output by invocation count.
  const orig$ = (
    strings: TemplateStringsArray,
    ...exprs: any[]
  ) => orig$ // unused
  ;(globalThis as any).__phase = ""
  const fake: any = (strings: TemplateStringsArray, ...exprs: any[]) => {
    invocation++
    const phase = (globalThis as any).__phase
    const result =
      phase === "A"
        ? { exitCode: 1, stdout: "", stderr: "ERROR A" }
        : phase === "B"
          ? { exitCode: 1, stdout: "", stderr: "ERROR B (different)" }
          : { exitCode: 0, stdout: "ok", stderr: "" }
    const promise: any = Promise.resolve({
      exitCode: result.exitCode,
      stdout: { toString: () => result.stdout },
      stderr: { toString: () => result.stderr },
    })
    promise.cwd = () => promise
    promise.nothrow = () => promise
    promise.quiet = () => promise
    return promise
  }
  fake.cwd = () => fake
  fake.nothrow = () => fake
  fake.throws = () => fake
  fake.env = () => fake
  bindPostflight({ $: fake })

  ;(globalThis as any).__phase = "A"
  await runPostflight("session-new-fail")
  ;(globalThis as any).__phase = "B"
  await runPostflight("session-new-fail")
  ;(globalThis as any).__phase = "PASS"
  await runPostflight("session-new-fail")
  ;(globalThis as any).__phase = "B"
  await runPostflight("session-new-fail")

  const rejectionCalls = captured.filter((c) => c.url.includes("/rejections"))
  assert(
    rejectionCalls.length === 3,
    `expected three rejections (A, B, then B-after-pass); saw ${rejectionCalls.length}`,
  )
}

async function testCwdValidation() {
  _resetPostflight()
  captured.length = 0
  // Use a non-default suite that points at a cwd that definitely doesn't exist.
  setPostflightChecks([
    { name: "bogus", cmd: "echo never-runs", cwd: "no/such/subdir" },
  ])
  bindPostflight({
    $: makeFakeShell({
      // The fake shell would happily echo, but the validator should bail
      // before we even hit it.
      "echo never-runs": { exitCode: 0, stdout: "should-not-see-this" },
    }),
    cwd: "/tmp/postflight-cwd-validation-base-does-not-exist-either",
  })
  const results = await runPostflight("session-bad-cwd")
  assert(results.length === 1, `expected one result, got ${results.length}`)
  const r = results[0]!
  assert(r.passed === false, "bad cwd should mark check as failed")
  assert(
    r.stderrTail.includes("postflight: cwd does not exist"),
    `stderr should call out the cwd issue; got: ${r.stderrTail}`,
  )
  // Custom suite pointing at no-such-dir should still file a rejection
  // (the user wants to know their config is broken).
  const rejectionCalls = captured.filter((c) => c.url.includes("/rejections"))
  assert(
    rejectionCalls.length === 1,
    `expected one rejection POST for the bad-cwd run; saw ${rejectionCalls.length}`,
  )
}

async function testResolveBaseCwdFallsBackToRepoRoot() {
  _resetPostflight()
  // Bind WITHOUT a cwd so the resolver has to fall back to walking up
  // from the plugin source file. If this test is being run from inside
  // the autopsy checkout (which is the only way `bun src/__smoke__/...`
  // works), the resolver should find the repo root.
  bindPostflight({ $: makeFakeShell({}) })
  const root = resolvePostflightBaseCwd()
  assert(typeof root === "string", `resolver returned ${root}, expected a path`)
  // Sanity: the resolved root should contain a Makefile.
  const fs = await import("node:fs")
  assert(
    fs.existsSync(`${root}/Makefile`),
    `resolved root ${root} has no Makefile — wrong location?`,
  )
  assert(
    fs.statSync(`${root}/plugin`).isDirectory(),
    `resolved root ${root} has no plugin/ subdir — wrong location?`,
  )
}

async function testRejectionReasonFormatting() {
  const failed: CheckResult[] = [
    {
      name: "lint",
      cmd: "make lint",
      cwd: null,
      passed: false,
      exitCode: 1,
      durationMs: 250,
      timedOut: false,
      stdoutTail: "",
      stderrTail: "found 3 errors\nfile.py:1:5",
    },
    {
      name: "test",
      cmd: "make test",
      cwd: null,
      passed: false,
      exitCode: 1,
      durationMs: 4200,
      timedOut: false,
      stdoutTail: "",
      stderrTail: "FAILED tests/test_foo.py::test_bar",
    },
  ]
  const reason = buildRejectionReason(failed)
  assert(reason.includes("(2)"), `header should mention count; got: ${reason}`)
  assert(reason.includes("- lint"), `should list lint check`)
  assert(reason.includes("- test"), `should list test check`)
  assert(reason.includes("found 3 errors"), `should include failing detail`)
  assert(reason.includes("FAILED tests"), `should include failing detail`)
}

// --- driver ---------------------------------------------------------------

async function main() {
  try {
    await testDefaultSuiteShape()
    await testRunPostflightAllPass()
    await testRunPostflightFilesRejection()
    await testTimeoutMarksFailure()
    await testInflightDedupe()
    await testSchedulerDebounce()
    await testCancelPostflight()
    await testDisabledFlag()
    await testRepeatedFailureDedup()
    await testNewFailureClearsDedup()
    await testCwdValidation()
    await testResolveBaseCwdFallsBackToRepoRoot()
    await testRejectionReasonFormatting()
    console.log("ok")
  } catch (err) {
    console.error("FAIL: unhandled exception", err)
    process.exit(1)
  } finally {
    globalThis.fetch = realFetch
  }
}

await main()

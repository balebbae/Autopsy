// Post-flight code-check runner.
//
// After a code-modifying tool (edit / write / multiedit / patch) completes
// and the agent goes quiet, we run a small suite of automated checks
// (lint, typecheck, test) against the resulting working tree. If ANY of
// them fail, the failures are folded into a single `postRejection` call so
// the dashboard, classifier, and graph writer treat the outcome the same
// way they treat a user rejection — i.e. as a real failure that future
// preflights can warn about.
//
// Triggered from `handlers/tool-after.ts` via `schedulePostflight`. The
// scheduler debounces per-session so a rapid burst of edits collapses
// into one run after `config.postflight.debounceMs` of quiet.
//
// Hard rules:
// - Never block the LLM stream — `runPostflight` is fire-and-forget.
// - Never throw out of the scheduler — bun shell errors are caught here.
// - Always emit a timeline event (started + completed) so the dashboard
//   can render a "checks ran" entry even when nothing failed.

import { enqueue, flush } from "./batcher.ts"
import { postFeedback, postRejection } from "./client.ts"
import { config } from "./config.ts"

// --- types ----------------------------------------------------------------

export type Check = {
  /** Stable, snake-or-kebab-case identifier — surfaces as a symptom on
   *  the rejection ("<name>_failed") and as the timeline label. */
  name: string
  /** Bash command line, run via `bash -c <cmd>`. */
  cmd: string
  /** Optional cwd, relative to the plugin's working directory (the user's
   *  project root when opencode is launched). */
  cwd?: string
  /** Per-check timeout in ms. Default 60s. Long-running suites (pytest etc.)
   *  should set this explicitly. */
  timeoutMs?: number
}

export type CheckResult = {
  name: string
  cmd: string
  cwd: string | null
  passed: boolean
  exitCode: number
  durationMs: number
  timedOut: boolean
  /** Tail of stdout/stderr, truncated to ~OUTPUT_TAIL_BYTES so we don't bloat
   *  the dashboard JSONB rows or rejection reason strings. */
  stdoutTail: string
  stderrTail: string
}

// --- defaults -------------------------------------------------------------

// Autopsy-specific suite. The plugin assumes it's running from the Autopsy
// repo root; commands that need a sub-directory set `cwd` relative to that.
// Override via `setPostflightChecks(...)` from the plugin entry if you ever
// vendor this module into a different repo.
export const DEFAULT_CHECKS: Check[] = [
  {
    name: "service-lint",
    cmd: "make service-lint",
    timeoutMs: 60_000,
  },
  {
    name: "service-test",
    cmd: "make service-test",
    timeoutMs: 180_000,
  },
  {
    name: "plugin-typecheck",
    cmd: "bun run typecheck",
    cwd: "plugin",
    timeoutMs: 60_000,
  },
  {
    // `next typegen` regenerates `.next/types/**` from the current
    // app router, then `tsc --noEmit` validates the whole project.
    // Without the typegen step, stale references in `.next/types/`
    // cause tsc to fail on routes that have since been removed.
    name: "dashboard-typecheck",
    cmd: "npx --no-install next typegen && npx --no-install tsc --noEmit",
    cwd: "dashboard",
    timeoutMs: 120_000,
  },
]

let configuredChecks: Check[] = DEFAULT_CHECKS

/** Replace the active suite (e.g. for tests, or to opt out of a specific
 *  default in a downstream project). Pass `null` / undefined to reset. */
export function setPostflightChecks(checks: Check[] | null | undefined): void {
  configuredChecks = checks && checks.length > 0 ? checks : DEFAULT_CHECKS
}

export function getPostflightChecks(): Check[] {
  return configuredChecks
}

// --- bound context --------------------------------------------------------

// Bun's `$` shell helper, project metadata, and worktree are all injected
// once at plugin init (see `handlers`/`index.ts`). We hold onto them in
// module scope so handlers can call `schedulePostflight(runId)` without
// threading the context through every event hook.
type Ctx = {
  $: any
  projectId?: string
  worktree?: string
  cwd?: string
}

let bound: Ctx | undefined

export function bindPostflight(ctx: Ctx): void {
  bound = ctx
}

/** Test-only — clears bound context and any pending timers. */
export function _resetPostflight(): void {
  bound = undefined
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  inflight.clear()
}

// --- scheduler ------------------------------------------------------------

// Per-session debounce: any call to `schedulePostflight(runId)` resets the
// timer. When the timer finally fires (i.e. no new edit for debounceMs),
// we run the suite once.
const TIMERS_LIMIT = 256
const timers = new Map<string, ReturnType<typeof setTimeout>>()

// Tracks sessions where a postflight run is already in flight, so a second
// trigger that races past the debounce window doesn't spawn a duplicate.
const inflight = new Set<string>()

export function schedulePostflight(runId: string): void {
  if (!runId) return
  if (config.postflight.disabled) return
  if (!bound || !bound.$) return

  const existing = timers.get(runId)
  if (existing) clearTimeout(existing)

  const t = setTimeout(() => {
    timers.delete(runId)
    void runPostflight(runId).catch((err) => {
      // Swallow — `runPostflight` already logs its own failures, this is
      // just belt-and-braces for the unhandled-rejection case.
      console.error(`[autopsy] postflight unexpected failure for ${runId}:`, err)
    })
  }, config.postflight.debounceMs)

  timers.set(runId, t)

  // LRU bound. Long-running opencode processes that touch hundreds of
  // sessions shouldn't accumulate timers indefinitely.
  if (timers.size > TIMERS_LIMIT) {
    const oldest = timers.keys().next().value
    if (oldest !== undefined && oldest !== runId) {
      const old = timers.get(oldest)
      if (old) clearTimeout(old)
      timers.delete(oldest)
    }
  }
}

export function cancelPostflight(runId: string): void {
  const t = timers.get(runId)
  if (t) {
    clearTimeout(t)
    timers.delete(runId)
  }
}

// --- runner ---------------------------------------------------------------

const OUTPUT_TAIL_BYTES = 1500

const tail = (s: string, n = OUTPUT_TAIL_BYTES): string => {
  if (s.length <= n) return s
  return `…[+${s.length - n}b]\n${s.slice(-n)}`
}

async function runOneCheck(
  $: any,
  check: Check,
  baseCwd: string | undefined,
): Promise<CheckResult> {
  const start = Date.now()
  const cwd = check.cwd
    ? baseCwd
      ? `${baseCwd.replace(/\/+$/, "")}/${check.cwd}`
      : check.cwd
    : baseCwd

  const timeoutMs = check.timeoutMs ?? 60_000

  // Bun's `$` template literal escapes interpolated strings as a single
  // argv. Wrapping in `bash -c <cmd>` lets us use the cmd verbatim with
  // pipes, redirects, etc. — at the cost of one extra subprocess.
  let proc: any
  try {
    proc = $`bash -c ${check.cmd}`.nothrow().quiet()
    if (cwd) proc = proc.cwd(cwd)
  } catch (err: any) {
    return {
      name: check.name,
      cmd: check.cmd,
      cwd: cwd ?? null,
      passed: false,
      exitCode: -1,
      durationMs: Date.now() - start,
      timedOut: false,
      stdoutTail: "",
      stderrTail: tail(err?.message ?? String(err)),
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeoutPromise = new Promise<{
    exitCode: number
    stdout?: { toString(): string }
    stderr?: { toString(): string }
  }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({
        exitCode: 124,
        stdout: { toString: () => "" },
        stderr: { toString: () => `Check timed out after ${timeoutMs}ms.` },
      })
    }, timeoutMs)
  })

  let out: any
  try {
    out = await Promise.race([proc, timeoutPromise])
  } catch (err: any) {
    out = err ?? { exitCode: 1 }
  } finally {
    if (timer) clearTimeout(timer)
  }

  const stdout = String(out?.stdout?.toString?.() ?? "")
  const stderr = String(out?.stderr?.toString?.() ?? "")
  const exitCode =
    typeof out?.exitCode === "number" ? out.exitCode : timedOut ? 124 : 1

  return {
    name: check.name,
    cmd: check.cmd,
    cwd: cwd ?? null,
    passed: !timedOut && exitCode === 0,
    exitCode,
    durationMs: Date.now() - start,
    timedOut,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  }
}

// --- orchestrator ---------------------------------------------------------

const REJECTION_DETAIL_CHARS = 400

export function buildRejectionReason(failed: CheckResult[]): string {
  const header =
    failed.length === 1
      ? "Automated post-flight check failed:"
      : `Automated post-flight checks failed (${failed.length}):`
  const lines: string[] = [header]
  for (const r of failed) {
    const summary = r.timedOut
      ? `timed out after ${r.durationMs}ms`
      : `exit ${r.exitCode}, ${r.durationMs}ms`
    lines.push(`- ${r.name} (${summary})`)
    const detail = (r.stderrTail || r.stdoutTail || "").trim()
    if (detail) {
      lines.push(detail.slice(0, REJECTION_DETAIL_CHARS))
    }
  }
  return lines.join("\n")
}

export async function runPostflight(runId: string): Promise<CheckResult[]> {
  if (!bound || !bound.$) return []
  if (!runId) return []
  if (inflight.has(runId)) return []
  inflight.add(runId)

  try {
    const checks = getPostflightChecks()
    if (checks.length === 0) return []

    const ts = Date.now()
    enqueue({
      run_id: runId,
      project: bound.projectId,
      worktree: bound.worktree,
      ts,
      type: "aag.postflight.started",
      properties: {
        sessionID: runId,
        checks: checks.map((c) => ({ name: c.name, cmd: c.cmd, cwd: c.cwd ?? null })),
      },
    })
    // Force-flush so the dashboard's timeline shows the "started" row
    // immediately rather than waiting for the 200ms batcher tick. The
    // checks themselves may take many seconds, and we want the user to
    // see the activity right away.
    await flush()

    // Run in parallel — the suite is small (≤4) and the slowest check
    // dominates wall-clock either way. If a project ever needs serial
    // execution we can add a `serial: true` flag per check.
    const results = await Promise.all(
      checks.map((c) => runOneCheck(bound!.$, c, bound!.cwd)),
    )
    const failed = results.filter((r) => !r.passed)

    enqueue({
      run_id: runId,
      project: bound.projectId,
      worktree: bound.worktree,
      ts: Date.now(),
      type: "aag.postflight.completed",
      properties: {
        sessionID: runId,
        passed: failed.length === 0,
        results: results.map((r) => ({
          name: r.name,
          passed: r.passed,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          timedOut: r.timedOut,
          stdoutTail: r.stdoutTail,
          stderrTail: r.stderrTail,
        })),
      },
    })
    // Same reasoning: flush before we POST the rejection so the timeline
    // row exists when the dashboard re-fetches in response to the new
    // rejection record.
    await flush()

    if (failed.length === 0) return results

    const reason = buildRejectionReason(failed)
    const symptoms = failed.map((r) => `${r.name}_failed`).join(",")

    await postRejection(runId, {
      reason,
      failure_mode: "automated_check_failed",
      symptoms,
    })
    // Mirror the reason onto the run's rejection_reason column so the
    // dashboard's run summary surfaces the latest check failure even if
    // the rejection list is collapsed.
    await postFeedback(runId, reason)

    return results
  } catch (err) {
    console.error(`[autopsy] postflight run failed for ${runId}:`, err)
    return []
  } finally {
    inflight.delete(runId)
  }
}

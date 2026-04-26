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

import { existsSync, statSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

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

// Self-locate the Autopsy repo root by walking up from the plugin's source
// file. We know the plugin lives at `<REPO>/plugin/src/postflight.ts`, so
// the repo root is the nearest ancestor that has a Makefile AND the
// `plugin/`, `dashboard/`, `service/` siblings the default checks expect.
//
// This is the FALLBACK base cwd when `bindPostflight()` isn't called with
// a usable `ctx.cwd`. opencode 1.x sets `ctx.directory` to wherever the
// CLI was launched from, which on a fresh clone is the repo root — but on
// nested invocations or remote runners it can be anywhere. Without this
// fallback the default checks fail uniformly with bun "No such file or
// directory" (relative cwd) or GNU make's misleading "No rule to make
// target" (when there's simply no Makefile in cwd).
let cachedRepoRoot: string | null | undefined
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const looksLikeAutopsyRoot = (dir: string): boolean =>
  existsSync(`${dir}/Makefile`) &&
  isDir(`${dir}/plugin`) &&
  isDir(`${dir}/dashboard`) &&
  isDir(`${dir}/service`)

function findAutopsyRoot(): string | null {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot
  let here: string
  try {
    here = dirname(fileURLToPath(import.meta.url))
  } catch {
    cachedRepoRoot = null
    return null
  }
  // Walk up, but cap at 8 levels to keep the loop bounded.
  let cur = here
  for (let i = 0; i < 8; i++) {
    if (looksLikeAutopsyRoot(cur)) {
      cachedRepoRoot = cur
      return cur
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  cachedRepoRoot = null
  return null
}

/** The directory we should run postflight checks from. Prefers an explicit
 *  bound cwd that already looks like the autopsy root; otherwise falls back
 *  to the self-located repo root. Returns null when neither is usable. */
export function resolvePostflightBaseCwd(): string | null {
  const explicit = bound?.cwd
  if (explicit && looksLikeAutopsyRoot(explicit)) return explicit
  const located = findAutopsyRoot()
  if (located) return located
  // Last-resort: return the explicit cwd even if it doesn't look like the
  // autopsy root. Custom suites (set via `setPostflightChecks`) may not
  // need the repo-root markers, and bailing out entirely would silently
  // disable postflight in those projects.
  return explicit ?? null
}

export function bindPostflight(ctx: Ctx): void {
  bound = ctx
}

/** Test-only — clears bound context, repo-root cache, and any pending timers. */
export function _resetPostflight(): void {
  bound = undefined
  cachedRepoRoot = undefined
  lastFailureSignature.clear()
  dirtySessions.clear()
  triggeredAtMap.clear()
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  inflight.clear()
}

// --- scheduler ------------------------------------------------------------

// Sessions with at least one code-modifying tool call since the last
// postflight run attempt. We only run checks for dirty sessions, and only
// when the session goes idle (see handlers/event.ts).
const dirtySessions = new Set<string>()

export function markPostflightDirty(runId: string): void {
  if (!runId) return
  dirtySessions.add(runId)
}

type ScheduleOptions = {
  // Run as soon as possible (next tick) instead of waiting for debounceMs.
  // Used on session.idle to bind checks to the just-finished turn.
  immediate?: boolean
}

// Per-session timestamp of when idle fired. Threaded into runPostflight so
// rejection payloads and timeline events carry the turn-boundary time, not
// the (much later) check-completion time.
const triggeredAtMap = new Map<string, number>()

// Per-session debounce: any call to `schedulePostflight(runId)` resets the
// timer. When the timer finally fires (i.e. no new edit for debounceMs),
// we run the suite once.
const TIMERS_LIMIT = 256
const timers = new Map<string, ReturnType<typeof setTimeout>>()

// Tracks sessions where a postflight run is already in flight, so a second
// trigger that races past the debounce window doesn't spawn a duplicate.
const inflight = new Set<string>()

export function schedulePostflight(runId: string, opts?: ScheduleOptions): void {
  if (!runId) return
  if (config.postflight.disabled) return
  if (!bound || !bound.$) return
  if (!dirtySessions.has(runId)) return

  // Capture the wall-clock time of the trigger (session.idle) so that
  // downstream rejection payloads and timeline events are anchored to
  // the turn boundary, not whenever the async checks finish.
  triggeredAtMap.set(runId, Date.now())

  const existing = timers.get(runId)
  if (existing) clearTimeout(existing)

  const delayMs = opts?.immediate ? 0 : config.postflight.debounceMs

  const t = setTimeout(() => {
    timers.delete(runId)
    void runPostflight(runId).catch((err) => {
      // Swallow — `runPostflight` already logs its own failures, this is
      // just belt-and-braces for the unhandled-rejection case.
      console.error(`[autopsy] postflight unexpected failure for ${runId}:`, err)
    })
  }, delayMs)

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
  const rawCwd = check.cwd
    ? baseCwd
      ? `${baseCwd.replace(/\/+$/, "")}/${check.cwd}`
      : check.cwd
    : baseCwd
  // Resolve to an absolute path so bun's `.cwd()` doesn't get confused by
  // a relative path that happens to be valid against the wrong base.
  const cwd = rawCwd ? resolvePath(rawCwd) : undefined

  const timeoutMs = check.timeoutMs ?? 60_000

  // Pre-validate the cwd. Bun's `.cwd()` throws asynchronously when the
  // path doesn't exist, with a generic "No such file or directory" message
  // that hides which check was misconfigured. Catch it up front so the
  // rejection reason explains exactly what went wrong, instead of leaving
  // the user staring at GNU make's misleading "No rule to make target"
  // (which 3.81 emits even when no Makefile exists in cwd at all).
  if (cwd && !isDir(cwd)) {
    return {
      name: check.name,
      cmd: check.cmd,
      cwd,
      passed: false,
      exitCode: -1,
      durationMs: Date.now() - start,
      timedOut: false,
      stdoutTail: "",
      stderrTail: tail(
        `postflight: cwd does not exist: ${cwd}\n` +
          `(check "${check.name}" was configured with cwd="${check.cwd ?? ""}" relative to ` +
          `${baseCwd ?? "<unset>"}). Either run opencode from the autopsy repo root, or ` +
          `set AAG_POSTFLIGHT_DISABLED=1 to silence these checks in non-autopsy projects.`,
      ),
    }
  }

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

// Per-session signature of the last filed postflight rejection. We use it
// to suppress duplicate rejections when an agent retries a failing edit
// multiple times without actually fixing anything — the dashboard and
// graph already have the failure recorded; bumping the rejection counter
// 18 times for the same root cause is just noise. The signature combines
// the failed check names (sorted) with the truncated reason, so a *new*
// failure (different check fails, or same check fails with a different
// error) still files a fresh rejection.
const lastFailureSignature = new Map<string, string>()

const FAILURE_SIGNATURE_DETAIL_CHARS = 200
function failureSignature(failed: CheckResult[]): string {
  const ordered = [...failed].sort((a, b) => a.name.localeCompare(b.name))
  return ordered
    .map((r) => {
      const detail = (r.stderrTail || r.stdoutTail || "").trim().slice(
        0,
        FAILURE_SIGNATURE_DETAIL_CHARS,
      )
      return `${r.name}|${r.exitCode}|${detail}`
    })
    .join("\n")
}

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
  if (!dirtySessions.has(runId)) return []
  if (inflight.has(runId)) return []
  inflight.add(runId)

  // Consume the dirty marker for this attempt. If additional edits happen
  // while checks are running, tool-after will mark dirty again and the next
  // session.idle will schedule another run.
  dirtySessions.delete(runId)

  // Snapshot and consume the trigger timestamp so the rejection and
  // timeline events are anchored to when the turn ended.
  const triggeredAt = triggeredAtMap.get(runId) ?? Date.now()
  triggeredAtMap.delete(runId)

  try {
    const checks = getPostflightChecks()
    if (checks.length === 0) return []

    const baseCwd = resolvePostflightBaseCwd() ?? undefined

    enqueue({
      run_id: runId,
      project: bound.projectId,
      worktree: bound.worktree,
      ts: triggeredAt,
      type: "aag.postflight.started",
      properties: {
        sessionID: runId,
        triggeredAt,
        baseCwd: baseCwd ?? null,
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
      checks.map((c) => runOneCheck(bound!.$, c, baseCwd)),
    )
    const failed = results.filter((r) => !r.passed)

    // Compute the failure signature BEFORE we emit the completed event so
    // the timeline can mark a "repeated failure" run differently from a
    // novel one. Signature is empty when everything passed (we still
    // clear the cache so a follow-up regression files a fresh rejection).
    const sig = failed.length > 0 ? failureSignature(failed) : ""
    const prevSig = lastFailureSignature.get(runId) ?? null
    const repeated = failed.length > 0 && sig === prevSig

    enqueue({
      run_id: runId,
      project: bound.projectId,
      worktree: bound.worktree,
      ts: triggeredAt,
      type: "aag.postflight.completed",
      properties: {
        sessionID: runId,
        triggeredAt,
        completedAt: Date.now(),
        passed: failed.length === 0,
        // `repeated: true` means the SAME set of checks failed with the
        // same exit codes and (truncated) error tail as the previous
        // postflight on this run — i.e. the agent re-ran an edit without
        // actually fixing anything. The dashboard collapses these on the
        // outcome card so 18 retries don't render as 18 distinct entries.
        repeated,
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

    if (failed.length === 0) {
      lastFailureSignature.delete(runId)
      return results
    }

    // Skip the rejection POST when the failure is a verbatim repeat of
    // what we already filed. The graph and dashboard already have this
    // failure on record; filing it again would inflate `rejection_count`
    // and spam `RejectionList` with N copies of the same entry.
    if (repeated) {
      return results
    }
    lastFailureSignature.set(runId, sig)

    const reason = buildRejectionReason(failed)
    const symptoms = failed.map((r) => `${r.name}_failed`).join(",")

    await postRejection(runId, {
      reason,
      failure_mode: "automated_check_failed",
      symptoms,
      ts: triggeredAt,
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

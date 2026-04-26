"use client"

import * as React from "react"
import { Check, ShieldAlert, ShieldCheck, X } from "lucide-react"

import type { Run } from "@/lib/api"
import {
  attemptHadPreflightBlock,
  attemptHadPreflightWarn,
  collapseToolCalls,
  groupRunByAttempts,
  topPreflightHit,
  type Attempt,
} from "@/lib/timeline-grouping"
import { cn } from "@/lib/utils"

const ATTEMPT_WIDTH = 360
const ATTEMPT_GAP = 40

type Props = {
  run: Run
}

export function TimelineView({ run }: Props) {
  const grouped = React.useMemo(() => groupRunByAttempts(run), [run])

  // Run identity is already announced by the run picker in the toolbar — don't
  // repeat it here. Just leave a slim legend strip so colors are decodable.
  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-hidden p-3">
      <Legend />

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto rounded-xl border border-border bg-card/40">
        <div
          className="relative flex items-start"
          style={{
            padding: "44px 32px 32px",
            gap: `${ATTEMPT_GAP}px`,
            minWidth: "max-content",
          }}
        >
          <Spine attemptCount={grouped.attempts.length} />
          {grouped.attempts.map((att) => (
            <AttemptColumn
              key={att.index}
              attempt={att}
              taskFallback={grouped.task}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Spine({ attemptCount }: { attemptCount: number }) {
  if (attemptCount === 0) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-0 right-0"
      style={{ top: "55px" }}
    >
      <div className="mx-12 h-px bg-gradient-to-r from-transparent via-primary/45 to-transparent shadow-[0_0_12px_rgba(91,141,239,0.25)]" />
    </div>
  )
}

function AttemptColumn({
  attempt,
  taskFallback,
}: {
  attempt: Attempt
  taskFallback: string | null
}) {
  // First-attempt fallback: when the run has no captured user message yet
  // (typically because the agent started before the message bus emitted it),
  // show the task as an italicized stub instead of stamping `Task: <task>`
  // verbatim — the latter renders identically across every column on a single
  // task and reads as boilerplate noise.
  const userText = attempt.userMessage?.text ?? null
  const fallbackTask = userText ? null : taskFallback
  const userTs = attempt.userMessage?.ts ?? attempt.startTs
  const frustrated = attempt.userMessage?.frustrated === true

  return (
    <div
      className="relative flex shrink-0 flex-col gap-3"
      style={{ width: ATTEMPT_WIDTH }}
    >
      <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
        {formatTs(userTs)}
      </div>

      <div className="flex flex-col items-center gap-2 px-2">
        <div
          className={cn(
            "h-3.5 w-3.5 rounded-full ring-4 ring-primary/20 z-10",
            frustrated ? "bg-destructive ring-destructive/20" : "bg-primary",
          )}
        />
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          User · {attempt.index}
          {frustrated ? (
            <span className="ml-1 text-destructive">· frustrated</span>
          ) : null}
        </div>
        <div
          className={cn(
            "w-full max-w-full rounded-lg border bg-card/85 px-3 py-2 text-[13px] leading-snug",
            "[overflow-wrap:anywhere] line-clamp-3",
            frustrated ? "border-destructive/40" : "border-border",
            fallbackTask ? "italic text-muted-foreground" : "",
          )}
          title={userText ?? fallbackTask ?? undefined}
        >
          {userText ?? fallbackTask ?? "Run started"}
        </div>
      </div>

      <AttemptCard attempt={attempt} />
    </div>
  )
}

function AttemptCard({ attempt }: { attempt: Attempt }) {
  const hit = topPreflightHit(attempt)
  const blocked = attemptHadPreflightBlock(attempt)
  const warned = attemptHadPreflightWarn(attempt)
  const tools = collapseToolCalls(attempt.toolCalls)
  const fileCount = attempt.fileEdits.length
  const rejected = attempt.outcome.kind === "rejected"

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-sm transition-colors",
        rejected
          ? "border-destructive/45 ring-1 ring-destructive/30 shadow-destructive/10"
          : "border-border",
      )}
    >
      {/* Preflight strip */}
      {hit ? (
        <div
          className={cn(
            "border-l-[3px] px-3 py-2 text-[12px]",
            blocked
              ? "border-destructive bg-destructive/10"
              : "border-amber-500 bg-amber-500/10",
          )}
        >
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            {blocked ? (
              <>
                <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
                Preflight blocked tool call
              </>
            ) : (
              <>
                <ShieldCheck className="h-3.5 w-3.5 text-amber-400" />
                Preflight warning
              </>
            )}
            <span
              className={cn(
                "ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                blocked
                  ? "bg-destructive/20 text-red-300"
                  : "bg-amber-500/20 text-amber-300",
              )}
            >
              {attempt.preflight.length} hit
              {attempt.preflight.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
            {blocked && hit.tool ? (
              <>
                Tool <code className="rounded bg-background/60 px-1">{hit.tool}</code>{" "}
                blocked.{" "}
              </>
            ) : null}
            {hit.top_failure_modes?.[0]?.name ? (
              <>
                Top failure mode:{" "}
                <span className="font-mono text-foreground">
                  {hit.top_failure_modes[0].name}
                </span>{" "}
                ({hit.top_failure_modes[0].score.toFixed(2)})
              </>
            ) : (
              <>Risk level: {hit.risk_level}</>
            )}
          </div>
        </div>
      ) : (
        <div className="border-l-[3px] border-primary/40 bg-primary/5 px-3 py-2 text-[12px]">
          <div className="font-semibold text-muted-foreground">
            No preflight signal
          </div>
          <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
            No similar past failures retrieved.
          </div>
        </div>
      )}

      {/* Tool calls / file edits */}
      <div className="border-t border-border-soft border-border/50 px-3 py-2">
        {tools.length === 0 && fileCount === 0 ? (
          <div className="text-[11.5px] italic text-muted-foreground">
            No agent activity recorded in this attempt.
          </div>
        ) : (
          <ul className="space-y-1 font-mono text-[11.5px] text-muted-foreground/90">
            {tools.slice(0, 4).map((t, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className="text-primary/60">▸</span>
                <span className="truncate text-foreground/90" title={t.tool}>
                  {truncate(t.tool, 28)}
                </span>
                {t.count > 1 ? (
                  <span className="text-muted-foreground"> ×{t.count}</span>
                ) : null}
              </li>
            ))}
            {tools.length > 4 ? (
              <li className="pl-3 text-[11px] text-muted-foreground">
                +{tools.length - 4} more tool call{tools.length - 4 === 1 ? "" : "s"}
              </li>
            ) : null}
            {fileCount > 0 ? (
              <li className="pl-3 text-[11px] text-muted-foreground">
                {fileCount} file edit{fileCount === 1 ? "" : "s"}
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {/* Outcome footer */}
      <OutcomeFooter attempt={attempt} warned={warned} blocked={blocked} />
    </div>
  )
}

function OutcomeFooter({
  attempt,
  warned,
  blocked,
}: {
  attempt: Attempt
  warned: boolean
  blocked: boolean
}) {
  const o = attempt.outcome
  if (o.kind === "rejected") {
    const tail = o.reason || "user pushed back"
    const fullDetail = `${o.failureMode ? `${o.failureMode}: ` : ""}${tail}`
    return (
      <div
        className="flex items-start gap-2 bg-destructive/20 px-3 py-2 text-[12.5px] text-red-200"
        title={fullDetail}
      >
        <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-300" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold uppercase tracking-wider text-[10.5px] text-red-300">
            rejected
            {o.failureMode ? (
              <span className="ml-1.5 rounded bg-destructive/30 px-1.5 py-0.5 font-mono text-[9.5px] normal-case tracking-normal text-red-100">
                {truncate(o.failureMode, 22)}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-red-100/85 [overflow-wrap:anywhere]">
            {tail}
          </p>
        </div>
      </div>
    )
  }
  if (o.kind === "approved") {
    const note = blocked
      ? "preflight block prevented bad tool call; agent took alt path"
      : warned
      ? "preflight warning honored"
      : "user moved on without rejecting"
    return (
      <div className="flex items-start gap-2 bg-emerald-500/12 px-3 py-2 text-[12.5px] font-semibold text-emerald-300">
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>approved</span>
        <span className="ml-1 truncate font-normal text-muted-foreground" title={note}>
          — {note}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 bg-muted/40 px-3 py-2 text-[12.5px] font-semibold text-muted-foreground">
      <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
      in progress
    </div>
  )
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 text-[11px] text-muted-foreground">
      <LegendDot color="bg-primary" label="user message" />
      <LegendDot color="bg-amber-400" label="preflight warning" />
      <LegendDot color="bg-destructive" label="rejected · blocked" />
      <LegendDot color="bg-emerald-400" label="approved" />
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("inline-block h-2 w-2 rounded-full", color)} />
      {label}
    </span>
  )
}

function truncate(s: string, n: number): string {
  if (!s) return ""
  return s.length <= n ? s : s.slice(0, n - 1) + "…"
}

function formatTs(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return ""
  const d = new Date(ts)
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

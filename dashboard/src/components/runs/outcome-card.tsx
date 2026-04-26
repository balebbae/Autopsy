import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  MessageSquareWarning,
  RotateCcw,
  Wand2,
} from "lucide-react"

import type { FailureCase, Rejection, Run } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { humanizeFailureMode } from "@/lib/labels"

// Adjacent rejections that share the same `failure_mode` + `symptoms` are
// almost always the same root cause being re-filed (e.g. an agent retrying
// a failing edit, our automated post-flight checks failing on every save,
// or opencode replaying the same `permission.replied=reject` event). The
// raw count (18 rejections, all "automated_check_failed") is technically
// correct but useless for triage — collapse them so users see the LATEST
// reason once with a "× N retries" badge instead of 18 stacked copies.
type RejectionGroup = {
  // The most recent rejection in the group; its reason / timestamp /
  // failure_mode are what we surface in the consolidated row.
  latest: Rejection
  // Earliest timestamp in the run, for the "first seen" tooltip.
  firstTs: number
  // How many adjacent rejections collapsed into this group (≥1).
  count: number
  // Stable id for React's `key` prop — uses the latest rejection's id.
  id: number
}

function groupRejections(rejections: Rejection[]): RejectionGroup[] {
  const groups: RejectionGroup[] = []
  for (const r of rejections) {
    const tail = groups[groups.length - 1]
    const sameAsTail =
      tail !== undefined &&
      tail.latest.failure_mode === r.failure_mode &&
      tail.latest.symptoms === r.symptoms
    if (sameAsTail) {
      tail.count += 1
      // Keep the LATEST as the visible reason — it carries the freshest
      // error tail and timestamp, which is what the user actually wants
      // to read first.
      tail.latest = r
      tail.id = r.id
      continue
    }
    groups.push({ latest: r, firstTs: r.ts, count: 1, id: r.id })
  }
  return groups
}

// "Recovering after X failures" undersells what's happening when the same
// failure has been refiled 18 times in a row. Choose the phrasing based
// on the relationship between the raw count and the distinct-group count.
function recoveringMessage(rawCount: number, distinctCount: number): string {
  if (rawCount === distinctCount) {
    // Each rejection has a different failure_mode/symptoms — show the raw
    // count, since that IS the number of distinct issues to recover from.
    const noun = rawCount === 1 ? "failure" : "failures"
    return `Recovering after ${rawCount} ${noun} filed in this thread.`
  }
  if (distinctCount === 1) {
    // 18 rejections all stem from the same root cause: don't claim there
    // are 18 things to fix — there's one, retried 18 times.
    return `Recovering: same failure refiled ${rawCount} times in this thread.`
  }
  // Mixed: some duplicates, some fresh. Surface both numbers so users
  // know how many things actually need fixing vs how much retry noise
  // happened underneath.
  const noun = distinctCount === 1 ? "issue" : "issues"
  return `Recovering after ${distinctCount} distinct ${noun} (${rawCount} retries) filed in this thread.`
}

// Same logic as `recoveringMessage`, but past-tense for the "approved"
// outcome card. We deliberately keep the phrasing distinct so users can
// tell at a glance whether the run is still in flight or already finished.
function approvedRecoveryMessage(rawCount: number, distinctCount: number): string {
  if (rawCount === distinctCount) {
    const noun = rawCount === 1 ? "rejection" : "rejections"
    return `Approved after recovering from ${rawCount} earlier ${noun}.`
  }
  if (distinctCount === 1) {
    return `Approved after recovering from a single failure refiled ${rawCount} times.`
  }
  const noun = distinctCount === 1 ? "issue" : "issues"
  return `Approved after recovering from ${distinctCount} distinct ${noun} (${rawCount} retries).`
}

export function OutcomeCard({ run }: { run: Run }) {
  const rejections = run.rejections ?? []
  const count = rejections.length || run.rejection_count || 0
  const distinctCount = React.useMemo(
    () => groupRejections(rejections).length,
    [rejections],
  )
  const failure = run.failure_case ?? null
  // "Has rejection signal but no analyzer output yet" — show a small
  // pill so users know we're still classifying.
  const analyzing =
    !failure &&
    (count > 0 || run.status === "rejected" || run.status === "aborted")

  if (run.status === "active") {
    return (
      <Card className="border-sky-500/30 bg-sky-500/5 p-4 text-sm space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2 text-sky-700 dark:text-sky-300">
            <span className="h-2 w-2 rounded-full bg-sky-500 animate-pulse" /> In progress
          </div>
          {count > 0 ? <RejectionBadge count={count} tone="active" /> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {count > 0
            ? recoveringMessage(count, distinctCount)
            : "Events streaming live."}
        </p>
        {rejections.length > 0 ? <RejectionList rejections={rejections} /> : null}
        {analyzing ? <AnalyzingPill /> : null}
        {failure ? <FailureSummary failure={failure} /> : null}
      </Card>
    )
  }
  if (run.status === "rejected") {
    return (
      <Card className="border-red-500/30 bg-red-500/5 p-4 text-sm space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2 text-red-700 dark:text-red-300 font-medium">
            <AlertTriangle className="h-4 w-4" /> Rejected
          </div>
          <div className="flex items-center gap-1.5">
            {failure ? (
              <Badge
                variant="outline"
                className="text-[10px] py-0.5 px-1.5 bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30"
                title={failure.failure_mode}
              >
                {humanizeFailureMode(failure.failure_mode)}
              </Badge>
            ) : analyzing ? (
              <AnalyzingPill compact />
            ) : null}
            {count > 0 ? <RejectionBadge count={count} tone="rejected" /> : null}
          </div>
        </div>
        <RejectionBody
          rejections={rejections}
          rejectionReason={run.rejection_reason}
          failure={failure}
        />
      </Card>
    )
  }
  if (run.status === "approved") {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5 p-4 text-sm space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" /> Approved
          </div>
          {count > 0 ? <RejectionBadge count={count} tone="approved" /> : null}
        </div>
        {rejections.length > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">
              {approvedRecoveryMessage(count, distinctCount)}
            </p>
            <RejectionList rejections={rejections} />
          </>
        ) : null}
      </Card>
    )
  }
  return (
    <Card className={cn("border-amber-500/30 bg-amber-500/5 p-4 text-sm space-y-3")}>
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2 text-amber-700 dark:text-amber-300">
          <CircleSlash className="h-4 w-4" /> Aborted
        </div>
        {count > 0 ? <RejectionBadge count={count} tone="aborted" /> : null}
      </div>
      {rejections.length > 0 ? <RejectionList rejections={rejections} /> : null}
      {failure ? <FailureSummary failure={failure} /> : null}
    </Card>
  )
}

function RejectionBody({
  rejections,
  rejectionReason,
  failure,
}: {
  rejections: Rejection[]
  rejectionReason: string | null
  failure: FailureCase | null
}) {
  if (rejections.length > 0) {
    return (
      <>
        <RejectionList rejections={rejections} />
        {failure?.fix_pattern ? <SuggestedFix text={failure.fix_pattern} /> : null}
      </>
    )
  }
  // Single-rejection path (legacy outcome=rejected or permission.replied=reject).
  // Surface whatever signal we have, in priority order:
  //   1. explicit rejection_reason (set by /outcome with feedback or /feedback)
  //   2. classifier-generated summary (covers the permission.replied path
  //      where rejection_reason is never set, plus gemma-enhanced summaries)
  //   3. nothing — show the empty hint
  const reason = rejectionReason ?? failure?.summary ?? null
  if (reason) {
    return (
      <>
        <p className="text-sm text-foreground/90 leading-snug">
          <MessageSquareWarning className="inline-block h-3.5 w-3.5 mr-1 -mt-0.5 opacity-70" />
          {reason}
        </p>
        {failure?.fix_pattern ? <SuggestedFix text={failure.fix_pattern} /> : null}
      </>
    )
  }
  return <p className="text-xs text-muted-foreground">No rejection reason captured.</p>
}

function FailureSummary({ failure }: { failure: FailureCase }) {
  if (!failure.summary && !failure.fix_pattern) return null
  return (
    <div className="space-y-2 border-t border-border/50 pt-3">
      {failure.summary ? (
        <p className="text-xs text-foreground/85 leading-snug">
          <MessageSquareWarning className="inline-block h-3.5 w-3.5 mr-1 -mt-0.5 opacity-70" />
          {failure.summary}
        </p>
      ) : null}
      {failure.fix_pattern ? <SuggestedFix text={failure.fix_pattern} /> : null}
    </div>
  )
}

function AnalyzingPill({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-medium">
        <Loader2 className="h-3 w-3 animate-spin" />
        Analyzing
      </span>
    )
  }
  return (
    <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
      Classifying failure mode and gemma reasoning…
    </p>
  )
}

function SuggestedFix({ text }: { text: string }) {
  return (
    <p className="text-xs text-foreground/80 flex items-start gap-1.5 border-l-2 border-primary/40 pl-2">
      <Wand2 className="h-3 w-3 mt-0.5 text-primary shrink-0" />
      <span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
          Suggested fix
        </span>
        {text}
      </span>
    </p>
  )
}

type Tone = "active" | "rejected" | "approved" | "aborted"

function RejectionBadge({ count, tone }: { count: number; tone: Tone }) {
  const palette: Record<Tone, string> = {
    active: "border-red-500/40 text-red-700 dark:text-red-300 bg-red-500/10",
    rejected: "border-red-500/40 text-red-700 dark:text-red-300 bg-red-500/10",
    approved: "border-amber-500/40 text-amber-700 dark:text-amber-300 bg-amber-500/10",
    aborted: "border-red-500/40 text-red-700 dark:text-red-300 bg-red-500/10",
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        palette[tone],
      )}
    >
      <AlertTriangle className="h-3 w-3" />
      {count} {count === 1 ? "rejection" : "rejections"}
    </span>
  )
}

function RejectionList({ rejections }: { rejections: Rejection[] }) {
  const groups = React.useMemo(() => groupRejections(rejections), [rejections])
  return (
    <ol className="space-y-2 border-t border-border/50 pt-3">
      {groups.map((g, idx) => {
        const r = g.latest
        const grouped = g.count > 1
        const firstSeen = new Date(g.firstTs).toLocaleTimeString()
        const lastSeen = new Date(r.ts).toLocaleTimeString()
        return (
          <li key={g.id} className="text-xs">
            <div className="flex items-center gap-2 text-red-700 dark:text-red-300 font-medium">
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500/15 px-1 text-[10px] tabular-nums">
                {idx + 1}
              </span>
              <span className="text-foreground/80" title={r.failure_mode ?? undefined}>
                {r.failure_mode ? humanizeFailureMode(r.failure_mode) : "Rejection"}
              </span>
              {grouped ? (
                <span
                  className="inline-flex items-center gap-0.5 rounded-full border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300 tabular-nums"
                  title={`Same failure refiled ${g.count} times — first at ${firstSeen}, latest at ${lastSeen}`}
                >
                  <RotateCcw className="h-2.5 w-2.5" />×{g.count}
                </span>
              ) : null}
              <span
                className="text-muted-foreground tabular-nums ml-auto"
                title={grouped ? `first at ${firstSeen}` : undefined}
              >
                {lastSeen}
              </span>
            </div>
            <p className="mt-1 text-foreground/90 leading-snug">{r.reason}</p>
            {r.symptoms ? (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">{r.symptoms}</p>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  MessageSquareWarning,
  Wand2,
} from "lucide-react"

import type { FailureCase, Rejection, Run } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { humanizeFailureMode } from "@/lib/labels"

export function OutcomeCard({ run }: { run: Run }) {
  const rejections = run.rejections ?? []
  const count = rejections.length || run.rejection_count || 0
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
            ? `Recovering after ${count} ${count === 1 ? "failure" : "failures"} filed in this thread.`
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
              Approved after recovering from {count} earlier rejection{count === 1 ? "" : "s"}.
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
  return (
    <ol className="space-y-2 border-t border-border/50 pt-3">
      {rejections.map((r, idx) => (
        <li key={r.id} className="text-xs">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300 font-medium">
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500/15 px-1 text-[10px] tabular-nums">
              {idx + 1}
            </span>
            <span className="text-foreground/80" title={r.failure_mode ?? undefined}>
              {r.failure_mode ? humanizeFailureMode(r.failure_mode) : "Rejection"}
            </span>
            <span className="text-muted-foreground tabular-nums ml-auto">
              {new Date(r.ts).toLocaleTimeString()}
            </span>
          </div>
          <p className="mt-1 text-foreground/90 leading-snug">{r.reason}</p>
          {r.symptoms ? (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{r.symptoms}</p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

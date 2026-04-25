import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  MessageSquareWarning,
} from "lucide-react"

import type { Rejection, Run } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function OutcomeCard({ run }: { run: Run }) {
  const rejections = run.rejections ?? []
  const count = rejections.length || run.rejection_count || 0

  if (run.status === "active") {
    return (
      <Card className="border-sky-500/30 bg-sky-500/5 p-4 text-sm space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2 text-sky-700 dark:text-sky-300">
            <span className="h-2 w-2 rounded-full bg-sky-500 animate-pulse" /> In progress
          </div>
          {count > 0 ? (
            <RejectionBadge count={count} tone="active" />
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Events streaming live from <span className="font-mono">/v1/runs/:id/stream</span>.
          {count > 0
            ? " The agent is recovering after one or more failures filed during this thread."
            : null}
        </p>
        {rejections.length > 0 ? <RejectionList rejections={rejections} /> : null}
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
          {count > 0 ? (
            <RejectionBadge count={count} tone="rejected" />
          ) : null}
        </div>
        {rejections.length > 0 ? (
          <RejectionList rejections={rejections} />
        ) : run.rejection_reason ? (
          <p className="text-sm text-foreground/90">
            <MessageSquareWarning className="inline-block h-3.5 w-3.5 mr-1 -mt-0.5 opacity-70" />
            {run.rejection_reason}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No rejection reason captured.</p>
        )}
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
    </Card>
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
            <span className="text-foreground/80">
              {r.failure_mode ?? "rejection"}
            </span>
            <span className="text-muted-foreground tabular-nums ml-auto">
              {new Date(r.ts).toLocaleTimeString()}
            </span>
          </div>
          <p className="mt-1 text-foreground/90 leading-snug">{r.reason}</p>
          {r.symptoms ? (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              {r.symptoms}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

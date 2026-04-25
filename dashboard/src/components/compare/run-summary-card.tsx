"use client"

import * as React from "react"
import { Clock, FileDiff, Hammer } from "lucide-react"

import type { Run, FailureCase } from "@/lib/api"
import { cn, shortId, formatDuration } from "@/lib/utils"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { StatusPill } from "@/components/primitives/status-pill"
import { ConfidenceBar } from "@/components/primitives/confidence-bar"
import { Separator } from "@/components/ui/separator"

export function RunSummaryCard({
  run,
  variant,
  className,
}: {
  run: Run
  variant: "before" | "after"
  className?: string
}) {
  const isBefore = variant === "before"
  const borderColor = isBefore
    ? "border-red-500/20 bg-red-500/5"
    : "border-green-500/20 bg-green-500/5"

  return (
    <Card className={cn("flex flex-col overflow-hidden", borderColor, className)}>
      <div className="px-5 pt-5 pb-3 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
              {isBefore ? "Before (Failed)" : "After (Success)"}
            </p>
            <p className="mt-1 text-sm font-mono text-muted-foreground truncate">
              {shortId(run.run_id)}
            </p>
          </div>
          <StatusPill status={run.status} />
        </div>

        {run.task ? (
          <p className="text-sm leading-relaxed line-clamp-3">{run.task}</p>
        ) : null}

        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <FileDiff className="h-3.5 w-3.5" />
            {run.files_touched} files
          </span>
          <span className="inline-flex items-center gap-1">
            <Hammer className="h-3.5 w-3.5" />
            {run.tool_calls} tool calls
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {formatDuration(run.started_at, run.ended_at)}
          </span>
        </div>
      </div>

      {run.rejection_reason ? (
        <>
          <Separator />
          <div className="px-5 py-3">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1">
              Rejection reason
            </p>
            <p className="text-sm text-red-600 dark:text-red-400">
              {run.rejection_reason}
            </p>
          </div>
        </>
      ) : null}

      {run.failure_case ? (
        <FailureSummary failure={run.failure_case} />
      ) : null}

      {run.diffs.length > 0 ? (
        <>
          <Separator />
          <div className="px-5 py-3">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
              Files changed
            </p>
            <ul className="space-y-1">
              {run.diffs.flatMap((s) => s.files).slice(0, 10).map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-xs font-mono">
                  <FileStatusBadge status={f.status} />
                  <span className="truncate">{f.file}</span>
                </li>
              ))}
              {run.diffs.flatMap((s) => s.files).length > 10 ? (
                <li className="text-xs text-muted-foreground">
                  +{run.diffs.flatMap((s) => s.files).length - 10} more
                </li>
              ) : null}
            </ul>
          </div>
        </>
      ) : null}
    </Card>
  )
}

function FailureSummary({ failure }: { failure: FailureCase }) {
  return (
    <>
      <Separator />
      <div className="px-5 py-3 space-y-3">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
            Failure mode
          </p>
          <Badge
            variant="outline"
            className="text-xs font-medium bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30 py-0.5 px-2"
          >
            {failure.failure_mode}
          </Badge>
        </div>

        {failure.symptoms.length > 0 ? (
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Symptoms
            </p>
            <ul className="space-y-1.5">
              {failure.symptoms.map((s) => (
                <li key={s.name}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium">{s.name}</span>
                  </div>
                  <ConfidenceBar value={s.confidence} className="mt-0.5" />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {failure.summary ? (
          <p className="text-xs text-muted-foreground italic border-l-2 border-border pl-3">
            {failure.summary}
          </p>
        ) : null}
      </div>
    </>
  )
}

function FileStatusBadge({ status }: { status?: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    added: { label: "A", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
    modified: { label: "M", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
    deleted: { label: "D", cls: "bg-red-500/15 text-red-700 dark:text-red-300" },
    renamed: { label: "R", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  }
  const meta = map[status ?? ""] ?? { label: "?", cls: "bg-muted text-muted-foreground" }
  return (
    <span
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold shrink-0",
        meta.cls,
      )}
    >
      {meta.label}
    </span>
  )
}

import * as React from "react"
import Link from "next/link"
import { ArrowLeft, ExternalLink, Folder, GitBranch, Network } from "lucide-react"

import type { Run } from "@/lib/api"
import { shortId } from "@/lib/utils"
import { StatusPill } from "@/components/primitives/status-pill"
import { RelativeTime } from "@/components/primitives/relative-time"
import { Badge } from "@/components/ui/badge"

export function RunHeader({ run }: { run: Run }) {
  return (
    <div className="space-y-3">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All runs
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-3xl">
          <div className="flex items-center gap-2 mb-2">
            <StatusPill status={run.status} />
            {run.status === "active" ? (
              <Badge variant="outline" className="text-sky-500 border-sky-500/30 bg-sky-500/10">
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" />
                Live
              </Badge>
            ) : null}
            <span className="text-[11px] font-mono text-muted-foreground">
              {shortId(run.run_id, 10, 6)}
            </span>
          </div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight leading-tight [overflow-wrap:anywhere]">
            {run.task ?? "Untitled run"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {run.project ? (
              <span className="inline-flex max-w-full items-center gap-1.5 truncate">
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate" title={run.project}>
                  {run.project}
                </span>
              </span>
            ) : null}
            {run.worktree ? (
              <span className="inline-flex max-w-full items-center gap-1.5 font-mono">
                <GitBranch className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate" title={run.worktree}>
                  {run.worktree}
                </span>
              </span>
            ) : null}
            <span className="whitespace-nowrap">
              Started <RelativeTime ts={run.started_at} />
            </span>
            {run.ended_at ? (
              <span className="whitespace-nowrap">
                Ended <RelativeTime ts={run.ended_at} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/graph?run=${encodeURIComponent(run.run_id)}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent cursor-pointer"
          >
            <Network className="h-3.5 w-3.5" /> View in graph
          </Link>
          <Link
            href={`${process.env.NEXT_PUBLIC_AAG_URL ?? "http://localhost:4000"}/v1/runs/${run.run_id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            JSON <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </div>
  )
}

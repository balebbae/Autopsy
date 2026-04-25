import * as React from "react"
import Link from "next/link"
import { ArrowLeft, ExternalLink, Folder, GitBranch } from "lucide-react"

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
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight leading-tight">
            {run.task ?? "Untitled run"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {run.project ? (
              <span className="inline-flex items-center gap-1.5">
                <Folder className="h-3.5 w-3.5" />
                {run.project}
              </span>
            ) : null}
            {run.worktree ? (
              <span className="inline-flex items-center gap-1.5 font-mono">
                <GitBranch className="h-3.5 w-3.5" />
                {run.worktree}
              </span>
            ) : null}
            <span>
              Started <RelativeTime ts={run.started_at} />
            </span>
            {run.ended_at ? (
              <span>
                Ended <RelativeTime ts={run.ended_at} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
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

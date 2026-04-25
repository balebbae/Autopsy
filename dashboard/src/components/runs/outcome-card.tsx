import * as React from "react"
import { AlertTriangle, CheckCircle2, CircleSlash, MessageSquareWarning } from "lucide-react"

import type { Run } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function OutcomeCard({ run }: { run: Run }) {
  if (run.status === "active") {
    return (
      <Card className="border-sky-500/30 bg-sky-500/5 p-4 text-sm">
        <div className="inline-flex items-center gap-2 text-sky-700 dark:text-sky-300">
          <span className="h-2 w-2 rounded-full bg-sky-500 animate-pulse" /> In progress
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Events streaming live from <span className="font-mono">/v1/runs/:id/stream</span>.
        </p>
      </Card>
    )
  }
  if (run.status === "rejected") {
    return (
      <Card className="border-red-500/30 bg-red-500/5 p-4 text-sm">
        <div className="inline-flex items-center gap-2 text-red-700 dark:text-red-300 font-medium">
          <AlertTriangle className="h-4 w-4" /> Rejected
        </div>
        {run.rejection_reason ? (
          <p className="mt-2 text-sm text-foreground/90">
            <MessageSquareWarning className="inline-block h-3.5 w-3.5 mr-1 -mt-0.5 opacity-70" />
            {run.rejection_reason}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            No rejection reason captured.
          </p>
        )}
      </Card>
    )
  }
  if (run.status === "approved") {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
        <div className="inline-flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" /> Approved
        </div>
      </Card>
    )
  }
  return (
    <Card className={cn("border-amber-500/30 bg-amber-500/5 p-4 text-sm")}>
      <div className="inline-flex items-center gap-2 text-amber-700 dark:text-amber-300">
        <CircleSlash className="h-4 w-4" /> Aborted
      </div>
    </Card>
  )
}

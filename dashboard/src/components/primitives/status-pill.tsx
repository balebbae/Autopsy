import * as React from "react"
import { CheckCircle2, CircleSlash, Clock, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export type RunStatus = "active" | "approved" | "rejected" | "aborted"

export function StatusPill({
  status,
  className,
  withIcon = true,
}: {
  status: RunStatus | string
  className?: string
  withIcon?: boolean
}) {
  const map: Record<
    string,
    { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }
  > = {
    active: {
      label: "Active",
      cls: "bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/30",
      Icon: Clock,
    },
    approved: {
      label: "Approved",
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
      Icon: CheckCircle2,
    },
    rejected: {
      label: "Rejected",
      cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
      Icon: XCircle,
    },
    aborted: {
      label: "Completed",
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
      Icon: CheckCircle2,
    },
  }
  const meta = map[status] ?? {
    label: status,
    cls: "bg-muted text-muted-foreground border-border",
    Icon: Clock,
  }
  const Icon = meta.Icon
  return (
    <Badge
      variant="outline"
      className={cn(
        "border font-medium gap-1 px-2 py-0.5 capitalize",
        meta.cls,
        className,
      )}
    >
      {withIcon ? <Icon className="h-3 w-3" /> : null}
      {meta.label}
    </Badge>
  )
}

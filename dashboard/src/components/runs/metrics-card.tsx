import * as React from "react"
import { Clock, FileDiff, Hammer } from "lucide-react"

import type { Run } from "@/lib/api"
import { formatDuration } from "@/lib/utils"
import { SectionCard } from "@/components/primitives/section-card"

export function MetricsCard({ run }: { run: Run }) {
  const items = [
    { Icon: Hammer, label: "Tool calls", value: run.tool_calls },
    { Icon: FileDiff, label: "Files touched", value: run.files_touched },
    {
      Icon: Clock,
      label: "Duration",
      value: formatDuration(run.started_at, run.ended_at),
    },
  ] as const
  return (
    <SectionCard title="Metrics" bodyClassName="p-0">
      <ul className="divide-y divide-border">
        {items.map(({ Icon, label, value }) => (
          <li key={label} className="flex items-center justify-between px-5 py-3">
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5" /> {label}
            </span>
            <span className="text-sm font-medium tabular-nums">{value}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

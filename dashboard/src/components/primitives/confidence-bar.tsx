import * as React from "react"
import { cn } from "@/lib/utils"

export function ConfidenceBar({
  value,
  className,
  label,
}: {
  value: number
  className?: string
  label?: string
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  const tone =
    pct >= 75
      ? "bg-red-500"
      : pct >= 50
        ? "bg-amber-500"
        : pct >= 25
          ? "bg-sky-500"
          : "bg-muted-foreground/40"
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] font-mono text-muted-foreground tabular-nums shrink-0">
        {label ?? `${pct.toFixed(0)}%`}
      </span>
    </div>
  )
}

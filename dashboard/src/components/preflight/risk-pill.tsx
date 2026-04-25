import * as React from "react"
import { AlertTriangle, CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react"

import { cn } from "@/lib/utils"

const map = {
  none: {
    cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    label: "No risk",
    Icon: CheckCircle2,
  },
  low: {
    cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
    label: "Low risk",
    Icon: ShieldCheck,
  },
  medium: {
    cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
    label: "Medium risk",
    Icon: ShieldAlert,
  },
  high: {
    cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
    label: "High risk",
    Icon: AlertTriangle,
  },
} as const

export function RiskPill({
  level,
  blocked,
  className,
}: {
  level: "none" | "low" | "medium" | "high"
  blocked?: boolean
  className?: string
}) {
  const meta = map[level]
  const Icon = meta.Icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold",
        meta.cls,
        className,
      )}
    >
      <Icon className="h-4 w-4" />
      {meta.label}
      {blocked ? (
        <span className="ml-1 rounded-md bg-red-500/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
          blocked
        </span>
      ) : null}
    </span>
  )
}

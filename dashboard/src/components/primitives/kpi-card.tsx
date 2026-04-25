import * as React from "react"
import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function KpiCard({
  label,
  value,
  sublabel,
  delta,
  deltaLabel,
  Icon,
  accent = "muted",
  className,
  children,
}: {
  label: string
  value: React.ReactNode
  sublabel?: React.ReactNode
  delta?: number
  deltaLabel?: string
  Icon?: LucideIcon
  accent?: "muted" | "primary" | "destructive" | "success" | "warning"
  className?: string
  children?: React.ReactNode
}) {
  const accentMap: Record<string, string> = {
    muted: "from-muted/40 to-transparent",
    primary: "from-primary/10 to-transparent",
    destructive: "from-red-500/10 to-transparent",
    success: "from-emerald-500/10 to-transparent",
    warning: "from-amber-500/10 to-transparent",
  }

  return (
    <Card
      className={cn(
        "relative overflow-hidden p-5 bg-gradient-to-br",
        accentMap[accent],
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-0.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
            {sublabel ? (
              <span className="text-xs text-muted-foreground">{sublabel}</span>
            ) : null}
          </div>
        </div>
        {Icon ? (
          <div className="h-8 w-8 rounded-md bg-card border border-border grid place-items-center">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        ) : null}
      </div>

      {typeof delta === "number" ? (
        <div className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium">
          {delta > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-emerald-500">
              <ArrowUpRight className="h-3 w-3" />
              {Math.abs(delta).toFixed(0)}%
            </span>
          ) : delta < 0 ? (
            <span className="inline-flex items-center gap-0.5 text-red-500">
              <ArrowDownRight className="h-3 w-3" />
              {Math.abs(delta).toFixed(0)}%
            </span>
          ) : (
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <Minus className="h-3 w-3" /> 0%
            </span>
          )}
          {deltaLabel ? (
            <span className="text-muted-foreground">{deltaLabel}</span>
          ) : null}
        </div>
      ) : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </Card>
  )
}

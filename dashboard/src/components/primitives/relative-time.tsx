"use client"

import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatRelative } from "@/lib/utils"

// Both the relative label (depends on Date.now()) and the absolute
// tooltip text (depends on the user's locale + timezone) drift between
// the server render and the first client render — that's the
// "5s ago" vs "6s ago" hydration mismatch reported by Next.js. We render
// nothing until after mount and gate the inner span with
// suppressHydrationWarning so the diff is silenced cleanly.
export function RelativeTime({
  ts,
  className,
}: {
  ts: number | null | undefined
  className?: string
}) {
  const [mounted, setMounted] = React.useState(false)
  const [, force] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => {
    setMounted(true)
    if (!ts) return
    const id = setInterval(force, 30_000)
    return () => clearInterval(id)
  }, [ts])

  if (!ts) return <span className={className}>—</span>
  const label = mounted ? formatRelative(ts) : ""
  const abs = mounted ? new Date(ts).toLocaleString() : ""
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className} suppressHydrationWarning>
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-[11px]">
        <span suppressHydrationWarning>{abs}</span>
      </TooltipContent>
    </Tooltip>
  )
}

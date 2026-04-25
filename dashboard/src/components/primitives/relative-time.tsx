"use client"

import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatRelative } from "@/lib/utils"

export function RelativeTime({
  ts,
  className,
}: {
  ts: number | null | undefined
  className?: string
}) {
  const [, force] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => {
    if (!ts) return
    const id = setInterval(force, 30_000)
    return () => clearInterval(id)
  }, [ts])

  if (!ts) return <span className={className}>—</span>
  const abs = new Date(ts).toLocaleString()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className}>{formatRelative(ts)}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-[11px]">
        {abs}
      </TooltipContent>
    </Tooltip>
  )
}

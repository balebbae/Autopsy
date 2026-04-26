"use client"

import * as React from "react"
import { ChevronDown, Info } from "lucide-react"

import { EDGE_TYPE_STYLE, NODE_TYPE_STYLE, type NodeStyleConfig } from "./graph-style"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const SHAPE_ICONS: Record<NodeStyleConfig["shape"], React.ReactNode> = {
  rounded: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
      <rect x="2" y="3" width="12" height="10" rx="2" fill="currentColor" />
    </svg>
  ),
  pill: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
      <rect x="1" y="4" width="14" height="8" rx="4" fill="currentColor" />
    </svg>
  ),
  hexagon: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
      <polygon points="8,1 14,4.5 14,11.5 8,15 2,11.5 2,4.5" fill="currentColor" />
    </svg>
  ),
  diamond: (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
      <polygon points="8,1 15,8 8,15 1,8" fill="currentColor" />
    </svg>
  ),
}

export function Legend() {
  const [open, setOpen] = React.useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Show legend"
        className="flex items-center gap-1.5 rounded-md border border-border bg-card/85 px-2.5 py-1.5 text-[11px] font-medium shadow-md backdrop-blur-md hover:bg-card"
      >
        <Info className="h-3.5 w-3.5 opacity-70" />
        Legend
      </button>
    )
  }

  return (
    <Card className="p-3 text-[11px] backdrop-blur-md bg-card/85 shadow-lg w-44">
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Hide legend"
        className="flex w-full items-center justify-between mb-2 group"
      >
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground group-hover:text-foreground">
          Legend
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
      </button>
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
        Node types
      </p>
      <ul className="grid grid-cols-1 gap-1.5">
        {Object.entries(NODE_TYPE_STYLE).map(([k, v]) => (
          <li key={k} className="flex items-center gap-2">
            <span style={{ color: v.color }}>{SHAPE_ICONS[v.shape]}</span>
            <span className="font-medium">{k}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 pt-2 border-t border-border/50">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
          Edge types
        </p>
        <ul className="grid grid-cols-1 gap-1">
          {Object.entries(EDGE_TYPE_STYLE).map(([k, v]) => (
            <li key={k} className="flex items-center gap-2">
              <svg viewBox="0 0 24 8" className="h-2 w-6 shrink-0">
                <line
                  x1="1"
                  y1="4"
                  x2="23"
                  y2="4"
                  stroke={v.color}
                  strokeWidth="2"
                  strokeDasharray={v.dashed ? "4 3" : undefined}
                />
              </svg>
              <span className={cn("font-medium")}>{k}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 pt-2 border-t border-border/50">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
          Shortcuts
        </p>
        <ul className="space-y-0.5 text-muted-foreground">
          <li><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">F</kbd> Fit to view</li>
          <li><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">⌘+</kbd> Zoom in</li>
          <li><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">⌘-</kbd> Zoom out</li>
          <li><kbd className="px-1 py-0.5 rounded bg-muted text-[9px]">Esc</kbd> Deselect</li>
        </ul>
      </div>
    </Card>
  )
}

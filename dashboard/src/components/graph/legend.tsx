import * as React from "react"
import { NODE_TYPE_STYLE, type NodeStyleConfig } from "./graph-style"
import { Card } from "@/components/ui/card"

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
  return (
    <Card className="p-3 text-[11px] backdrop-blur-md bg-card/85 shadow-lg">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
        Node types
      </p>
      <ul className="grid grid-cols-1 gap-1.5">
        {Object.entries(NODE_TYPE_STYLE).map(([k, v]) => (
          <li key={k} className="flex items-center gap-2">
            <span style={{ color: v.color }}>
              {SHAPE_ICONS[v.shape]}
            </span>
            <span className="font-medium">{k}</span>
          </li>
        ))}
      </ul>
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

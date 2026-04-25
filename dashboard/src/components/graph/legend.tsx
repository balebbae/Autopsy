import * as React from "react"
import { NODE_TYPE_STYLE } from "./graph-style"
import { Card } from "@/components/ui/card"

export function Legend() {
  return (
    <Card className="p-3 text-[11px] backdrop-blur-md bg-card/85 shadow-lg">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
        Node types
      </p>
      <ul className="grid grid-cols-1 gap-1">
        {Object.entries(NODE_TYPE_STYLE).map(([k, v]) => (
          <li key={k} className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm border border-black/10"
              style={{ backgroundColor: v.color }}
            />
            <span>{k}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

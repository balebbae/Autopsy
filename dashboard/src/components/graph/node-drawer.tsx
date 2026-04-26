"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowDownLeft, ArrowUpRight, ExternalLink, X } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { CodeBlock } from "@/components/primitives/code-block"
import { Separator } from "@/components/ui/separator"
import { ConfidenceBar } from "@/components/primitives/confidence-bar"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { GraphEdge, GraphNode } from "@/lib/api"
import { nodeStyle, nodeDisplayName } from "./graph-style"

export function NodeDrawer({
  node,
  edges,
  nodesById,
  onClose,
  onSelectNode,
}: {
  node: GraphNode | null
  edges: GraphEdge[]
  nodesById: Map<string, GraphNode>
  onClose: () => void
  onSelectNode: (n: GraphNode) => void
}) {
  const incoming = node ? edges.filter((e) => e.target_id === node.id) : []
  const outgoing = node ? edges.filter((e) => e.source_id === node.id) : []
  const evidenceRunIds = Array.from(
    new Set(
      [...incoming, ...outgoing]
        .map((e) => e.evidence_run_id)
        .filter((x): x is string => Boolean(x)),
    ),
  )
  const style = node ? nodeStyle(node) : null

  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showClose={false}
        className="max-w-2xl w-full p-0 overflow-hidden border border-border/60 bg-card shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-100 duration-150"
      >
        {node && style ? (
          <>
            {/* Accent bar */}
            <div
              className="h-1 w-full"
              style={{ background: `linear-gradient(90deg, ${style.color}, ${style.color}60)` }}
            />

            {/* Header */}
            <div className="px-6 pt-5 pb-4 flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span
                    className="inline-flex h-5 w-5 rounded items-center justify-center text-[9px] font-bold shrink-0"
                    style={{ backgroundColor: style.bgColor, border: `1px solid ${style.borderColor}`, color: style.color }}
                  >
                    {node.type.slice(0, 2).toUpperCase()}
                  </span>
                  <Badge variant="outline" className="font-mono text-[10px] border-border/60">
                    {node.type}
                  </Badge>
                  {evidenceRunIds.length > 0 && (
                    <Badge variant="muted" className="text-[10px]">
                      {evidenceRunIds.length} run{evidenceRunIds.length > 1 ? "s" : ""}
                    </Badge>
                  )}
                </div>
                <DialogTitle className="text-base font-semibold leading-snug truncate">
                  {nodeDisplayName(node)}
                </DialogTitle>
                <DialogDescription className="font-mono text-[11px] mt-0.5 truncate text-muted-foreground/70">
                  {node.id}
                </DialogDescription>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <Separator />

            <ScrollArea className="max-h-[60vh]">
              <div className="px-6 py-4 space-y-5">
                {/* Evidence runs */}
                {evidenceRunIds.length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                      Evidence runs
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {evidenceRunIds.map((rid) => (
                        <Link
                          key={rid}
                          href={`/runs/${rid}`}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1 text-[11px] font-mono hover:bg-accent hover:border-border/80 transition-colors"
                        >
                          {rid.slice(0, 22)}
                          <ExternalLink className="h-3 w-3 opacity-60 shrink-0" />
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {/* Properties */}
                {node.properties && Object.keys(node.properties).length > 0 && (
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                      Properties
                    </p>
                    <CodeBlock language="json">
                      {JSON.stringify(node.properties, null, 2)}
                    </CodeBlock>
                  </div>
                )}

                {/* Edges — two column */}
                {(incoming.length > 0 || outgoing.length > 0) && (
                  <>
                    <Separator />
                    <div className="grid grid-cols-2 gap-4">
                      <EdgeList
                        title="Incoming"
                        icon={<ArrowDownLeft className="h-3 w-3" />}
                        edges={incoming}
                        dir="in"
                        nodesById={nodesById}
                        onSelectNode={(n) => { onSelectNode(n) }}
                        accentColor={style.color}
                      />
                      <EdgeList
                        title="Outgoing"
                        icon={<ArrowUpRight className="h-3 w-3" />}
                        edges={outgoing}
                        dir="out"
                        nodesById={nodesById}
                        onSelectNode={(n) => { onSelectNode(n) }}
                        accentColor={style.color}
                      />
                    </div>
                  </>
                )}
              </div>
            </ScrollArea>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function EdgeList({
  title,
  edges,
  dir,
  nodesById,
  onSelectNode,
  icon,
  accentColor,
}: {
  title: string
  edges: GraphEdge[]
  dir: "in" | "out"
  nodesById: Map<string, GraphNode>
  onSelectNode: (n: GraphNode) => void
  icon?: React.ReactNode
  accentColor?: string
}) {
  if (edges.length === 0) {
    return (
      <div>
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
          {icon} {title}
        </p>
        <p className="text-[11px] text-muted-foreground/50 italic">None</p>
      </div>
    )
  }

  const grouped = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    const arr = grouped.get(e.type) ?? []
    arr.push(e)
    grouped.set(e.type, arr)
  }

  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
        {icon} {title}
        <span className="ml-auto text-[10px] font-mono opacity-60">{edges.length}</span>
      </p>
      <div className="space-y-3">
        {Array.from(grouped.entries()).map(([type, group]) => (
          <div key={type}>
            <p
              className="text-[10px] font-mono mb-1 font-semibold"
              style={{ color: accentColor ?? "currentColor" }}
            >
              {type}
            </p>
            <ul className="space-y-1">
              {group.map((e) => {
                const otherId = dir === "in" ? e.source_id : e.target_id
                const other = nodesById.get(otherId)
                const otherStyle = other ? nodeStyle(other) : null
                return (
                  <li
                    key={e.id}
                    className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5 hover:bg-muted/40 transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => other && onSelectNode(other)}
                      className="w-full flex items-center justify-between gap-2 text-left cursor-pointer"
                    >
                      <span className="text-xs truncate flex items-center gap-1.5">
                        {otherStyle && (
                          <span
                            className="inline-block h-2 w-2 rounded-sm shrink-0"
                            style={{ backgroundColor: otherStyle.color }}
                          />
                        )}
                        {other ? nodeDisplayName(other) : otherId}
                      </span>
                      {other && (
                        <Badge variant="muted" className="text-[9px] font-mono shrink-0 px-1 py-0">
                          {other.type}
                        </Badge>
                      )}
                    </button>
                    {typeof e.confidence === "number" && (
                      <ConfidenceBar
                        value={e.confidence}
                        className="mt-1.5"
                        label={`${(e.confidence * 100).toFixed(0)}%`}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

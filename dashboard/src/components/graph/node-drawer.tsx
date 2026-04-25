"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowDownLeft, ArrowUpRight, ExternalLink } from "lucide-react"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { CodeBlock } from "@/components/primitives/code-block"
import { Separator } from "@/components/ui/separator"
import { ConfidenceBar } from "@/components/primitives/confidence-bar"
import type { GraphEdge, GraphNode } from "@/lib/api"
import { nodeStyle } from "./graph-style"

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
  if (!node) {
    return (
      <Sheet open={false} onOpenChange={onClose}>
        <SheetContent />
      </Sheet>
    )
  }

  const incoming = edges.filter((e) => e.target_id === node.id)
  const outgoing = edges.filter((e) => e.source_id === node.id)
  const evidenceRunIds = Array.from(
    new Set(
      [...incoming, ...outgoing]
        .map((e) => e.evidence_run_id)
        .filter((x): x is string => Boolean(x)),
    ),
  )
  const style = nodeStyle(node)

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-center gap-2 mb-1">
            <span
              className="inline-block h-3 w-3 rounded-sm border border-black/10"
              style={{ backgroundColor: style.color }}
            />
            <Badge variant="outline" className="font-mono text-[10px]">
              {node.type}
            </Badge>
          </div>
          <SheetTitle>{node.name}</SheetTitle>
          <SheetDescription className="font-mono text-[11px]">
            {node.id}
          </SheetDescription>
        </SheetHeader>

        {evidenceRunIds.length > 0 ? (
          <div className="mt-5">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Evidence runs
            </p>
            <div className="flex flex-wrap gap-1">
              {evidenceRunIds.map((rid) => (
                <Link
                  key={rid}
                  href={`/runs/${rid}`}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono hover:bg-accent cursor-pointer"
                >
                  {rid.slice(0, 18)}
                  <ExternalLink className="h-3 w-3 opacity-70" />
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        {node.properties && Object.keys(node.properties).length > 0 ? (
          <div className="mt-5">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Properties
            </p>
            <CodeBlock language="json">
              {JSON.stringify(node.properties, null, 2)}
            </CodeBlock>
          </div>
        ) : null}

        <Separator className="my-5" />

        <EdgeList
          title="Incoming"
          icon={<ArrowDownLeft className="h-3.5 w-3.5" />}
          edges={incoming}
          dir="in"
          nodesById={nodesById}
          onSelectNode={onSelectNode}
        />
        <EdgeList
          title="Outgoing"
          icon={<ArrowUpRight className="h-3.5 w-3.5" />}
          edges={outgoing}
          dir="out"
          nodesById={nodesById}
          onSelectNode={onSelectNode}
          className="mt-4"
        />
      </SheetContent>
    </Sheet>
  )
}

function EdgeList({
  title,
  edges,
  dir,
  nodesById,
  onSelectNode,
  icon,
  className,
}: {
  title: string
  edges: GraphEdge[]
  dir: "in" | "out"
  nodesById: Map<string, GraphNode>
  onSelectNode: (n: GraphNode) => void
  icon?: React.ReactNode
  className?: string
}) {
  if (edges.length === 0) return null
  const grouped = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    const arr = grouped.get(e.type) ?? []
    arr.push(e)
    grouped.set(e.type, arr)
  }
  return (
    <div className={className}>
      <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1.5">
        {icon}
        {title} <span className="opacity-70">({edges.length})</span>
      </p>
      <div className="space-y-3">
        {Array.from(grouped.entries()).map(([type, group]) => (
          <div key={type}>
            <p className="text-[10px] font-mono text-muted-foreground/80 mb-1">{type}</p>
            <ul className="space-y-1">
              {group.map((e) => {
                const otherId = dir === "in" ? e.source_id : e.target_id
                const other = nodesById.get(otherId)
                return (
                  <li
                    key={e.id}
                    className="rounded-md border border-border bg-muted/30 px-2 py-1.5"
                  >
                    <button
                      type="button"
                      onClick={() => other && onSelectNode(other)}
                      className="w-full flex items-center justify-between gap-2 text-left cursor-pointer"
                    >
                      <span className="text-sm truncate">
                        {other?.name ?? otherId}
                      </span>
                      {other ? (
                        <Badge variant="muted" className="text-[10px] font-mono shrink-0">
                          {other.type}
                        </Badge>
                      ) : null}
                    </button>
                    {typeof e.confidence === "number" ? (
                      <ConfidenceBar
                        value={e.confidence}
                        className="mt-1.5"
                        label={`${(e.confidence * 100).toFixed(0)}%`}
                      />
                    ) : null}
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

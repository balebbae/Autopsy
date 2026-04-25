"use client"

import * as React from "react"
import useSWR from "swr"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  Download,
  Filter,
  Maximize,
  Network,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
} from "lucide-react"
import type { Core } from "cytoscape"

import {
  apiBaseUrl,
  type GraphEdge,
  type GraphNode,
} from "@/lib/api"
import { buildMockGraph } from "@/lib/graph-mock"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/primitives/empty-state"
import { Legend } from "./legend"
import { NodeDrawer } from "./node-drawer"
import {
  GraphCanvas,
  type LayoutKey,
  ALL_LAYOUTS,
} from "./graph-canvas"
import { cn } from "@/lib/utils"

type GraphPayload = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  source: "api" | "mock"
}

const fetcher = async (
  url: string,
): Promise<{
  nodes: GraphNode[]
  edges: GraphEdge[]
  ok: boolean
}> => {
  try {
    const [n, e] = await Promise.all([
      fetch(`${url}/v1/graph/nodes`, { cache: "no-store" }),
      fetch(`${url}/v1/graph/edges`, { cache: "no-store" }),
    ])
    if (!n.ok || !e.ok) return { nodes: [], edges: [], ok: false }
    const nodes = (await n.json()) as GraphNode[]
    const edges = (await e.json()) as GraphEdge[]
    return { nodes, edges, ok: true }
  } catch {
    return { nodes: [], edges: [], ok: false }
  }
}

export function GraphExplorer() {
  const params = useSearchParams()
  const forceMock = params?.get("mock") === "1"

  const { data, isLoading, mutate } = useSWR(
    forceMock ? null : ["graph", apiBaseUrl],
    () => fetcher(apiBaseUrl),
    { revalidateOnFocus: false },
  )

  const payload: GraphPayload | null = React.useMemo(() => {
    if (forceMock) {
      const m = buildMockGraph()
      return { ...m, source: "mock" }
    }
    if (!data) return null
    if (!data.ok || (data.nodes.length === 0 && data.edges.length === 0)) {
      const m = buildMockGraph()
      return { ...m, source: "mock" }
    }
    return { ...data, source: "api" }
  }, [data, forceMock])

  const cyRef = React.useRef<Core | null>(null)

  const [layout, setLayout] = React.useState<LayoutKey>("fcose")
  const [search, setSearch] = React.useState("")
  const [visibleNodeTypes, setVisibleNodeTypes] = React.useState<Set<string>>(
    new Set(),
  )
  const [visibleEdgeTypes, setVisibleEdgeTypes] = React.useState<Set<string>>(
    new Set(),
  )
  const [filtersOpen, setFiltersOpen] = React.useState(true)
  const [selectedId, setSelectedId] = React.useState<string>("")

  const allNodeTypes = React.useMemo(
    () => Array.from(new Set((payload?.nodes ?? []).map((n) => n.type))).sort(),
    [payload],
  )
  const allEdgeTypes = React.useMemo(
    () => Array.from(new Set((payload?.edges ?? []).map((e) => e.type))).sort(),
    [payload],
  )

  React.useEffect(() => {
    if (allNodeTypes.length === 0) return
    setVisibleNodeTypes(new Set(allNodeTypes))
  }, [allNodeTypes.join("|")]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (allEdgeTypes.length === 0) return
    setVisibleEdgeTypes(new Set(allEdgeTypes))
  }, [allEdgeTypes.join("|")]) // eslint-disable-line react-hooks/exhaustive-deps

  const nodesById = React.useMemo(() => {
    const m = new Map<string, GraphNode>()
    payload?.nodes.forEach((n) => m.set(n.id, n))
    return m
  }, [payload])

  const selected = selectedId ? nodesById.get(selectedId) ?? null : null

  const handleFit = () => cyRef.current?.fit(undefined, 60)
  const handleExport = () => {
    const cy = cyRef.current
    if (!cy) return
    const png = cy.png({ full: true, scale: 2, bg: "#0b1020" })
    const a = document.createElement("a")
    a.href = png
    a.download = `aag-graph-${new Date().toISOString().slice(0, 10)}.png`
    a.click()
    toast.success("Graph exported as PNG")
  }
  const handleRelayout = () => {
    const cy = cyRef.current
    if (!cy) return
    cy.layout({ name: layout } as never).run()
  }

  if (isLoading && !payload) {
    return <FullCanvasSkeleton />
  }

  const visibleNodes = payload?.nodes ?? []
  const visibleEdges = payload?.edges ?? []
  const hasData = visibleNodes.length > 0

  return (
    <div className="relative flex h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-grid-dot">
      {/* Floating top toolbar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-4">
        <div className="pointer-events-auto flex items-center gap-2">
          <div className="rounded-lg border border-border bg-card/80 backdrop-blur-md px-3 py-1.5 shadow-sm">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Failure graph
            </p>
            <div className="flex items-baseline gap-3">
              <span className="text-sm font-semibold tabular-nums">
                {visibleNodes.length}
              </span>
              <span className="text-[11px] text-muted-foreground">nodes</span>
              <span className="text-sm font-semibold tabular-nums">
                {visibleEdges.length}
              </span>
              <span className="text-[11px] text-muted-foreground">edges</span>
              {payload?.source === "mock" ? (
                <Badge variant="warning" className="ml-1 text-[10px]">
                  Mock
                </Badge>
              ) : (
                <Badge variant="muted" className="ml-1 text-[10px]">
                  Live
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          <Card className="flex items-center gap-1 px-1.5 py-1 backdrop-blur-md bg-card/80 shadow-sm">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search nodes…"
                className="h-8 pl-8 w-56 text-sm"
              />
            </div>
            <Select value={layout} onValueChange={(v) => setLayout(v as LayoutKey)}>
              <SelectTrigger className="h-8 w-40 text-sm">
                <Wand2 className="h-3.5 w-3.5 mr-1.5 opacity-60" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_LAYOUTS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRelayout}
              aria-label="Re-run layout"
              className="text-muted-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleFit}
              aria-label="Fit graph"
              className="text-muted-foreground"
            >
              <Maximize className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleExport}
              aria-label="Export PNG"
              className="text-muted-foreground"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </Card>
        </div>
      </div>

      {/* Floating filter rail */}
      <div className="absolute left-4 top-24 bottom-4 z-10 w-64 flex flex-col gap-3">
        <Card className="flex-1 overflow-hidden flex flex-col backdrop-blur-md bg-card/80 shadow-sm">
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className="flex items-center justify-between px-4 py-2.5 border-b border-border text-left cursor-pointer hover:bg-accent/40"
          >
            <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Filter className="h-3.5 w-3.5" /> Filters
            </span>
            <span className="text-[11px] text-muted-foreground">
              {filtersOpen ? "Hide" : "Show"}
            </span>
          </button>
          {filtersOpen ? (
            <div className="p-3 space-y-4 overflow-y-auto scrollbar-thin">
              <FilterGroup
                title="Node type"
                items={allNodeTypes}
                selected={visibleNodeTypes}
                onToggle={(t) =>
                  setVisibleNodeTypes((prev) => toggle(prev, t))
                }
                onAll={() => setVisibleNodeTypes(new Set(allNodeTypes))}
                onNone={() => setVisibleNodeTypes(new Set())}
              />
              <FilterGroup
                title="Edge type"
                items={allEdgeTypes}
                selected={visibleEdgeTypes}
                onToggle={(t) =>
                  setVisibleEdgeTypes((prev) => toggle(prev, t))
                }
                onAll={() => setVisibleEdgeTypes(new Set(allEdgeTypes))}
                onNone={() => setVisibleEdgeTypes(new Set())}
              />
            </div>
          ) : null}
        </Card>
        <Legend />
      </div>

      {/* Canvas */}
      <div className="flex-1 relative">
        {!hasData ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            <EmptyState
              Icon={Network}
              title="No graph data yet"
              description="The /v1/graph routes haven't been implemented yet. Run `make replay` then `make seed` to populate the failure graph, or append ?mock=1 to preview the layout with the demo fixture."
              action={
                <div className="flex items-center gap-2">
                  <Button onClick={() => mutate()} variant="outline">
                    <RefreshCw className="h-3.5 w-3.5" /> Retry
                  </Button>
                  <Button asChild variant="default">
                    <a href="?mock=1">
                      <Sparkles className="h-3.5 w-3.5" /> Load demo data
                    </a>
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <GraphCanvas
            nodes={visibleNodes}
            edges={visibleEdges}
            layout={layout}
            search={search}
            visibleNodeTypes={visibleNodeTypes}
            visibleEdgeTypes={visibleEdgeTypes}
            onSelectNode={(id) => setSelectedId(id)}
            onCytoscape={(cy) => {
              cyRef.current = cy
            }}
          />
        )}
      </div>

      <NodeDrawer
        node={selected}
        edges={visibleEdges}
        nodesById={nodesById}
        onClose={() => setSelectedId("")}
        onSelectNode={(n) => setSelectedId(n.id)}
      />
    </div>
  )
}

function FilterGroup({
  title,
  items,
  selected,
  onToggle,
  onAll,
  onNone,
}: {
  title: string
  items: string[]
  selected: Set<string>
  onToggle: (t: string) => void
  onAll: () => void
  onNone: () => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] uppercase tracking-widest text-muted-foreground">
          {title}
        </span>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <button
            type="button"
            onClick={onAll}
            className="hover:text-foreground cursor-pointer"
          >
            all
          </button>
          <span>·</span>
          <button
            type="button"
            onClick={onNone}
            className="hover:text-foreground cursor-pointer"
          >
            none
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">—</p>
      ) : (
        <ul className="space-y-1">
          {items.map((t) => (
            <li key={t}>
              <label
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-sm cursor-pointer hover:bg-accent/60",
                )}
              >
                <Checkbox
                  checked={selected.has(t)}
                  onCheckedChange={() => onToggle(t)}
                  aria-label={`Toggle ${t}`}
                />
                <span className="font-mono text-[12px]">{t}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function toggle(prev: Set<string>, t: string): Set<string> {
  const next = new Set(prev)
  if (next.has(t)) next.delete(t)
  else next.add(t)
  return next
}

function FullCanvasSkeleton() {
  return (
    <div className="h-[calc(100vh-3.5rem)] w-full grid place-items-center bg-grid-dot">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" /> Loading graph…
      </div>
    </div>
  )
}

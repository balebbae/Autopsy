"use client"

import * as React from "react"
import useSWR from "swr"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  Download,
  Link2,
  Maximize,
  Network,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import type { ForceGraphMethods } from "react-force-graph-2d"

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
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/primitives/empty-state"
import { NodeDrawer } from "./node-drawer"
import { EdgeCreateModal } from "./edge-create-modal"
import { MiniMap } from "./mini-map"
import {
  GraphCanvas2D,
  type LayoutKey,
  ALL_LAYOUTS,
  LAYOUT_LABELS,
} from "./graph-canvas-2d"
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

  const fgRef = React.useRef<ForceGraphMethods | undefined>(undefined)
  const positionedNodesRef = React.useRef<Array<{ id: string; x?: number; y?: number; type: string }>>([])

  const [layout, setLayout] = React.useState<LayoutKey>("dagLr")
  const [search, setSearch] = React.useState("")
  const [visibleNodeTypes, setVisibleNodeTypes] = React.useState<Set<string>>(
    new Set(),
  )
  const [visibleEdgeTypes, setVisibleEdgeTypes] = React.useState<Set<string>>(
    new Set(),
  )
  const [selectedId, setSelectedId] = React.useState<string>("")
  const [hoveredId, setHoveredId] = React.useState<string>("")
  const [filtersInitialized, setFiltersInitialized] = React.useState(false)
  
  // Edge creation mode
  const [edgeCreateMode, setEdgeCreateMode] = React.useState(false)
  const [edgeSourceId, setEdgeSourceId] = React.useState<string | null>(null)
  const [edgeTargetId, setEdgeTargetId] = React.useState<string | null>(null)
  const [showEdgeModal, setShowEdgeModal] = React.useState(false)

  const allNodeTypes = React.useMemo(
    () => Array.from(new Set((payload?.nodes ?? []).map((n) => n.type))).sort(),
    [payload],
  )
  const allEdgeTypes = React.useMemo(
    () => Array.from(new Set((payload?.edges ?? []).map((e) => e.type))).sort(),
    [payload],
  )

  // Initialize filters when payload first loads
  React.useEffect(() => {
    if (filtersInitialized) return
    if (allNodeTypes.length === 0 || allEdgeTypes.length === 0) return
    setVisibleNodeTypes(new Set(allNodeTypes))
    setVisibleEdgeTypes(new Set(allEdgeTypes))
    setFiltersInitialized(true)
  }, [allNodeTypes, allEdgeTypes, filtersInitialized])

  const nodesById = React.useMemo(() => {
    const m = new Map<string, GraphNode>()
    payload?.nodes.forEach((n) => m.set(n.id, n))
    return m
  }, [payload])

  const selected = selectedId ? nodesById.get(selectedId) ?? null : null

  const handleFit = () => {
    fgRef.current?.zoomToFit(400, 60)
  }
  const handleZoomIn = () => {
    const fg = fgRef.current
    if (!fg) return
    const currentZoom = fg.zoom()
    fg.zoom(currentZoom * 1.4, 300)
  }
  const handleZoomOut = () => {
    const fg = fgRef.current
    if (!fg) return
    const currentZoom = fg.zoom()
    fg.zoom(currentZoom / 1.4, 300)
  }
  const handleExport = () => {
    const fg = fgRef.current
    // Get the canvas element from the force graph
    const container = document.querySelector(".force-graph-container canvas") as HTMLCanvasElement
    if (!container) {
      toast.error("Could not find canvas element")
      return
    }
    const png = container.toDataURL("image/png")
    const a = document.createElement("a")
    a.href = png
    a.download = `aag-graph-${new Date().toISOString().slice(0, 10)}.png`
    a.click()
    toast.success("Graph exported as PNG")
  }
  const handleRelayout = () => {
    fgRef.current?.d3ReheatSimulation()
  }

  // Edge creation handlers
  const handleNodeClickForEdge = (nodeId: string) => {
    if (!edgeCreateMode) {
      setSelectedId(nodeId)
      // Zoom is handled in GraphCanvas2D when selectedId changes
      return
    }
    
    if (!edgeSourceId) {
      setEdgeSourceId(nodeId)
      toast.info("Now click the target node")
    } else if (nodeId !== edgeSourceId) {
      setEdgeTargetId(nodeId)
      setShowEdgeModal(true)
    }
  }

  const handleEdgeSubmit = (edgeType: string, confidence: number) => {
    if (!edgeSourceId || !edgeTargetId) return
    
    // In a real app, this would call an API to create the edge
    // For now, just show a success message
    toast.success(`Connection created: ${edgeType} (${Math.round(confidence * 100)}%)`)
    
    // Reset edge creation state
    setEdgeSourceId(null)
    setEdgeTargetId(null)
    setEdgeCreateMode(false)
    setShowEdgeModal(false)
  }

  const cancelEdgeCreate = () => {
    setEdgeCreateMode(false)
    setEdgeSourceId(null)
    setEdgeTargetId(null)
    setShowEdgeModal(false)
  }

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      switch (e.key) {
        case "f":
          if (e.metaKey || e.ctrlKey) return
          handleFit()
          break
        case "=":
        case "+":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            handleZoomIn()
          }
          break
        case "-":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            handleZoomOut()
          }
          break
        case "Escape":
          if (edgeCreateMode) {
            cancelEdgeCreate()
          } else {
            setSelectedId("")
          }
          break
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [edgeCreateMode])

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
            <p className="text-[10px] text-muted-foreground mt-1">
              Drag to pan · scroll to zoom · click to select
            </p>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-3">
          <Card className="flex items-center gap-2 px-3 py-2 backdrop-blur-md bg-card/90 shadow-md">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search nodes…"
                className="h-10 pl-10 w-64 text-sm"
              />
            </div>
            <Select value={layout} onValueChange={(v) => setLayout(v as LayoutKey)}>
              <SelectTrigger className="h-10 w-44 text-sm">
                <Wand2 className="h-4 w-4 mr-2 opacity-60" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_LAYOUTS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {LAYOUT_LABELS[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1 border-l border-border/50 pl-2 ml-1">
              <Button
                variant={edgeCreateMode ? "default" : "ghost"}
                size="icon"
                onClick={() => {
                  if (edgeCreateMode) {
                    cancelEdgeCreate()
                  } else {
                    setEdgeCreateMode(true)
                    setSelectedId("")
                    toast.info("Click a source node to start")
                  }
                }}
                aria-label={edgeCreateMode ? "Cancel connection" : "Add connection"}
                className={cn(
                  "h-10 w-10",
                  edgeCreateMode ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                )}
              >
                {edgeCreateMode ? <X className="h-5 w-5" /> : <Link2 className="h-5 w-5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleZoomOut}
                aria-label="Zoom out"
                className="text-muted-foreground h-10 w-10"
              >
                <ZoomOut className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleZoomIn}
                aria-label="Zoom in"
                className="text-muted-foreground h-10 w-10"
              >
                <ZoomIn className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleFit}
                aria-label="Fit graph"
                className="text-muted-foreground h-10 w-10"
              >
                <Maximize className="h-5 w-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleExport}
                aria-label="Export PNG"
                className="text-muted-foreground h-10 w-10"
              >
                <Download className="h-5 w-5" />
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {/* Simplified filter panel */}
      <div className="absolute left-4 top-28 z-10">
        <Card className="backdrop-blur-md bg-card/90 shadow-md p-4 w-56">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">Filters</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => {
                  setVisibleNodeTypes(new Set(allNodeTypes))
                  setVisibleEdgeTypes(new Set(allEdgeTypes))
                }}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent"
              >
                All
              </button>
              <button
                type="button"
                onClick={() => {
                  setVisibleNodeTypes(new Set())
                  setVisibleEdgeTypes(new Set())
                }}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent"
              >
                None
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {allNodeTypes.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setVisibleNodeTypes((prev) => toggle(prev, t))}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors",
                  visibleNodeTypes.has(t)
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : "bg-muted/30 border-border/50 text-muted-foreground hover:bg-muted/50"
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </Card>
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
          <>
            <GraphCanvas2D
              fgRef={fgRef}
              positionedNodesRef={positionedNodesRef}
              nodes={visibleNodes}
              edges={visibleEdges}
              layout={layout}
              search={search}
              visibleNodeTypes={visibleNodeTypes}
              visibleEdgeTypes={visibleEdgeTypes}
              selectedId={edgeCreateMode ? edgeSourceId || "" : selectedId}
              hoveredId={hoveredId}
              onSelectNode={handleNodeClickForEdge}
              onHoverNode={(id) => setHoveredId(id)}
            />
            {/* Edge creation mode indicator */}
            {edgeCreateMode && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
                <Card className="px-4 py-2 bg-primary text-primary-foreground shadow-lg">
                  <p className="text-sm font-medium">
                    {edgeSourceId 
                      ? `Source: ${nodesById.get(edgeSourceId)?.name || edgeSourceId} → Click target node`
                      : "Click a source node to start connection"
                    }
                  </p>
                </Card>
              </div>
            )}
            {/* Mini-map */}
            <div className="absolute bottom-4 right-4 z-10">
              <MiniMap fgRef={fgRef} positionedNodesRef={positionedNodesRef} />
            </div>
          </>
        )}
      </div>

      <NodeDrawer
        node={selected}
        edges={visibleEdges}
        nodesById={nodesById}
        onClose={() => setSelectedId("")}
        onSelectNode={(n) => setSelectedId(n.id)}
      />

      <EdgeCreateModal
        open={showEdgeModal}
        onClose={() => {
          setShowEdgeModal(false)
          setEdgeTargetId(null)
        }}
        sourceNode={edgeSourceId ? nodesById.get(edgeSourceId) || null : null}
        targetNode={edgeTargetId ? nodesById.get(edgeTargetId) || null : null}
        onSubmit={handleEdgeSubmit}
      />
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

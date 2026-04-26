"use client"

import * as React from "react"
import useSWR from "swr"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  Activity,
  GitBranch,
  Network,
  RefreshCw,
  Search,
  Sparkles,
  Wand2,
  X,
} from "lucide-react"
import { RetrievalView } from "./retrieval-view"
import type { ForceGraphMethods } from "react-force-graph-2d"

import {
  apiBaseUrl,
  type GraphEdge,
  type GraphNode,
  type Run,
  type RunSummary,
} from "@/lib/api"
import { TimelineView } from "./timeline-view"
import { BranchedView } from "./branched-view"
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
import { Legend } from "./legend"
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

const runsFetcher = async (url: string): Promise<RunSummary[]> => {
  try {
    const r = await fetch(`${url}/v1/runs`, { cache: "no-store" })
    if (!r.ok) return []
    return (await r.json()) as RunSummary[]
  } catch {
    return []
  }
}

// Filter the graph to nodes/edges connected to a specific run.
// Strategy: keep edges with matching evidence_run_id, plus any nodes that are
// endpoints of those edges. This gives a focused subgraph showing the causal
// chain that produced this run's failure.
function filterByRun(
  nodes: GraphNode[],
  edges: GraphEdge[],
  runId: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const runEdges = edges.filter((e) => e.evidence_run_id === runId)
  const keepIds = new Set<string>()
  for (const e of runEdges) {
    keepIds.add(e.source_id)
    keepIds.add(e.target_id)
  }
  const runNodes = nodes.filter((n) => keepIds.has(n.id))
  return { nodes: runNodes, edges: runEdges }
}

// Drop nodes that aren't endpoints of any edge. These slip in two ways:
//   1. test fixtures (`failure_mode=minor_failure`, `change_pattern=added_field`)
//      that share the dev DB and leave behind nodes without edges.
//   2. real-data writer paths that upsert a node before discovering it has no
//      neighbors (e.g. extraction.components without any matching File→Component
//      mapping; FailureMode rows on failure_cases that have no symptoms).
// Either way, an orphan can never be retrieved by Graph RAG (the recursive CTE
// in traversal.py walks edges), so it has no business in the force view.
function dropOrphans(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const connected = new Set<string>()
  for (const e of edges) {
    connected.add(e.source_id)
    connected.add(e.target_id)
  }
  return { nodes: nodes.filter((n) => connected.has(n.id)), edges }
}

type ViewKey = "force" | "timeline" | "branched" | "retrieval"

function parseView(v: string | null): ViewKey {
  if (v === "timeline" || v === "branched" || v === "retrieval") return v
  return "force"
}

const runDetailFetcher = async (key: [string, string]): Promise<Run | null> => {
  const [, runId] = key
  if (!runId) return null
  try {
    const r = await fetch(`${apiBaseUrl}/v1/runs/${runId}`, { cache: "no-store" })
    if (!r.ok) return null
    return (await r.json()) as Run
  } catch {
    return null
  }
}

export function GraphExplorer() {
  const params = useSearchParams()
  const router = useRouter()
  const runFilter = params?.get("run") ?? ""
  const taskParam = params?.get("task") ?? ""
  const view = parseView(params?.get("view") ?? null)

  const setTaskParam = React.useCallback(
    (task: string) => {
      const next = new URLSearchParams(params?.toString() ?? "")
      if (task) next.set("task", task)
      else next.delete("task")
      const qs = next.toString()
      router.replace(qs ? `/graph?${qs}` : "/graph", { scroll: false })
    },
    [params, router],
  )

  const { data, isLoading, mutate } = useSWR(
    ["graph", apiBaseUrl],
    () => fetcher(apiBaseUrl),
    { revalidateOnFocus: false },
  )

  const { data: runsData } = useSWR(
    ["runs", apiBaseUrl],
    () => runsFetcher(apiBaseUrl),
    { revalidateOnFocus: false },
  )

  const setRunFilter = React.useCallback(
    (runId: string) => {
      const next = new URLSearchParams(params?.toString() ?? "")
      if (runId) next.set("run", runId)
      else next.delete("run")
      const qs = next.toString()
      router.replace(qs ? `/graph?${qs}` : "/graph", { scroll: false })
    },
    [params, router],
  )

  const setView = React.useCallback(
    (next: ViewKey) => {
      const params2 = new URLSearchParams(params?.toString() ?? "")
      if (next === "force") params2.delete("view")
      else params2.set("view", next)
      const qs = params2.toString()
      router.replace(qs ? `/graph?${qs}` : "/graph", { scroll: false })
    },
    [params, router],
  )

  // Fetch full run detail (events + rejections + preflight) for timeline /
  // branched views. Skip for force/retrieval (force uses graph nodes/edges,
  // retrieval is task-scoped not run-scoped).
  const runDetailKey: [string, string] | null =
    (view === "timeline" || view === "branched") && runFilter
      ? ["runDetail", runFilter]
      : null
  const { data: runDetailData, isLoading: runDetailLoading } = useSWR(
    runDetailKey,
    runDetailFetcher,
    { revalidateOnFocus: false },
  )
  const effectiveRun = runDetailData ?? null

  // Unfiltered base graph — used both for the all-runs view and for computing
  // which runs actually have evidence in the picker.
  const baseGraph: GraphPayload | null = React.useMemo(() => {
    if (!data) return null
    if (!data.ok) return null
    return { nodes: data.nodes, edges: data.edges }
  }, [data])

  // Set of run_ids that actually have at least one edge in the graph.
  // Used to filter the picker dropdown to runs the user can usefully focus on.
  const runIdsWithEvidence = React.useMemo(() => {
    const s = new Set<string>()
    for (const e of baseGraph?.edges ?? []) {
      if (e.evidence_run_id) s.add(e.evidence_run_id)
    }
    return s
  }, [baseGraph])

  const payload: GraphPayload | null = React.useMemo(() => {
    if (!baseGraph) return null
    const scoped = runFilter
      ? filterByRun(baseGraph.nodes, baseGraph.edges, runFilter)
      : baseGraph
    // filterByRun already keeps only endpoint nodes; the unfiltered case can
    // contain orphans, so apply the dedicated filter there.
    return runFilter ? scoped : dropOrphans(scoped.nodes, scoped.edges)
  }, [baseGraph, runFilter])

  const fgRef = React.useRef<ForceGraphMethods | undefined>(undefined)
  const positionedNodesRef = React.useRef<Array<{ id: string; x?: number; y?: number; type: string }>>([])

  const [layout, setLayout] = React.useState<LayoutKey>("force")
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
  }  // Edge creation handlers
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
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-4 md:px-6">
        <div className={cn("pointer-events-auto flex items-center gap-2", view !== "force" && "hidden")}>
            <div className="rounded-lg border border-border bg-card/80 backdrop-blur-md px-3 py-1.5 shadow-sm">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {runFilter ? "Graph RAG · run focus" : "Graph RAG surface"}
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
              <Badge variant="muted" className="ml-1 text-[10px]">
                Live
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {runFilter
                ? "Subgraph emitted by this run · drag · scroll · click"
                : "Edges preflight walks via typed CTE · drag · scroll · click"}
            </p>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-3 ml-auto">
          <Card className="flex items-center gap-1 p-1 backdrop-blur-md bg-card/90 shadow-md">
            <ViewToggleButton
              active={view === "force"}
              onClick={() => setView("force")}
              icon={<Network className="h-3.5 w-3.5" />}
              label="Force"
            />
            <ViewToggleButton
              active={view === "timeline"}
              onClick={() => setView("timeline")}
              icon={<Activity className="h-3.5 w-3.5" />}
              label="Timeline"
            />
            <ViewToggleButton
              active={view === "branched"}
              onClick={() => setView("branched")}
              icon={<GitBranch className="h-3.5 w-3.5" />}
              label="Branched"
            />
            <ViewToggleButton
              active={view === "retrieval"}
              onClick={() => setView("retrieval")}
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="Retrieval"
            />
          </Card>
          {(() => {
            // Run picker stands alone so it stays visible across the run-scoped
            // views. Retrieval is task-scoped (not tied to a single run) so
            // the picker hides there. For the force view we keep the original
            // behavior (only show runs with graph evidence). For timeline /
            // branched, show every run since those views don't depend on the
            // graph data being populated.
            if (view === "retrieval") return null
            const allRuns = runsData ?? []
            const selectableRuns =
              view === "force"
                ? allRuns.filter(
                    (r) =>
                      runIdsWithEvidence.has(r.run_id) || r.run_id === runFilter,
                  )
                : allRuns
            if (selectableRuns.length === 0) return null
            const placeholder = view === "force" ? "All runs" : "Pick a run…"
            return (
              <Card className="flex items-center gap-2 px-3 py-2 backdrop-blur-md bg-card/90 shadow-md">
                <Select
                  value={runFilter || "__all__"}
                  onValueChange={(v) => setRunFilter(v === "__all__" ? "" : v)}
                >
                  <SelectTrigger className="h-10 w-56 text-sm">
                    <Network className="h-4 w-4 mr-2 opacity-60" />
                    <SelectValue placeholder={placeholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {view === "force" ? (
                      <SelectItem value="__all__">All runs</SelectItem>
                    ) : null}
                    {selectableRuns.map((r) => (
                      <SelectItem key={r.run_id} value={r.run_id}>
                        <span className="truncate max-w-[20rem] inline-block align-middle">
                          {r.task ?? r.run_id.slice(0, 16)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Card>
            )
          })()}
          <Card className={cn("flex items-center gap-2 px-3 py-2 backdrop-blur-md bg-card/90 shadow-md", view !== "force" && "hidden")}>
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
          </Card>
        </div>
      </div>

      {/* Simplified filter panel — only relevant for force view */}
      <div className={cn("absolute left-4 top-28 z-10", view !== "force" && "hidden")}>
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
      <div
        className={cn(
          // `min-w-0` is critical: without it, this `flex-1` item inherits
          // `min-width: auto` and expands to fit its widest descendant, so
          // `overflow-x-auto` on the timeline scroller never engages and
          // wide content (multi-attempt timelines, retrieval traces) just
          // pushes the layout instead of scrolling.
          "flex-1 relative min-w-0",
          view !== "force" && "pt-20",
        )}
      >
        {view === "retrieval" ? (
          <RetrievalView initialTask={taskParam} onTaskChange={setTaskParam} />
        ) : view !== "force" ? (
          <RunViewSwitch
            view={view}
            run={effectiveRun}
            runFilter={runFilter}
            isLoading={runDetailLoading}
          />
        ) : !hasData ? (
          <div className="absolute inset-0 grid place-items-center p-6">
            {runFilter ? (
              <EmptyState
                Icon={Network}
                title="No graph evidence for this run yet"
                description="The failure graph is only generated after a run is finalized (rejected, approved, or completed). Active runs don't appear here until they end and the autopsy classifier runs."
                action={
                  <div className="flex items-center gap-2">
                    <Button onClick={() => setRunFilter("")} variant="default">
                      <Network className="h-3.5 w-3.5" /> Show all runs
                    </Button>
                    <Button asChild variant="outline">
                      <a href={`/runs/${runFilter}`}>
                        <X className="h-3.5 w-3.5" /> Open run details
                      </a>
                    </Button>
                  </div>
                }
              />
            ) : (
              <EmptyState
                Icon={Network}
                title="No graph data yet"
                description="Run `make replay` then `make seed` to populate the failure graph from finalized runs."
                action={
                  <div className="flex items-center gap-2">
                    <Button onClick={() => mutate()} variant="outline">
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </Button>
                  </div>
                }
              />
            )}
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
            {/* Legend */}
            <div className="absolute bottom-4 left-4 z-10 max-h-[calc(100vh-12rem)] overflow-y-auto">
              <Legend />
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

function ViewToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function RunViewSwitch({
  view,
  run,
  runFilter,
  isLoading,
}: {
  view: "timeline" | "branched"
  run: Run | null
  runFilter: string
  isLoading: boolean
}) {
  if (!runFilter) {
    return (
      <div className="absolute inset-0 grid place-items-center p-6">
        <EmptyState
          Icon={view === "timeline" ? Activity : GitBranch}
          title={`Pick a run to view its ${view === "timeline" ? "timeline" : "branched timeline"}`}
          description={
            view === "timeline"
              ? "The timeline view shows a per-run narrative \u2014 user messages drive the spine, attempts hang below. Use the run picker above to choose one."
              : "The branched view renders each user message as a spine point with agent attempts branching downward and rejections terminating at \u2715. Pick a run above."
          }
        />
      </div>
    )
  }
  if (isLoading || !run) {
    return (
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" /> Loading run…
        </div>
      </div>
    )
  }
  if (view === "timeline") return <TimelineView run={run} />
  return <BranchedView run={run} />
}

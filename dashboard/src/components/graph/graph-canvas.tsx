"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import * as THREE from "three"

import type { GraphEdge, GraphNode } from "@/lib/api"
import { nodeStyle } from "./graph-style"
import type { ForceGraphMethods } from "react-force-graph-3d"

const ForceGraph3D = dynamic(
  () => import("react-force-graph-3d").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full min-h-[320px] rounded-lg bg-[#050816] animate-pulse" />
    ),
  },
)

/** Preserved keys from the Cytoscape era — now mapped to 3D force / DAG modes. */
export type LayoutKey = "fcose" | "cose-bilkent" | "breadthfirst" | "circle" | "grid"

export const ALL_LAYOUTS: LayoutKey[] = [
  "fcose",
  "cose-bilkent",
  "breadthfirst",
  "circle",
  "grid",
]

export const LAYOUT_LABELS: Record<LayoutKey, string> = {
  fcose: "Force 3D",
  "cose-bilkent": "Force (spread)",
  breadthfirst: "Tree (top-down)",
  circle: "Radial tree",
  grid: "Hierarchy (LR)",
}

type DagMode = "td" | "bu" | "lr" | "rl" | "zout" | "zin" | "radialout" | "radialin"

const LAYOUT_DAG: Record<LayoutKey, DagMode | null> = {
  fcose: null,
  "cose-bilkent": null,
  breadthfirst: "td",
  circle: "radialout",
  grid: "lr",
}

type FGNode = {
  id: string
  name: string
  type: string
  color: string
  val: number
}

type FGLink = {
  id: string
  source: string
  target: string
  edgeType: string
  confidence?: number | null
}

const NODE_VAL: Record<string, number> = {
  Run: 2.8,
  Task: 2.2,
  FailureMode: 2.6,
  Outcome: 2.1,
  FixPattern: 2,
  Symptom: 1.7,
  ChangePattern: 1.8,
  Component: 1.9,
  File: 1.6,
}

function nodeValFor(n: GraphNode): number {
  return NODE_VAL[n.type] ?? 1.5
}

export function GraphCanvas({
  nodes,
  edges,
  layout,
  search,
  visibleNodeTypes,
  visibleEdgeTypes,
  onSelectNode,
  fgRef,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  layout: LayoutKey
  search: string
  visibleNodeTypes: Set<string>
  visibleEdgeTypes: Set<string>
  onSelectNode: (id: string) => void
  fgRef: React.MutableRefObject<ForceGraphMethods | undefined>
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [dim, setDim] = React.useState({ w: 0, h: 0 })

  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () =>
      setDim({ w: Math.max(320, el.clientWidth), h: Math.max(320, el.clientHeight) })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const graphData = React.useMemo(() => {
    const ns: FGNode[] = nodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      color: nodeStyle(n).color,
      val: nodeValFor(n),
    }))
    const ls: FGLink[] = edges.map((e) => ({
      id: e.id,
      source: e.source_id,
      target: e.target_id,
      edgeType: e.type,
      confidence: e.confidence ?? null,
    }))
    return { nodes: ns, links: ls }
  }, [nodes, edges])

  const matchingIds = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    const set = new Set<string>()
    for (const n of graphData.nodes) {
      if (
        n.name.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q)
      ) {
        set.add(n.id)
      }
    }
    return set
  }, [graphData.nodes, search])

  const dagMode = LAYOUT_DAG[layout]

  React.useEffect(() => {
    const fg = fgRef.current
    if (!fg || dagMode) return
    const spread = layout === "cose-bilkent"
    fg.d3Force("charge")?.strength(spread ? -260 : -120)
    const link = fg.d3Force("link") as { distance?: (v: number) => void } | undefined
    if (link && typeof link.distance === "function") {
      link.distance(spread ? 72 : 48)
    }
    fg.d3ReheatSimulation()
  }, [layout, dagMode, fgRef])

  const autoFitDone = React.useRef(false)
  React.useEffect(() => {
    autoFitDone.current = false
  }, [graphData, layout, dagMode])

  React.useEffect(() => {
    fgRef.current?.refresh()
  }, [matchingIds, fgRef])

  const nodeThreeObject = React.useCallback(
    (node: object) => {
      const n = node as FGNode
      const dimmed = matchingIds && !matchingIds.has(n.id)
      const opacity = dimmed ? 0.14 : 1
      const r = 5 + n.val * 2.2
      const geom = new THREE.SphereGeometry(r, 40, 40)
      const col = new THREE.Color(n.color)
      const mat = new THREE.MeshPhysicalMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: dimmed ? 0.08 : 0.42,
        metalness: 0.22,
        roughness: 0.28,
        clearcoat: 0.92,
        clearcoatRoughness: 0.12,
        transparent: true,
        opacity,
      })
      return new THREE.Mesh(geom, mat)
    },
    [matchingIds],
  )

  if (dim.w === 0 || dim.h === 0) {
    return <div ref={containerRef} className="h-full w-full min-h-[320px]" />
  }

  return (
    <div ref={containerRef} className="h-full w-full min-h-[320px] rounded-lg overflow-hidden">
      <ForceGraph3D
        ref={fgRef}
        width={dim.w}
        height={dim.h}
        graphData={graphData}
        backgroundColor="rgba(5, 8, 18, 0.92)"
        controlType="trackball"
        rendererConfig={{
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
          preserveDrawingBuffer: true,
        }}
        showNavInfo={false}
        dagMode={dagMode ?? undefined}
        dagLevelDistance={layout === "circle" ? 110 : 88}
        warmupTicks={dagMode ? 48 : 96}
        cooldownTicks={dagMode ? 120 : 280}
        d3VelocityDecay={0.22}
        nodeId="id"
        nodeLabel={(n) =>
          `<div style="padding:6px 8px;border-radius:8px;background:rgba(15,23,42,0.92);border:1px solid rgba(148,163,184,0.35);font:12px system-ui;max-width:220px"><b style="color:#e2e8f0">${(n as FGNode).name}</b><br/><span style="color:#94a3b8;font-family:ui-monospace">${(n as FGNode).type}</span></div>`
        }
        nodeThreeObject={nodeThreeObject}
        nodeVisibility={(n) => visibleNodeTypes.has((n as FGNode).type)}
        linkSource="source"
        linkTarget="target"
        linkLabel={(l) => (l as FGLink).edgeType}
        linkVisibility={(l) => {
          const link = l as FGLink
          if (!visibleEdgeTypes.has(link.edgeType)) return false
          return visibleNodeTypes.has(
            graphData.nodes.find((x) => x.id === link.source)?.type ?? "",
          ) &&
            visibleNodeTypes.has(
              graphData.nodes.find((x) => x.id === link.target)?.type ?? "",
            )
        }}
        linkColor={(l) => {
          const link = l as FGLink
          if (!matchingIds) return "rgba(129, 140, 248, 0.45)"
          const sid =
            typeof link.source === "object"
              ? (link.source as FGNode).id
              : String(link.source)
          const tid =
            typeof link.target === "object"
              ? (link.target as FGNode).id
              : String(link.target)
          const hit = matchingIds.has(sid) || matchingIds.has(tid)
          return hit ? "rgba(165, 180, 252, 0.62)" : "rgba(129, 140, 248, 0.06)"
        }}
        linkWidth={(l) => {
          const c = (l as FGLink).confidence
          return 0.35 + (typeof c === "number" ? c : 0.5) * 2.2
        }}
        linkCurvature={0.18}
        linkDirectionalArrowLength={5}
        linkDirectionalArrowRelPos={0.92}
        linkDirectionalArrowColor={() => "rgba(165, 180, 252, 0.85)"}
        linkDirectionalParticles={2}
        linkDirectionalParticleWidth={1.2}
        linkDirectionalParticleSpeed={0.008}
        linkDirectionalParticleColor={() => "rgba(196, 181, 253, 0.95)"}
        onNodeClick={(node) => onSelectNode((node as FGNode).id)}
        onBackgroundClick={() => onSelectNode("")}
        onEngineStop={() => {
          if (autoFitDone.current) return
          autoFitDone.current = true
          requestAnimationFrame(() => {
            fgRef.current?.zoomToFit(600, 80, (n) =>
              visibleNodeTypes.has((n as FGNode).type),
            )
          })
        }}
      />
    </div>
  )
}

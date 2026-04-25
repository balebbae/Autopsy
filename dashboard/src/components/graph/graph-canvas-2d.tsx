"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import type { ForceGraphMethods } from "react-force-graph-2d"

import type { GraphEdge, GraphNode } from "@/lib/api"
import { nodeStyle, edgeStyle, type NodeStyleConfig } from "./graph-style"

const ForceGraph2D = dynamic(
  () => import("react-force-graph-2d").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="h-full w-full min-h-[320px] rounded-lg bg-slate-900 animate-pulse" />
    ),
  },
)

export type LayoutKey = "force" | "dagTd" | "dagLr" | "dagRadial" | "dagBu"

export const ALL_LAYOUTS: LayoutKey[] = [
  "force",
  "dagTd",
  "dagLr",
  "dagRadial",
  "dagBu",
]

export const LAYOUT_LABELS: Record<LayoutKey, string> = {
  force: "Force-directed",
  dagTd: "Hierarchy (top-down)",
  dagLr: "Hierarchy (left-right)",
  dagRadial: "Radial",
  dagBu: "Hierarchy (bottom-up)",
}

type DagMode = "td" | "bu" | "lr" | "rl" | "radialout" | "radialin" | null

const LAYOUT_DAG: Record<LayoutKey, DagMode> = {
  force: null,
  dagTd: "td",
  dagLr: "lr",
  dagRadial: "radialout",
  dagBu: "bu",
}

type FGNode = {
  id: string
  name: string
  type: string
  style: NodeStyleConfig
  val: number
  properties?: Record<string, unknown>
  x?: number
  y?: number
}

type FGLink = {
  id: string
  source: string | FGNode
  target: string | FGNode
  edgeType: string
  confidence?: number | null
}

const NODE_SIZE: Record<string, number> = {
  Run: 28,
  Task: 24,
  FailureMode: 26,
  Outcome: 22,
  FixPattern: 22,
  Symptom: 20,
  ChangePattern: 20,
  Component: 20,
  File: 18,
}

function nodeSizeFor(type: string): number {
  return NODE_SIZE[type] ?? 18
}

// Icon paths (simplified SVG paths for canvas rendering)
const ICON_PATHS: Record<string, (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => void> = {
  play: (ctx, x, y, s) => {
    ctx.beginPath()
    ctx.moveTo(x - s * 0.3, y - s * 0.4)
    ctx.lineTo(x + s * 0.4, y)
    ctx.lineTo(x - s * 0.3, y + s * 0.4)
    ctx.closePath()
    ctx.fill()
  },
  "clipboard-list": (ctx, x, y, s) => {
    ctx.strokeRect(x - s * 0.35, y - s * 0.4, s * 0.7, s * 0.8)
    ctx.fillRect(x - s * 0.2, y - s * 0.15, s * 0.4, s * 0.08)
    ctx.fillRect(x - s * 0.2, y + s * 0.05, s * 0.4, s * 0.08)
    ctx.fillRect(x - s * 0.2, y + s * 0.22, s * 0.25, s * 0.08)
  },
  "file-code": (ctx, x, y, s) => {
    ctx.beginPath()
    ctx.moveTo(x - s * 0.3, y - s * 0.4)
    ctx.lineTo(x + s * 0.1, y - s * 0.4)
    ctx.lineTo(x + s * 0.3, y - s * 0.2)
    ctx.lineTo(x + s * 0.3, y + s * 0.4)
    ctx.lineTo(x - s * 0.3, y + s * 0.4)
    ctx.closePath()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x - s * 0.1, y - s * 0.05)
    ctx.lineTo(x - s * 0.2, y + s * 0.1)
    ctx.lineTo(x - s * 0.1, y + s * 0.25)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x + s * 0.1, y - s * 0.05)
    ctx.lineTo(x + s * 0.2, y + s * 0.1)
    ctx.lineTo(x + s * 0.1, y + s * 0.25)
    ctx.stroke()
  },
  box: (ctx, x, y, s) => {
    ctx.strokeRect(x - s * 0.35, y - s * 0.3, s * 0.7, s * 0.6)
    ctx.beginPath()
    ctx.moveTo(x - s * 0.35, y - s * 0.1)
    ctx.lineTo(x + s * 0.35, y - s * 0.1)
    ctx.stroke()
  },
  "git-branch": (ctx, x, y, s) => {
    ctx.beginPath()
    ctx.arc(x - s * 0.15, y - s * 0.25, s * 0.12, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x + s * 0.15, y - s * 0.25, s * 0.12, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y + s * 0.3, s * 0.12, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x - s * 0.15, y - s * 0.13)
    ctx.lineTo(x - s * 0.15, y + s * 0.05)
    ctx.quadraticCurveTo(x - s * 0.15, y + s * 0.18, x, y + s * 0.18)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x + s * 0.15, y - s * 0.13)
    ctx.lineTo(x + s * 0.15, y + s * 0.05)
    ctx.quadraticCurveTo(x + s * 0.15, y + s * 0.18, x, y + s * 0.18)
    ctx.stroke()
  },
  "alert-triangle": (ctx, x, y, s) => {
    ctx.beginPath()
    ctx.moveTo(x, y - s * 0.35)
    ctx.lineTo(x + s * 0.35, y + s * 0.3)
    ctx.lineTo(x - s * 0.35, y + s * 0.3)
    ctx.closePath()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x, y - s * 0.1)
    ctx.lineTo(x, y + s * 0.08)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y + s * 0.18, s * 0.04, 0, Math.PI * 2)
    ctx.fill()
  },
  "x-circle": (ctx, x, y, s) => {
    ctx.beginPath()
    ctx.arc(x, y, s * 0.38, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x - s * 0.2, y - s * 0.2)
    ctx.lineTo(x + s * 0.2, y + s * 0.2)
    ctx.moveTo(x + s * 0.2, y - s * 0.2)
    ctx.lineTo(x - s * 0.2, y + s * 0.2)
    ctx.stroke()
  },
  wrench: (ctx, x, y, s) => {
    ctx.beginPath()
    ctx.moveTo(x - s * 0.3, y + s * 0.3)
    ctx.lineTo(x + s * 0.1, y - s * 0.1)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x + s * 0.15, y - s * 0.15, s * 0.2, -Math.PI * 0.3, Math.PI * 0.7)
    ctx.stroke()
  },
  "check-circle": (ctx, x, y, s) => {
    ctx.beginPath()
    ctx.arc(x, y, s * 0.38, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x - s * 0.18, y)
    ctx.lineTo(x - s * 0.05, y + s * 0.15)
    ctx.lineTo(x + s * 0.2, y - s * 0.15)
    ctx.stroke()
  },
  flag: (ctx, x, y, s) => {
    ctx.beginPath()
    ctx.moveTo(x - s * 0.25, y - s * 0.35)
    ctx.lineTo(x - s * 0.25, y + s * 0.4)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x - s * 0.25, y - s * 0.35)
    ctx.lineTo(x + s * 0.3, y - s * 0.2)
    ctx.lineTo(x - s * 0.25, y - s * 0.05)
    ctx.closePath()
    ctx.fill()
  },
  circle: (ctx, x, y, s) => {
    ctx.beginPath()
    ctx.arc(x, y, s * 0.3, 0, Math.PI * 2)
    ctx.fill()
  },
}

function drawIcon(ctx: CanvasRenderingContext2D, icon: string, x: number, y: number, size: number, color: string) {
  ctx.save()
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.lineWidth = size * 0.08
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  const draw = ICON_PATHS[icon] ?? ICON_PATHS.circle
  draw(ctx, x, y, size)
  ctx.restore()
}

export function GraphCanvas2D({
  nodes,
  edges,
  layout,
  search,
  visibleNodeTypes,
  visibleEdgeTypes,
  selectedId,
  hoveredId,
  onSelectNode,
  onHoverNode,
  fgRef,
  positionedNodesRef,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  layout: LayoutKey
  search: string
  visibleNodeTypes: Set<string>
  visibleEdgeTypes: Set<string>
  selectedId: string
  hoveredId: string
  onSelectNode: (id: string) => void
  onHoverNode: (id: string) => void
  fgRef: React.MutableRefObject<ForceGraphMethods | undefined>
  positionedNodesRef?: React.MutableRefObject<Array<{ id: string; x?: number; y?: number; type: string }>>
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
    const ns: FGNode[] = nodes
      .filter((n) => visibleNodeTypes.has(n.type))
      .map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        style: nodeStyle(n),
        val: nodeSizeFor(n.type),
        properties: n.properties,
      }))
    const nodeIds = new Set(ns.map((n) => n.id))
    const ls: FGLink[] = edges
      .filter(
        (e) =>
          visibleEdgeTypes.has(e.type) &&
          nodeIds.has(e.source_id) &&
          nodeIds.has(e.target_id)
      )
      .map((e) => ({
        id: e.id,
        source: e.source_id,
        target: e.target_id,
        edgeType: e.type,
        confidence: e.confidence ?? null,
      }))
    return { nodes: ns, links: ls }
  }, [nodes, edges, visibleNodeTypes, visibleEdgeTypes])

  // Expose positioned nodes to parent (mini-map)
  React.useEffect(() => {
    if (positionedNodesRef) {
      positionedNodesRef.current = graphData.nodes
    }
  }, [graphData.nodes, positionedNodesRef])

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

  // Configure forces - use layout effect to run before paint
  React.useLayoutEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    
    // Configure forces for better spacing with card-based nodes
    const charge = fg.d3Force("charge") as { strength: (v: number) => unknown; distanceMin?: (v: number) => unknown; distanceMax?: (v: number) => unknown } | undefined
    if (charge) {
      charge.strength(-800)
      if (typeof charge.distanceMin === "function") charge.distanceMin(100)
      if (typeof charge.distanceMax === "function") charge.distanceMax(600)
    }

    const link = fg.d3Force("link") as { distance?: (v: number) => unknown; strength?: (v: number) => unknown } | undefined
    if (link) {
      if (typeof link.distance === "function") link.distance(160)
      if (typeof link.strength === "function") link.strength(0.3)
    }
    
    fg.d3ReheatSimulation()
  }, [graphData, layout])

  const autoFitDone = React.useRef(false)
  React.useEffect(() => {
    autoFitDone.current = false
  }, [graphData, layout, dagMode])

  // Center on selected node (no zoom change)
  const prevSelectedId = React.useRef<string>("")
  React.useEffect(() => {
    if (!selectedId || selectedId === prevSelectedId.current) return
    prevSelectedId.current = selectedId
    
    const fg = fgRef.current
    if (!fg) return
    
    // Find the node in graphData
    const node = graphData.nodes.find((n) => n.id === selectedId)
    if (node && node.x !== undefined && node.y !== undefined) {
      fg.centerAt(node.x, node.y, 300)
    }
  }, [selectedId, graphData.nodes, fgRef])

  const nodeCanvasObject = React.useCallback(
    (node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as FGNode
      const x = n.x ?? 0
      const y = n.y ?? 0
      const style = n.style
      
      const isSelected = n.id === selectedId
      const isHovered = n.id === hoveredId
      const isDimmed = matchingIds && !matchingIds.has(n.id)

      // Visual hierarchy - size based on importance
      const isFailureMode = n.type === "FailureMode"
      const isFixPattern = n.type === "FixPattern"
      const isSymptom = n.type === "Symptom"
      const isMinor = n.type === "File" || n.type === "Component"
      
      // Card dimensions - compact sizes
      const cardWidth = isFailureMode ? 150 : isFixPattern ? 145 : isMinor ? 120 : 135
      const cardHeight = isFailureMode ? 52 : isFixPattern ? 50 : isMinor ? 42 : 48
      const accentWidth = 4
      const cornerRadius = 6

      ctx.save()
      ctx.globalAlpha = isDimmed ? 0.25 : 1

      // Glow effect for important nodes
      if (isFailureMode && !isDimmed) {
        ctx.shadowColor = "rgba(239, 68, 68, 0.4)"
        ctx.shadowBlur = 20
      } else if (isFixPattern && !isDimmed) {
        ctx.shadowColor = "rgba(52, 211, 153, 0.3)"
        ctx.shadowBlur = 16
      } else if (isSelected || isHovered) {
        ctx.shadowColor = "rgba(0, 0, 0, 0.3)"
        ctx.shadowBlur = 12
      } else {
        ctx.shadowColor = "rgba(0, 0, 0, 0.2)"
        ctx.shadowBlur = 6
      }
      ctx.shadowOffsetY = 2

      // Card background
      ctx.fillStyle = isSelected ? "#1e293b" : "#0f172a"
      ctx.beginPath()
      ctx.roundRect(x - cardWidth / 2, y - cardHeight / 2, cardWidth, cardHeight, cornerRadius)
      ctx.fill()

      // Reset shadow
      ctx.shadowColor = "transparent"
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0

      // Border
      ctx.strokeStyle = isSelected ? style.color : isHovered ? style.color : "#334155"
      ctx.lineWidth = isSelected ? 2 : isHovered ? 1.5 : 1
      ctx.stroke()

      // Left accent bar
      ctx.fillStyle = style.color
      ctx.beginPath()
      ctx.roundRect(
        x - cardWidth / 2,
        y - cardHeight / 2,
        accentWidth,
        cardHeight,
        [cornerRadius, 0, 0, cornerRadius]
      )
      ctx.fill()

      // Type badge (top-left, after accent)
      const badgeX = x - cardWidth / 2 + accentWidth + 6
      const badgeY = y - cardHeight / 2 + 10
      const badgeFontSize = 8
      ctx.font = `700 ${badgeFontSize}px Inter, system-ui, sans-serif`
      const typeText = n.type.toUpperCase()
      const typeWidth = ctx.measureText(typeText).width
      
      // Badge background
      ctx.fillStyle = style.color + "25"
      ctx.beginPath()
      ctx.roundRect(badgeX - 3, badgeY - 6, typeWidth + 6, badgeFontSize + 6, 3)
      ctx.fill()
      
      // Badge text
      ctx.fillStyle = style.color
      ctx.textAlign = "left"
      ctx.textBaseline = "middle"
      ctx.fillText(typeText, badgeX, badgeY)

      // Icon (right side of badge)
      const iconSize = 9
      const iconX = badgeX + typeWidth + 8
      drawIcon(ctx, style.icon, iconX, badgeY, iconSize, style.color)

      // Node name (main content)
      const nameY = y - cardHeight / 2 + 22
      const nameFontSize = isFailureMode ? 11 : isMinor ? 9 : 10
      ctx.font = `600 ${nameFontSize}px Inter, system-ui, sans-serif`
      ctx.fillStyle = "#f1f5f9"
      ctx.textAlign = "left"
      ctx.textBaseline = "top"

      // Truncate name to fit
      let displayName = n.name
      const maxTextWidth = cardWidth - accentWidth - 14
      while (ctx.measureText(displayName).width > maxTextWidth && displayName.length > 0) {
        displayName = displayName.slice(0, -1)
      }
      if (displayName !== n.name) displayName += "…"
      ctx.fillText(displayName, x - cardWidth / 2 + accentWidth + 6, nameY)

      // Secondary info line (smaller, only if card is big enough)
      if (cardHeight >= 48) {
        const infoY = nameY + nameFontSize + 4
        ctx.font = `400 ${8}px ui-monospace, monospace`
        ctx.fillStyle = "#64748b"
        const idSnippet = n.id.length > 20 ? n.id.slice(0, 20) + "…" : n.id
        ctx.fillText(idSnippet, x - cardWidth / 2 + accentWidth + 6, infoY)
      }

      ctx.restore()
    },
    [selectedId, hoveredId, matchingIds]
  )

  const linkCanvasObject = React.useCallback(
    (link: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const l = link as FGLink
      const source = l.source as FGNode
      const target = l.target as FGNode
      if (!source.x || !source.y || !target.x || !target.y) return

      const isConnectedToSelected =
        selectedId && (source.id === selectedId || target.id === selectedId)
      const isDimmed =
        matchingIds &&
        !matchingIds.has(source.id) &&
        !matchingIds.has(target.id)

      // Edge color based on type
      const edgeColors: Record<string, string> = {
        INDICATES: "#ef4444",    // Red - symptoms indicate failures
        FIXED_BY: "#34d399",     // Green - fixes
        EXHIBITED: "#fb923c",    // Orange - symptoms
        RESULTED_IN: "#64748b",  // Gray - outcomes
        EXECUTED: "#38bdf8",     // Blue - runs
        EDITED: "#a78bfa",       // Purple - edits
        PART_OF: "#94a3b8",      // Light gray - structure
        MATCHED: "#f472b6",      // Pink - patterns
        TYPE_OF: "#fbbf24",      // Yellow - types
      }
      const edgeColor = edgeColors[l.edgeType] || "#475569"
      
      // Line thickness based on confidence (1-3px)
      const confidence = l.confidence ?? 0.5
      const baseThickness = 1 + confidence * 2

      ctx.save()
      ctx.globalAlpha = isDimmed ? 0.15 : 1

      // Card dimensions for offset calculation (match compact sizes)
      const sourceIsMinor = source.type === "File" || source.type === "Component"
      const targetIsMinor = target.type === "File" || target.type === "Component"
      const sourceWidth = sourceIsMinor ? 120 : source.type === "FailureMode" ? 150 : 135
      const sourceHeight = sourceIsMinor ? 42 : source.type === "FailureMode" ? 52 : 48
      const targetWidth = targetIsMinor ? 120 : target.type === "FailureMode" ? 150 : 135
      const targetHeight = targetIsMinor ? 42 : target.type === "FailureMode" ? 52 : 48

      // Calculate edge points from card boundaries
      const dx = target.x - source.x
      const dy = target.y - source.y
      const angle = Math.atan2(dy, dx)

      // Offset from card edges
      const sourceOffsetX = Math.cos(angle) * (sourceWidth / 2 + 8)
      const sourceOffsetY = Math.sin(angle) * (sourceHeight / 2 + 8)
      const targetOffsetX = Math.cos(angle) * (targetWidth / 2 + 8)
      const targetOffsetY = Math.sin(angle) * (targetHeight / 2 + 8)

      const startX = source.x + sourceOffsetX
      const startY = source.y + sourceOffsetY
      const endX = target.x - targetOffsetX
      const endY = target.y - targetOffsetY

      // Line style - colored by type, thickness by confidence
      const displayColor = isConnectedToSelected ? edgeColor : isDimmed ? "#334155" : edgeColor + "90"
      ctx.strokeStyle = displayColor
      ctx.lineWidth = isConnectedToSelected ? baseThickness + 0.5 : baseThickness
      
      // Dashed for structural edges, solid for causal
      const isDashed = l.edgeType === "PART_OF" || l.edgeType === "TYPE_OF"
      if (isDashed) {
        ctx.setLineDash([5, 4])
      }

      // Draw line
      ctx.beginPath()
      ctx.moveTo(startX, startY)
      ctx.lineTo(endX, endY)
      ctx.stroke()

      // Arrow head
      ctx.setLineDash([])
      const arrowAngle = Math.atan2(endY - startY, endX - startX)
      const arrowLen = 8 + confidence * 2
      ctx.fillStyle = displayColor
      ctx.beginPath()
      ctx.moveTo(endX, endY)
      ctx.lineTo(
        endX - arrowLen * Math.cos(arrowAngle - Math.PI / 7),
        endY - arrowLen * Math.sin(arrowAngle - Math.PI / 7)
      )
      ctx.lineTo(
        endX - arrowLen * Math.cos(arrowAngle + Math.PI / 7),
        endY - arrowLen * Math.sin(arrowAngle + Math.PI / 7)
      )
      ctx.closePath()
      ctx.fill()

      // Show confidence label only on hover/selection or high confidence
      const showLabel = isConnectedToSelected || (confidence >= 0.85 && !isDimmed)
      if (typeof l.confidence === "number" && showLabel) {
        const midX = (startX + endX) / 2
        const midY = (startY + endY) / 2
        const confText = `${Math.round(l.confidence * 100)}%`
        const fontSize = 11
        const padding = 6
        
        ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"

        // Measure text for background
        const labelMetrics = ctx.measureText(confText)
        const bgWidth = labelMetrics.width + padding * 2
        const bgHeight = fontSize + padding

        // Background pill
        ctx.fillStyle = "#0f172a"
        ctx.beginPath()
        ctx.roundRect(
          midX - bgWidth / 2,
          midY - bgHeight / 2,
          bgWidth,
          bgHeight,
          bgHeight / 2
        )
        ctx.fill()

        // Border in edge color
        ctx.strokeStyle = edgeColor + "60"
        ctx.lineWidth = 1
        ctx.stroke()

        // Text with better color
        ctx.fillStyle = "#f1f5f9"
        ctx.fillText(confText, midX, midY)
      }

      ctx.restore()
    },
    [selectedId, matchingIds]
  )

  const nodePointerAreaPaint = React.useCallback(
    (node: object, color: string, ctx: CanvasRenderingContext2D) => {
      const n = node as FGNode
      const x = n.x ?? 0
      const y = n.y ?? 0
      // Match compact card dimensions
      const isFailureMode = n.type === "FailureMode"
      const isFixPattern = n.type === "FixPattern"
      const isMinor = n.type === "File" || n.type === "Component"
      const cardWidth = isFailureMode ? 150 : isFixPattern ? 145 : isMinor ? 120 : 135
      const cardHeight = isFailureMode ? 52 : isFixPattern ? 50 : isMinor ? 42 : 48
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.rect(x - cardWidth / 2, y - cardHeight / 2, cardWidth, cardHeight)
      ctx.fill()
    },
    []
  )

  if (dim.w === 0 || dim.h === 0) {
    return <div ref={containerRef} className="h-full w-full min-h-[320px]" />
  }

  return (
    <div ref={containerRef} className="h-full w-full min-h-[320px] rounded-lg overflow-hidden">
      <ForceGraph2D
        ref={fgRef}
        width={dim.w}
        height={dim.h}
        graphData={graphData}
        backgroundColor="#0a0e1a"
        dagMode={dagMode ?? undefined}
        dagLevelDistance={layout === "dagRadial" ? 150 : 120}
        warmupTicks={50}
        cooldownTicks={200}
        cooldownTime={5000}
        d3VelocityDecay={0.2}
        d3AlphaDecay={0.01}
        nodeId="id"
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={nodePointerAreaPaint}
        linkSource="source"
        linkTarget="target"
        linkCanvasObject={linkCanvasObject}
        linkDirectionalArrowLength={0}
        onNodeClick={(node) => onSelectNode((node as FGNode).id)}
        onNodeHover={(node) => onHoverNode(node ? (node as FGNode).id : "")}
        onBackgroundClick={() => onSelectNode("")}
        onEngineStop={() => {
          if (autoFitDone.current) return
          autoFitDone.current = true
          requestAnimationFrame(() => {
            fgRef.current?.zoomToFit(500, 100)
          })
        }}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        minZoom={0.1}
        maxZoom={8}
      />
    </div>
  )
}

// Shape drawing helpers
function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const w = r * 2
  const h = r * 1.6
  const radius = r * 0.3
  ctx.beginPath()
  ctx.roundRect(x - w / 2, y - h / 2, w, h, radius)
}

function drawHexagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2
    const px = x + r * Math.cos(angle)
    const py = y + r * Math.sin(angle)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x, y - r)
  ctx.lineTo(x + r * 0.9, y)
  ctx.lineTo(x, y + r)
  ctx.lineTo(x - r * 0.9, y)
  ctx.closePath()
}

function drawPill(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const w = r * 2.2
  const h = r * 1.4
  ctx.beginPath()
  ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2)
}

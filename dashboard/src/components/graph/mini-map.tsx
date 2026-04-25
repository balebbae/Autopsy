"use client"

import * as React from "react"
import type { ForceGraphMethods } from "react-force-graph-2d"
import { Card } from "@/components/ui/card"

type NodeData = { id: string; x?: number; y?: number; type: string }

type MiniMapProps = {
  fgRef: React.MutableRefObject<ForceGraphMethods | undefined>
  positionedNodesRef: React.MutableRefObject<NodeData[]>
  width?: number
  height?: number
}

const TYPE_COLORS: Record<string, string> = {
  FailureMode: "#ef4444",
  FixPattern: "#34d399",
  Symptom: "#fb923c",
  Run: "#38bdf8",
  Task: "#a78bfa",
  File: "#64748b",
  Component: "#fbbf24",
  Outcome: "#94a3b8",
  ChangePattern: "#f472b6",
}

export function MiniMap({
  fgRef,
  positionedNodesRef,
  width = 160,
  height = 100,
}: MiniMapProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0)

  // Force re-render every 200ms to update positions
  React.useEffect(() => {
    const interval = setInterval(() => forceUpdate(), 200)
    return () => clearInterval(interval)
  }, [])

  // Draw the mini-map
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Clear with dark background
    ctx.fillStyle = "#0f172a"
    ctx.fillRect(0, 0, width, height)

    const nodes = positionedNodesRef.current || []
    const positionedNodes = nodes.filter(
      (n) => n.x !== undefined && n.y !== undefined && isFinite(n.x) && isFinite(n.y)
    )

    if (positionedNodes.length === 0) {
      // Show "loading" indicator
      ctx.fillStyle = "#475569"
      ctx.font = "10px Inter, system-ui, sans-serif"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("Loading…", width / 2, height / 2)
      return
    }

    // Calculate bounds with padding
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of positionedNodes) {
      if (n.x! < minX) minX = n.x!
      if (n.x! > maxX) maxX = n.x!
      if (n.y! < minY) minY = n.y!
      if (n.y! > maxY) maxY = n.y!
    }

    const padding = 60
    minX -= padding
    maxX += padding
    minY -= padding
    maxY += padding

    const graphW = maxX - minX || 1
    const graphH = maxY - minY || 1
    const scale = Math.min(width / graphW, height / graphH)
    const offsetX = (width - graphW * scale) / 2
    const offsetY = (height - graphH * scale) / 2

    const toMiniX = (x: number) => (x - minX) * scale + offsetX
    const toMiniY = (y: number) => (y - minY) * scale + offsetY

    // Draw nodes as colored dots
    for (const n of positionedNodes) {
      const x = toMiniX(n.x!)
      const y = toMiniY(n.y!)
      ctx.fillStyle = TYPE_COLORS[n.type] || "#64748b"
      ctx.beginPath()
      ctx.arc(x, y, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }

    // Draw viewport rectangle
    const fg = fgRef.current
    if (fg) {
      try {
        const zoom = fg.zoom()
        const center = fg.centerAt() as unknown as { x: number; y: number } | undefined
        if (zoom && center && typeof center.x === "number") {
          // Estimate viewport size in graph coordinates
          const viewW = 1000 / zoom
          const viewH = 700 / zoom

          const vx = toMiniX(center.x - viewW / 2)
          const vy = toMiniY(center.y - viewH / 2)
          const vw = viewW * scale
          const vh = viewH * scale

          ctx.strokeStyle = "#38bdf8"
          ctx.lineWidth = 1.5
          ctx.strokeRect(vx, vy, vw, vh)
        }
      } catch {
        // ignore
      }
    }
  })

  // Click to navigate
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const fg = fgRef.current
    if (!fg) return
    const nodes = positionedNodesRef.current || []
    const positionedNodes = nodes.filter(
      (n) => n.x !== undefined && n.y !== undefined && isFinite(n.x) && isFinite(n.y)
    )
    if (positionedNodes.length === 0) return

    const rect = e.currentTarget.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of positionedNodes) {
      if (n.x! < minX) minX = n.x!
      if (n.x! > maxX) maxX = n.x!
      if (n.y! < minY) minY = n.y!
      if (n.y! > maxY) maxY = n.y!
    }

    const padding = 60
    minX -= padding
    maxX += padding
    minY -= padding
    maxY += padding

    const graphW = maxX - minX || 1
    const graphH = maxY - minY || 1
    const scale = Math.min(width / graphW, height / graphH)
    const offsetX = (width - graphW * scale) / 2
    const offsetY = (height - graphH * scale) / 2

    const graphX = (clickX - offsetX) / scale + minX
    const graphY = (clickY - offsetY) / scale + minY

    fg.centerAt(graphX, graphY, 300)
  }

  return (
    <Card className="p-1.5 bg-card/95 backdrop-blur-md shadow-lg overflow-hidden">
      <div className="text-[9px] font-medium text-muted-foreground px-1 pb-1 flex items-center justify-between">
        <span>Overview</span>
        <span className="text-[8px] opacity-60">Click to navigate</span>
      </div>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onClick={handleClick}
        className="cursor-pointer rounded border border-border/40"
        style={{ width, height }}
      />
    </Card>
  )
}

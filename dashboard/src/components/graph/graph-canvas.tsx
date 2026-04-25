"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import cytoscape, { type Core, type ElementDefinition } from "cytoscape"
import coseBilkent from "cytoscape-cose-bilkent"
import fcose from "cytoscape-fcose"

import type { GraphEdge, GraphNode } from "@/lib/api"
import { NODE_TYPE_STYLE } from "./graph-style"

const CytoscapeComponent = dynamic(() => import("react-cytoscapejs"), { ssr: false })

if (typeof window !== "undefined") {
  // Cytoscape extensions are idempotent on re-register, but still wrap in try.
  try {
    cytoscape.use(coseBilkent as never)
  } catch {
    /* already registered */
  }
  try {
    cytoscape.use(fcose as never)
  } catch {
    /* already registered */
  }
}

export type LayoutKey = "fcose" | "cose-bilkent" | "breadthfirst" | "circle" | "grid"

const LAYOUT_OPTIONS: Record<LayoutKey, Record<string, unknown>> = {
  fcose: {
    name: "fcose",
    animate: true,
    animationDuration: 600,
    randomize: true,
    fit: true,
    padding: 60,
    nodeRepulsion: 6500,
    idealEdgeLength: 90,
    edgeElasticity: 0.45,
    gravity: 0.25,
    numIter: 2500,
    tile: true,
  },
  "cose-bilkent": {
    name: "cose-bilkent",
    animate: "end",
    animationDuration: 600,
    fit: true,
    padding: 60,
    nodeRepulsion: 9000,
    idealEdgeLength: 120,
    edgeElasticity: 0.45,
    nestingFactor: 0.1,
    gravity: 0.25,
    numIter: 2500,
    tile: true,
  },
  breadthfirst: {
    name: "breadthfirst",
    animate: true,
    animationDuration: 500,
    fit: true,
    padding: 50,
    spacingFactor: 1.2,
    directed: true,
  },
  circle: {
    name: "circle",
    animate: true,
    animationDuration: 500,
    fit: true,
    padding: 50,
  },
  grid: {
    name: "grid",
    animate: true,
    animationDuration: 500,
    fit: true,
    padding: 30,
  },
}

export const ALL_LAYOUTS: LayoutKey[] = [
  "fcose",
  "cose-bilkent",
  "breadthfirst",
  "circle",
  "grid",
]

const NODE_STYLE_RULES = Object.entries(NODE_TYPE_STYLE).map(([type, v]) => ({
  selector: `node[type="${type}"]`,
  style: {
    "background-color": v.color,
    shape: v.shape,
    "text-outline-color": "#020617",
    "text-outline-width": 2,
    color: "#f8fafc",
  } as Record<string, unknown>,
}))

const STYLESHEET: cytoscape.Stylesheet[] = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      "text-valign": "center",
      "text-halign": "center",
      "font-size": 11,
      "font-family": "var(--font-geist-sans), Inter, sans-serif",
      "font-weight": 500,
      "text-wrap": "wrap",
      "text-max-width": "120px",
      width: "label",
      height: "label",
      padding: "10px",
      "border-width": 1,
      "border-color": "rgba(255,255,255,0.18)",
      color: "#f8fafc",
      "background-color": "#64748b",
      "transition-property": "background-color, border-color, border-width",
      "transition-duration": 150,
    },
  },
  ...(NODE_STYLE_RULES as cytoscape.Stylesheet[]),
  {
    selector: "edge",
    style: {
      width: "data(weight)",
      "line-color": "rgba(148, 163, 184, 0.45)",
      "target-arrow-color": "rgba(148, 163, 184, 0.65)",
      "target-arrow-shape": "triangle-backcurve",
      "curve-style": "bezier",
      "arrow-scale": 0.9,
      label: "data(label)",
      "font-size": 9,
      "text-rotation": "autorotate",
      "text-margin-y": -6,
      "text-background-color": "var(--background)",
      "text-background-opacity": 0.7,
      "text-background-padding": "2px",
      color: "rgba(148, 163, 184, 0.85)",
    },
  },
  {
    selector: ":selected",
    style: {
      "border-width": 3,
      "border-color": "#38bdf8",
      "line-color": "#38bdf8",
      "target-arrow-color": "#38bdf8",
    },
  },
  {
    selector: ".dimmed",
    style: {
      opacity: 0.18,
    },
  },
]

export function GraphCanvas({
  nodes,
  edges,
  layout,
  search,
  visibleNodeTypes,
  visibleEdgeTypes,
  onSelectNode,
  onCytoscape,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  layout: LayoutKey
  search: string
  visibleNodeTypes: Set<string>
  visibleEdgeTypes: Set<string>
  onSelectNode: (id: string) => void
  onCytoscape?: (cy: Core) => void
}) {
  const cyRef = React.useRef<Core | null>(null)
  const elements: ElementDefinition[] = React.useMemo(() => {
    const ne: ElementDefinition[] = nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.name,
        type: n.type,
        properties: n.properties ?? {},
      },
    }))
    const ee: ElementDefinition[] = edges.map((e) => ({
      data: {
        id: e.id,
        source: e.source_id,
        target: e.target_id,
        label: e.type,
        type: e.type,
        weight: 1 + (e.confidence ?? 0.5) * 4,
        confidence: e.confidence ?? null,
        evidence_run_id: e.evidence_run_id ?? null,
      },
    }))
    return [...ne, ...ee]
  }, [nodes, edges])

  // Apply filters via display style
  React.useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const visible = visibleNodeTypes.has(n.data("type"))
        n.style("display", visible ? "element" : "none")
      })
      cy.edges().forEach((e) => {
        const visibleType = visibleEdgeTypes.has(e.data("type"))
        const sv = e.source().style("display") !== "none"
        const tv = e.target().style("display") !== "none"
        e.style("display", visibleType && sv && tv ? "element" : "none")
      })
    })
  }, [visibleNodeTypes, visibleEdgeTypes, elements])

  // Search highlight (dim others)
  React.useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const q = search.trim().toLowerCase()
    cy.batch(() => {
      cy.elements().removeClass("dimmed")
      if (!q) return
      const matches = cy
        .nodes()
        .filter(
          (n) =>
            String(n.data("label") ?? "").toLowerCase().includes(q) ||
            String(n.data("type") ?? "").toLowerCase().includes(q) ||
            String(n.data("id") ?? "").toLowerCase().includes(q),
        )
      cy.elements().addClass("dimmed")
      matches.removeClass("dimmed")
      matches.connectedEdges().removeClass("dimmed")
    })
  }, [search])

  // Run layout when elements change or layout choice changes
  React.useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const opts = LAYOUT_OPTIONS[layout]
    cy.layout(opts as never).run()
  }, [elements, layout])

  return (
    <CytoscapeComponent
      elements={elements}
      stylesheet={STYLESHEET}
      style={{ width: "100%", height: "100%" }}
      layout={LAYOUT_OPTIONS[layout] as never}
      cy={(cy: Core) => {
        cyRef.current = cy
        cy.removeAllListeners()
        cy.on("tap", "node", (evt) => {
          onSelectNode(evt.target.id())
        })
        cy.on("tap", (evt) => {
          if (evt.target === cy) onSelectNode("")
        })
        onCytoscape?.(cy)
      }}
      wheelSensitivity={0.2}
      minZoom={0.2}
      maxZoom={2.5}
    />
  )
}

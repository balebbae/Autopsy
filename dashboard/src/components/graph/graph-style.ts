import type { GraphNode } from "@/lib/api"

// Hex colors so cytoscape draws them correctly without resolving CSS vars.
export const NODE_TYPE_STYLE: Record<
  string,
  { color: string; shape: string; textColor: string }
> = {
  Run: { color: "#38bdf8", shape: "round-rectangle", textColor: "#0f172a" },
  Task: { color: "#a78bfa", shape: "round-rectangle", textColor: "#1e1b4b" },
  File: { color: "#94a3b8", shape: "rectangle", textColor: "#0f172a" },
  Component: { color: "#fbbf24", shape: "round-tag", textColor: "#451a03" },
  ChangePattern: { color: "#f472b6", shape: "diamond", textColor: "#500724" },
  Symptom: { color: "#fb923c", shape: "ellipse", textColor: "#431407" },
  FailureMode: { color: "#ef4444", shape: "hexagon", textColor: "#450a0a" },
  FixPattern: { color: "#34d399", shape: "round-octagon", textColor: "#022c22" },
  Outcome: { color: "#64748b", shape: "round-pentagon", textColor: "#f8fafc" },
}

export function nodeStyle(node: GraphNode) {
  return NODE_TYPE_STYLE[node.type] ?? {
    color: "#64748b",
    shape: "ellipse",
    textColor: "#f8fafc",
  }
}

export const NODE_TYPES: string[] = Object.keys(NODE_TYPE_STYLE)

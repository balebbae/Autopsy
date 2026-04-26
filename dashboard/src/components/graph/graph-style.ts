import type { GraphNode } from "@/lib/api"

export type NodeStyleConfig = {
  color: string
  bgColor: string
  borderColor: string
  textColor: string
  icon: string
  shape: "rounded" | "pill" | "hexagon" | "diamond"
}

// Modern color palette with better contrast and visual hierarchy
export const NODE_TYPE_STYLE: Record<string, NodeStyleConfig> = {
  Run: {
    color: "#38bdf8",
    bgColor: "rgba(56, 189, 248, 0.12)",
    borderColor: "rgba(56, 189, 248, 0.5)",
    textColor: "#e0f2fe",
    icon: "play",
    shape: "rounded",
  },
  Task: {
    color: "#a78bfa",
    bgColor: "rgba(167, 139, 250, 0.12)",
    borderColor: "rgba(167, 139, 250, 0.5)",
    textColor: "#ede9fe",
    icon: "clipboard-list",
    shape: "rounded",
  },
  File: {
    color: "#94a3b8",
    bgColor: "rgba(148, 163, 184, 0.12)",
    borderColor: "rgba(148, 163, 184, 0.4)",
    textColor: "#e2e8f0",
    icon: "file-code",
    shape: "rounded",
  },
  Component: {
    color: "#fbbf24",
    bgColor: "rgba(251, 191, 36, 0.12)",
    borderColor: "rgba(251, 191, 36, 0.5)",
    textColor: "#fef3c7",
    icon: "box",
    shape: "rounded",
  },
  ChangePattern: {
    color: "#f472b6",
    bgColor: "rgba(244, 114, 182, 0.12)",
    borderColor: "rgba(244, 114, 182, 0.5)",
    textColor: "#fce7f3",
    icon: "git-branch",
    shape: "rounded",
  },
  Symptom: {
    color: "#fb923c",
    bgColor: "rgba(251, 146, 60, 0.12)",
    borderColor: "rgba(251, 146, 60, 0.5)",
    textColor: "#ffedd5",
    icon: "alert-triangle",
    shape: "rounded",
  },
  FailureMode: {
    color: "#ef4444",
    bgColor: "rgba(239, 68, 68, 0.15)",
    borderColor: "rgba(239, 68, 68, 0.6)",
    textColor: "#fecaca",
    icon: "x-circle",
    shape: "rounded",
  },
  FixPattern: {
    color: "#34d399",
    bgColor: "rgba(52, 211, 153, 0.12)",
    borderColor: "rgba(52, 211, 153, 0.5)",
    textColor: "#d1fae5",
    icon: "check-circle",
    shape: "rounded",
  },
  Outcome: {
    color: "#64748b",
    bgColor: "rgba(100, 116, 139, 0.15)",
    borderColor: "rgba(100, 116, 139, 0.5)",
    textColor: "#e2e8f0",
    icon: "flag",
    shape: "rounded",
  },
}

const DEFAULT_STYLE: NodeStyleConfig = {
  color: "#64748b",
  bgColor: "rgba(100, 116, 139, 0.12)",
  borderColor: "rgba(100, 116, 139, 0.4)",
  textColor: "#e2e8f0",
  icon: "circle",
  shape: "rounded",
}

export function nodeStyle(node: GraphNode): NodeStyleConfig {
  return NODE_TYPE_STYLE[node.type] ?? DEFAULT_STYLE
}

/**
 * Human-readable display label for a node.
 * Run nodes store their task description in `properties.task`; using the
 * raw run_id as the label is unreadable. All other types use `node.name`.
 */
export function nodeDisplayName(node: GraphNode): string {
  if (node.type === "Run") {
    const task = node.properties?.task
    if (typeof task === "string" && task.trim()) return task
  }
  return node.name
}

export const NODE_TYPES: string[] = Object.keys(NODE_TYPE_STYLE)

// Edge type styling. Vocabulary mirrors service/src/aag/graph/writer.py —
// keep these in sync when the writer adds or renames an edge type.
export const EDGE_TYPE_STYLE: Record<
  string,
  { color: string; dashed: boolean; label: string }
> = {
  ATTEMPTED: { color: "#38bdf8", dashed: false, label: "attempted" },
  TOUCHED: { color: "#a78bfa", dashed: false, label: "touched" },
  BELONGS_TO: { color: "#94a3b8", dashed: true, label: "belongs to" },
  HAD_CHANGE_PATTERN: { color: "#f472b6", dashed: false, label: "had change" },
  EMITTED_SYMPTOM: { color: "#fb923c", dashed: false, label: "emitted" },
  INDICATES: { color: "#ef4444", dashed: false, label: "indicates" },
  RESOLVED_BY: { color: "#34d399", dashed: false, label: "resolved by" },
  RESULTED_IN: { color: "#64748b", dashed: false, label: "resulted in" },
}

export const EDGE_TYPES: string[] = Object.keys(EDGE_TYPE_STYLE)

export function edgeStyle(type: string) {
  return (
    EDGE_TYPE_STYLE[type] ?? {
      color: "#475569",
      dashed: false,
      label: type.toLowerCase().replace(/_/g, " "),
    }
  )
}

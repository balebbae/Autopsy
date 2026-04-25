"use client"

import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import type { GraphNode } from "@/lib/api"
import { nodeStyle } from "./graph-style"

const EDGE_TYPES = [
  { value: "INDICATES", label: "Indicates", description: "Symptom indicates a failure mode", color: "#ef4444" },
  { value: "FIXED_BY", label: "Fixed By", description: "Failure is fixed by this pattern", color: "#34d399" },
  { value: "EXHIBITED", label: "Exhibited", description: "Run exhibited this symptom", color: "#fb923c" },
  { value: "PART_OF", label: "Part Of", description: "File is part of component", color: "#94a3b8" },
  { value: "EXECUTED", label: "Executed", description: "Run executed this task", color: "#38bdf8" },
  { value: "EDITED", label: "Edited", description: "Run edited this file", color: "#a78bfa" },
  { value: "MATCHED", label: "Matched", description: "Run matched this pattern", color: "#f472b6" },
  { value: "TYPE_OF", label: "Type Of", description: "Task is type of change pattern", color: "#fbbf24" },
  { value: "RESULTED_IN", label: "Resulted In", description: "Run resulted in outcome", color: "#64748b" },
]

type EdgeCreateModalProps = {
  open: boolean
  onClose: () => void
  sourceNode: GraphNode | null
  targetNode: GraphNode | null
  onSubmit: (edgeType: string, confidence: number) => void
}

export function EdgeCreateModal({
  open,
  onClose,
  sourceNode,
  targetNode,
  onSubmit,
}: EdgeCreateModalProps) {
  const [edgeType, setEdgeType] = React.useState<string>("INDICATES")
  const [confidence, setConfidence] = React.useState<number>(80)

  const sourceStyle = sourceNode ? nodeStyle(sourceNode) : null
  const targetStyle = targetNode ? nodeStyle(targetNode) : null

  const handleSubmit = () => {
    onSubmit(edgeType, confidence / 100)
    onClose()
    setEdgeType("INDICATES")
    setConfidence(80)
  }

  const selectedEdgeType = EDGE_TYPES.find((e) => e.value === edgeType)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Connection</DialogTitle>
          <DialogDescription>
            Add a new relationship between these nodes
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Source → Target visualization */}
          <div className="flex items-center justify-center gap-3">
            {sourceNode && sourceStyle && (
              <div
                className="px-3 py-2 rounded-md border-l-4 bg-muted/50"
                style={{ borderLeftColor: sourceStyle.color }}
              >
                <p className="text-xs text-muted-foreground">{sourceNode.type}</p>
                <p className="text-sm font-medium truncate max-w-[120px]">
                  {sourceNode.name}
                </p>
              </div>
            )}
            
            <div className="flex flex-col items-center">
              <div
                className="w-12 h-0.5 rounded"
                style={{ backgroundColor: selectedEdgeType?.color || "#475569" }}
              />
              <span className="text-[10px] text-muted-foreground mt-1">
                {selectedEdgeType?.label}
              </span>
            </div>

            {targetNode && targetStyle && (
              <div
                className="px-3 py-2 rounded-md border-l-4 bg-muted/50"
                style={{ borderLeftColor: targetStyle.color }}
              >
                <p className="text-xs text-muted-foreground">{targetNode.type}</p>
                <p className="text-sm font-medium truncate max-w-[120px]">
                  {targetNode.name}
                </p>
              </div>
            )}
          </div>

          {/* Edge Type */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Relationship Type</label>
            <Select value={edgeType} onValueChange={setEdgeType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDGE_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: type.color }}
                      />
                      <span>{type.label}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedEdgeType && (
              <p className="text-xs text-muted-foreground">
                {selectedEdgeType.description}
              </p>
            )}
          </div>

          {/* Confidence */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Confidence</label>
              <Badge variant="secondary" className="font-mono">
                {confidence}%
              </Badge>
            </div>
            <div className="flex items-center gap-3">
              <Input
                type="range"
                min={10}
                max={100}
                step={5}
                value={confidence}
                onChange={(e) => setConfidence(Number(e.target.value))}
                className="flex-1 h-2 cursor-pointer"
              />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Low</span>
              <span>High</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit}>
            Create Connection
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

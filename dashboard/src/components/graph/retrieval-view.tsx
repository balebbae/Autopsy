"use client"

import * as React from "react"
import { Loader2, Search, Sparkles } from "lucide-react"

import {
  postPreflightTrace,
  type PreflightTraceResponse,
  type TraceEdge,
  type TraceAggregatedNode,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/primitives/empty-state"
import { cn } from "@/lib/utils"

type Props = {
  // Optional initial task — usually wired from the URL (?task=...).
  initialTask?: string
  onTaskChange?: (task: string) => void
}

export function RetrievalView({ initialTask = "", onTaskChange }: Props) {
  const [taskInput, setTaskInput] = React.useState(initialTask)
  const [submittedTask, setSubmittedTask] = React.useState<string>(initialTask)
  const [data, setData] = React.useState<PreflightTraceResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Re-sync if parent passes a different initialTask (e.g. URL changed).
  React.useEffect(() => {
    setTaskInput(initialTask)
    setSubmittedTask(initialTask)
  }, [initialTask])

  // Fetch trace whenever the submitted task changes.
  React.useEffect(() => {
    if (!submittedTask.trim()) {
      setData(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    postPreflightTrace({ task: submittedTask })
      .then((r) => {
        if (cancelled) return
        if (!r) {
          setError("Service unavailable or returned no data.")
          setData(null)
        } else {
          setData(r)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [submittedTask])

  const submit = () => {
    const t = taskInput.trim()
    setSubmittedTask(t)
    onTaskChange?.(t)
  }

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-hidden p-4">
      <header className="px-2">
        <h2 className="text-sm font-semibold tracking-tight">
          Retrieval · trace a preflight through Graph RAG
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Type the task the agent is about to start. The pipeline runs end-to-end:
          vector ANN over similar runs → typed graph traversal with confidence
          decay → aggregation + system addendum.
        </p>
      </header>

      <Card className="flex items-center gap-2 px-3 py-2">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" />
        <Input
          value={taskInput}
          onChange={(e) => setTaskInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
          }}
          placeholder="e.g. add a priority field to Task (low / medium / high)"
          className="h-9 border-0 shadow-none focus-visible:ring-0 px-0"
        />
        <Button onClick={submit} disabled={loading} size="sm" className="shrink-0">
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Tracing…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" /> Trace
            </>
          )}
        </Button>
      </Card>

      <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-border bg-card/40">
        {error ? (
          <div className="grid h-full place-items-center p-6">
            <EmptyState
              Icon={Search}
              title="Trace failed"
              description={error}
            />
          </div>
        ) : !submittedTask.trim() ? (
          <div className="grid h-full place-items-center p-6">
            <EmptyState
              Icon={Search}
              title="Enter a task to trace the pipeline"
              description="Each call re-runs the full Graph RAG pipeline against the live vector store and graph edges. Nothing is persisted."
            />
          </div>
        ) : loading && !data ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Embedding + walking
              the graph…
            </div>
          </div>
        ) : data ? (
          <TraceContent data={data} />
        ) : null}
      </div>
    </div>
  )
}

function TraceContent({ data }: { data: PreflightTraceResponse }) {
  const { trace, response } = data
  return (
    <div className="flex flex-col gap-6 p-5">
      <PipelineMeta trace={trace} response={response} />
      <Stage
        index={1}
        title="Vector ANN candidates"
        subtitle={`${trace.candidates.length} runs scanned · top ${trace.candidates.filter((c) => c.in_threshold).length} cleared the cosine-distance threshold (${trace.similarity_threshold.toFixed(2)})`}
      >
        <CandidatesStrip data={data} />
      </Stage>
      <Stage
        index={2}
        title="Typed graph traversal"
        subtitle={`${trace.edges.length} edge${trace.edges.length === 1 ? "" : "s"} visited from ${trace.rejected_roots.length} rejected root${trace.rejected_roots.length === 1 ? "" : "s"} · max depth ${trace.max_hop_depth} · half-life ${trace.half_life_days.toFixed(0)}d`}
      >
        <GraphTraversal trace={trace} />
      </Stage>
      <Stage
        index={3}
        title="Aggregation + system addendum"
        subtitle={`${trace.aggregated.length} unique nodes scored · dampening factor ${trace.dampening_factor.toFixed(3)} (${trace.approved_count} approved similar run${trace.approved_count === 1 ? "" : "s"})`}
      >
        <AggregationPanel data={data} />
      </Stage>
    </div>
  )
}

function PipelineMeta({
  trace,
  response,
}: {
  trace: PreflightTraceResponse["trace"]
  response: PreflightTraceResponse["response"]
}) {
  const items: Array<[string, React.ReactNode]> = [
    ["risk", <RiskPill key="r" level={response.risk_level} />],
    ["embedder", `${trace.embed_provider} · ${trace.vector_dim}d`],
    ["sim threshold", trace.similarity_threshold.toFixed(2)],
    ["half-life", `${trace.half_life_days.toFixed(0)}d`],
    ["counter w", trace.counter_weight.toFixed(2)],
    ["max hops", String(trace.max_hop_depth)],
    ["addendum", trace.addendum_source],
  ]
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-md border border-border/60 bg-muted/30 px-4 py-2.5 text-[11px]">
      {items.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <span className="text-muted-foreground/80 uppercase tracking-wider">
            {k}
          </span>
          <span className="font-medium tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  )
}

function RiskPill({
  level,
}: {
  level: "none" | "low" | "medium" | "high"
}) {
  const tone =
    level === "high"
      ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
      : level === "medium"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
        : level === "low"
          ? "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30"
          : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        tone,
      )}
    >
      {level}
    </span>
  )
}

function Stage({
  index,
  title,
  subtitle,
  children,
}: {
  index: number
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-primary text-[11px] font-bold tabular-nums">
          {index}
        </span>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {subtitle ? (
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function CandidatesStrip({ data }: { data: PreflightTraceResponse }) {
  const { trace } = data
  if (trace.candidates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        No similar runs in pgvector.
      </p>
    )
  }
  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      {trace.candidates.map((c) => {
        const isRoot = trace.rejected_roots.includes(c.run_id)
        // Distance bar: 0 = full bar, threshold = empty bar.
        const pct = Math.max(
          0,
          Math.min(1, 1 - c.distance / trace.similarity_threshold),
        )
        // Color by retrieval BUCKET, not raw status, so an active run
        // mid-recovery (status='active' + rejection_count>0 → bucket=
        // 'failure') still renders as a failure candidate. Older trace
        // payloads without `bucket` fall back to status, preserving the
        // original behavior for runs analyzed before the schema bump.
        const isFailure = c.bucket
          ? c.bucket === "failure"
          : c.status === "rejected"
        const tone = isFailure
          ? "border-rose-500/40 bg-rose-500/5"
          : "border-emerald-500/40 bg-emerald-500/5"
        const dimmed = !c.in_threshold ? "opacity-40" : ""
        return (
          <Card
            key={c.run_id}
            className={cn(
              "flex-shrink-0 w-44 border p-3 flex flex-col gap-2 text-[11px]",
              tone,
              dimmed,
            )}
          >
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "text-[9px] uppercase tracking-wider px-1.5 py-0",
                  isFailure
                    ? "border-rose-500/50 text-rose-600 dark:text-rose-400"
                    : "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
                )}
                // Surface the raw status on hover so users can tell an
                // explicitly-rejected run from an active-with-rejections one.
                title={c.bucket ? `${c.status} (bucket: ${c.bucket})` : c.status}
              >
                {c.status}
              </Badge>
              {isRoot ? (
                <Badge
                  variant="outline"
                  className="text-[9px] uppercase tracking-wider px-1.5 py-0 border-primary/50 text-primary"
                >
                  root
                </Badge>
              ) : null}
            </div>
            <div className="font-mono text-[10px] truncate" title={c.run_id}>
              {c.run_id.slice(0, 18)}
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>distance</span>
                <span className="tabular-nums">{c.distance.toFixed(3)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted-foreground/10 overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full",
                    isFailure ? "bg-rose-500/70" : "bg-emerald-500/70",
                  )}
                  style={{ width: `${pct * 100}%` }}
                />
              </div>
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{c.project ?? "—"}</span>
              <span className="tabular-nums">{c.age_days.toFixed(0)}d</span>
            </div>
          </Card>
        )
      })}
    </div>
  )
}

function GraphTraversal({
  trace,
}: {
  trace: PreflightTraceResponse["trace"]
}) {
  if (trace.edges.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Graph stage skipped — no rejected ANN candidates passed the threshold.
      </p>
    )
  }
  // Group edges by depth so we can render columns 1 → max_hop_depth.
  const byDepth = new Map<number, TraceEdge[]>()
  for (const e of trace.edges) {
    const arr = byDepth.get(e.depth) ?? []
    arr.push(e)
    byDepth.set(e.depth, arr)
  }
  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b)
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {depths.map((d) => {
        const edges = byDepth.get(d) ?? []
        // Group by target_type for visual chunking.
        const byTargetType = new Map<string, TraceEdge[]>()
        for (const e of edges) {
          const arr = byTargetType.get(e.target_type) ?? []
          arr.push(e)
          byTargetType.set(e.target_type, arr)
        }
        return (
          <div key={d} className="flex-shrink-0 w-72 flex flex-col gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              hop {d} · {edges.length} edge{edges.length === 1 ? "" : "s"}
            </div>
            {Array.from(byTargetType.entries()).map(([type, group]) => (
              <Card key={type} className="border p-2 flex flex-col gap-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {type}
                </div>
                {group.slice(0, 6).map((e) => (
                  <EdgeRow key={`${e.source_id}->${e.target_id}-${e.depth}`} edge={e} />
                ))}
                {group.length > 6 ? (
                  <div className="text-[10px] text-muted-foreground italic">
                    +{group.length - 6} more…
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function EdgeRow({ edge }: { edge: TraceEdge }) {
  // Confidence bars: raw vs decayed. Decayed is always ≤ raw.
  const rawPct = Math.max(0, Math.min(1, edge.confidence))
  const decayedPct = Math.max(0, Math.min(1, edge.decayed_confidence))
  return (
    <div className="text-[11px] flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="font-medium truncate pr-2" title={edge.target_name}>
          {edge.target_name}
        </span>
        <span className="text-[9px] text-muted-foreground tabular-nums shrink-0">
          {edge.edge_type.toLowerCase()}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1 rounded-full bg-muted-foreground/10 overflow-hidden">
          <div
            className="h-full bg-muted-foreground/40"
            style={{ width: `${rawPct * 100}%` }}
          />
        </div>
        <span className="text-[9px] text-muted-foreground tabular-nums w-8 text-right">
          {edge.confidence.toFixed(2)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1 rounded-full bg-muted-foreground/10 overflow-hidden">
          <div
            className="h-full bg-primary/70"
            style={{ width: `${decayedPct * 100}%` }}
          />
        </div>
        <span className="text-[9px] text-primary/80 tabular-nums w-8 text-right">
          {edge.decayed_confidence.toFixed(2)}
        </span>
      </div>
    </div>
  )
}

function AggregationPanel({ data }: { data: PreflightTraceResponse }) {
  const { trace, response } = data
  const groups = ["FailureMode", "FixPattern", "ChangePattern"] as const
  const aggByType = new Map<string, TraceAggregatedNode[]>()
  for (const a of trace.aggregated) {
    const arr = aggByType.get(a.type) ?? []
    arr.push(a)
    aggByType.set(a.type, arr)
  }
  for (const g of groups) {
    const arr = aggByType.get(g) ?? []
    arr.sort((a, b) => b.final_score - a.final_score)
    aggByType.set(g, arr)
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div className="flex flex-col gap-3">
        {groups.map((g) => {
          const items = aggByType.get(g) ?? []
          if (items.length === 0) return null
          return (
            <Card key={g} className="border p-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider">
                  {g}
                </h4>
                <span className="text-[10px] text-muted-foreground">
                  {items.length} scored
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {items.slice(0, 8).map((a) => (
                  <AggRow key={a.name} node={a} />
                ))}
              </div>
            </Card>
          )
        })}
      </div>
      <Card className="border p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 mb-1">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider">
            System addendum
          </h4>
          <Badge variant="outline" className="text-[9px] px-1.5 py-0">
            {trace.addendum_source}
          </Badge>
        </div>
        {response.system_addendum ? (
          <pre className="text-[11px] leading-relaxed whitespace-pre-wrap font-mono bg-muted/30 rounded-md p-3 border border-border/40">
            {response.system_addendum}
          </pre>
        ) : (
          <p className="text-[11px] italic text-muted-foreground">
            No addendum — risk level is {response.risk_level} so the agent's
            system prompt is not augmented.
          </p>
        )}
        {response.reason ? (
          <div className="text-[11px] text-muted-foreground">
            <span className="font-semibold">Reason:</span> {response.reason}
          </div>
        ) : null}
      </Card>
    </div>
  )
}

function AggRow({ node }: { node: TraceAggregatedNode }) {
  const finalPct = Math.max(0, Math.min(1, node.final_score / 5))
  const dampened = node.final_score < node.raw_score - 1e-6
  return (
    <div className="text-[11px] flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="font-medium truncate pr-2" title={node.name}>
          {node.name}
        </span>
        <div className="flex items-center gap-2 shrink-0 text-[10px] tabular-nums">
          <span className="text-muted-foreground">×{node.freq}</span>
          {dampened ? (
            <span className="text-muted-foreground/80 line-through">
              {node.raw_score.toFixed(2)}
            </span>
          ) : null}
          <span className="font-semibold">{node.final_score.toFixed(2)}</span>
        </div>
      </div>
      <div className="h-1 rounded-full bg-muted-foreground/10 overflow-hidden">
        <div
          className="h-full bg-primary/70"
          style={{ width: `${finalPct * 100}%` }}
        />
      </div>
    </div>
  )
}

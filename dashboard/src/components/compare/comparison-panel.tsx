"use client"

import * as React from "react"
import useSWR from "swr"
import {
  ArrowRight,
  Loader2,
  AlertTriangle,
  ShieldCheck,
  Sparkles,
} from "lucide-react"

import {
  apiBaseUrl,
  type Run,
  type RunSummary,
  type PreflightResponse,
} from "@/lib/api"
import { cn, shortId } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { SectionCard } from "@/components/primitives/section-card"
import { EmptyState } from "@/components/primitives/empty-state"
import { StatusPill } from "@/components/primitives/status-pill"
import { RunSummaryCard } from "./run-summary-card"

const jsonFetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" })
  if (!r.ok) throw new Error("not ok")
  return r.json()
}

export function ComparisonPanel({ runs }: { runs: RunSummary[] }) {
  const rejectedRuns = React.useMemo(
    () => runs.filter((r) => r.status === "rejected"),
    [runs],
  )
  const approvedRuns = React.useMemo(
    () => runs.filter((r) => r.status === "approved"),
    [runs],
  )

  const [beforeId, setBeforeId] = React.useState<string>("")
  const [afterId, setAfterId] = React.useState<string>("")

  React.useEffect(() => {
    if (!beforeId && rejectedRuns.length > 0) setBeforeId(rejectedRuns[0].run_id)
    if (!afterId && approvedRuns.length > 0) setAfterId(approvedRuns[0].run_id)
  }, [rejectedRuns, approvedRuns, beforeId, afterId])

  const { data: beforeRun, isLoading: loadingBefore } = useSWR<Run>(
    beforeId ? `${apiBaseUrl}/v1/runs/${beforeId}` : null,
    jsonFetcher,
  )
  const { data: afterRun, isLoading: loadingAfter } = useSWR<Run>(
    afterId ? `${apiBaseUrl}/v1/runs/${afterId}` : null,
    jsonFetcher,
  )

  const { data: preflight, isLoading: loadingPreflight } = useSWR<PreflightResponse>(
    afterRun?.task
      ? [`${apiBaseUrl}/v1/preflight`, afterRun.task]
      : null,
    async ([url, task]: [string, string]) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task }),
        cache: "no-store",
      })
      if (!r.ok) return null
      return r.json()
    },
  )

  if (runs.length === 0) {
    return (
      <EmptyState
        Icon={Sparkles}
        title="No runs yet"
        description="Ingest some agent runs to compare before-and-after outcomes."
        className="py-20"
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* Run selectors */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-end">
        <RunSelector
          label="Before (failed run)"
          runs={rejectedRuns}
          allRuns={runs}
          value={beforeId}
          onChange={setBeforeId}
          accent="red"
        />
        <div className="hidden md:flex items-center justify-center pt-6">
          <div className="h-10 w-10 rounded-full bg-muted grid place-items-center">
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
        <RunSelector
          label="After (successful retry)"
          runs={approvedRuns}
          allRuns={runs}
          value={afterId}
          onChange={setAfterId}
          accent="green"
        />
      </div>

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-0 lg:gap-0">
        {/* Before panel */}
        <div className="min-w-0">
          {loadingBefore ? (
            <LoadingCard />
          ) : beforeRun ? (
            <RunSummaryCard run={beforeRun} variant="before" />
          ) : beforeId ? (
            <EmptyState title="Run not found" className="py-10" />
          ) : (
            <EmptyState
              title="Select a run"
              description="Choose a rejected run from the dropdown above."
              className="py-10"
            />
          )}
        </div>

        {/* Center divider */}
        <div className="hidden lg:flex flex-col items-center justify-center px-4">
          <div className="w-px flex-1 bg-gradient-to-b from-red-500/20 via-border to-green-500/20" />
          <div className="my-3 flex flex-col items-center gap-1">
            <div className="h-8 w-8 rounded-full bg-primary/10 grid place-items-center">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium whitespace-nowrap">
              Autopsy learned
            </span>
          </div>
          <div className="w-px flex-1 bg-gradient-to-b from-green-500/20 via-border to-green-500/20" />
        </div>

        {/* Mobile divider */}
        <div className="flex lg:hidden items-center justify-center py-4">
          <div className="h-px flex-1 bg-gradient-to-r from-red-500/20 via-border to-green-500/20" />
          <div className="mx-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium whitespace-nowrap">
              Autopsy learned
            </span>
          </div>
          <div className="h-px flex-1 bg-gradient-to-r from-green-500/20 via-border to-green-500/20" />
        </div>

        {/* After panel */}
        <div className="min-w-0">
          {loadingAfter ? (
            <LoadingCard />
          ) : afterRun ? (
            <RunSummaryCard run={afterRun} variant="after" />
          ) : afterId ? (
            <EmptyState title="Run not found" className="py-10" />
          ) : (
            <EmptyState
              title="Select a run"
              description="Choose an approved run from the dropdown above."
              className="py-10"
            />
          )}
        </div>
      </div>

      {/* Preflight warning card */}
      {afterRun?.task ? (
        <PreflightCard
          preflight={preflight ?? null}
          loading={loadingPreflight}
          task={afterRun.task}
        />
      ) : null}
    </div>
  )
}

function RunSelector({
  label,
  runs,
  allRuns,
  value,
  onChange,
  accent,
}: {
  label: string
  runs: RunSummary[]
  allRuns: RunSummary[]
  value: string
  onChange: (v: string) => void
  accent: "red" | "green"
}) {
  const displayRuns = runs.length > 0 ? runs : allRuns
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          className={cn(
            "w-full",
            accent === "red"
              ? "border-red-500/30 focus:ring-red-500/30"
              : "border-green-500/30 focus:ring-green-500/30",
          )}
        >
          <SelectValue placeholder="Select a run..." />
        </SelectTrigger>
        <SelectContent>
          {displayRuns.map((r) => (
            <SelectItem key={r.run_id} value={r.run_id}>
              <div className="flex items-center gap-2">
                <StatusPill status={r.status} className="scale-90" withIcon={false} />
                <span className="font-mono text-xs">{shortId(r.run_id)}</span>
                {r.task ? (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {r.task}
                  </span>
                ) : null}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function PreflightCard({
  preflight,
  loading,
  task,
}: {
  preflight: PreflightResponse | null
  loading: boolean
  task: string
}) {
  const riskColors: Record<string, string> = {
    none: "border-muted",
    low: "border-sky-500/30 bg-sky-500/5",
    medium: "border-amber-500/30 bg-amber-500/5",
    high: "border-red-500/30 bg-red-500/5",
  }

  return (
    <SectionCard
      title="Preflight Warning"
      description="What Autopsy would warn the agent before retrying this task"
    >
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : preflight ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <RiskBadge level={preflight.risk_level} />
            {preflight.block ? (
              <Badge variant="destructive" className="text-xs">
                Would block
              </Badge>
            ) : null}
          </div>

          {preflight.reason ? (
            <p className="text-sm">{preflight.reason}</p>
          ) : null}

          {preflight.missing_followups && preflight.missing_followups.length > 0 ? (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Missing follow-ups
              </p>
              <ul className="space-y-1">
                {preflight.missing_followups.map((f, i) => (
                  <li key={i} className="text-sm flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preflight.recommended_checks && preflight.recommended_checks.length > 0 ? (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Recommended checks
              </p>
              <ul className="space-y-1">
                {preflight.recommended_checks.map((c, i) => (
                  <li key={i} className="text-sm flex items-start gap-2">
                    <ShieldCheck className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preflight.system_addendum ? (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                System addendum
              </p>
              <Card className="p-3 bg-muted/30 text-xs font-mono whitespace-pre-wrap leading-relaxed">
                {preflight.system_addendum}
              </Card>
            </div>
          ) : null}

          {preflight.similar_runs && preflight.similar_runs.length > 0 ? (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Similar past runs
              </p>
              <div className="flex flex-wrap gap-1.5">
                {preflight.similar_runs.map((id) => (
                  <Badge key={id} variant="muted" className="font-mono text-[10px]">
                    {shortId(id)}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground py-4">
          Could not retrieve preflight data for this task.
        </p>
      )}
    </SectionCard>
  )
}

function RiskBadge({ level }: { level: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    none: { cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30", label: "No Risk" },
    low: { cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30", label: "Low Risk" },
    medium: { cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30", label: "Medium Risk" },
    high: { cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30", label: "High Risk" },
  }
  const meta = map[level] ?? map["none"]!
  return (
    <Badge variant="outline" className={cn("font-medium gap-1 px-2.5 py-1", meta.cls)}>
      <ShieldCheck className="h-3.5 w-3.5" />
      {meta.label}
    </Badge>
  )
}

function LoadingCard() {
  return (
    <Card className="flex flex-col items-center justify-center py-16 bg-muted/10">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <p className="mt-2 text-sm text-muted-foreground">Loading run...</p>
    </Card>
  )
}

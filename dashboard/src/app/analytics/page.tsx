"use client"

import * as React from "react"
import useSWR from "swr"
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Layers,
  XCircle,
} from "lucide-react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts"

import {
  apiBaseUrl,
  type FailureCase,
  type Run,
  type RunSummary,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { KpiCard } from "@/components/primitives/kpi-card"
import { SectionCard } from "@/components/primitives/section-card"
import { Skeleton } from "@/components/ui/skeleton"

const PIE_COLORS = [
  "var(--destructive)",
  "var(--primary)",
  "var(--warning)",
  "var(--success)",
  "var(--muted-foreground)",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
]

const listFetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" })
  if (!r.ok) throw new Error("not ok")
  return (await r.json()) as RunSummary[]
}

async function fetchRunDetail(runId: string): Promise<Run | null> {
  try {
    const r = await fetch(`${apiBaseUrl}/v1/runs/${runId}`, { cache: "no-store" })
    if (!r.ok) return null
    return (await r.json()) as Run
  } catch {
    return null
  }
}

export default function AnalyticsPage() {
  const { data: runs, isLoading } = useSWR<RunSummary[]>(
    `${apiBaseUrl}/v1/runs`,
    listFetcher,
    { revalidateOnFocus: false },
  )

  const [failureCases, setFailureCases] = React.useState<
    Map<string, FailureCase>
  >(new Map())
  const [detailsLoading, setDetailsLoading] = React.useState(false)

  React.useEffect(() => {
    if (!runs) return
    const rejected = runs
      .filter((r) => r.status === "rejected")
      .slice(0, 20)

    if (rejected.length === 0) return
    setDetailsLoading(true)

    Promise.all(rejected.map((r) => fetchRunDetail(r.run_id))).then(
      (details) => {
        const map = new Map<string, FailureCase>()
        details.forEach((d) => {
          if (d?.failure_case) map.set(d.run_id, d.failure_case)
        })
        setFailureCases(map)
        setDetailsLoading(false)
      },
    )
  }, [runs])

  const allRuns = runs ?? []

  const stats = React.useMemo(() => {
    const total = allRuns.length
    const rejected = allRuns.filter((r) => r.status === "rejected").length
    const approved = allRuns.filter((r) => r.status === "approved").length
    const rejectionRate = total ? (rejected / total) * 100 : 0
    return { total, rejected, approved, rejectionRate }
  }, [allRuns])

  const timeSeriesData = React.useMemo(() => buildTimeSeries(allRuns), [allRuns])

  const failureModeData = React.useMemo(() => {
    const counts = new Map<string, number>()
    failureCases.forEach((fc) => {
      const mode = fc.failure_mode || "unknown"
      counts.set(mode, (counts.get(mode) ?? 0) + 1)
    })
    return Array.from(counts.entries())
      .map(([name, value]) => ({ name: formatLabel(name), value }))
      .sort((a, b) => b.value - a.value)
  }, [failureCases])

  const symptomData = React.useMemo(() => {
    const counts = new Map<string, number>()
    failureCases.forEach((fc) => {
      fc.symptoms?.forEach((s) => {
        counts.set(s.name, (counts.get(s.name) ?? 0) + 1)
      })
    })
    return Array.from(counts.entries())
      .map(([name, value]) => ({ name: formatLabel(name), value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
  }, [failureCases])

  const componentData = React.useMemo(() => {
    const counts = new Map<string, number>()
    failureCases.forEach((fc) => {
      fc.components?.forEach((c) => {
        counts.set(c, (counts.get(c) ?? 0) + 1)
      })
    })
    return Array.from(counts.entries())
      .map(([name, failures]) => ({ name, failures }))
      .sort((a, b) => b.failures - a.failures)
  }, [failureCases])

  if (isLoading) {
    return (
      <div className="px-4 md:px-8 py-6 md:py-10 max-w-screen-2xl mx-auto space-y-6">
        <PageHeader />
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-72 w-full rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="px-4 md:px-8 py-6 md:py-10 max-w-screen-2xl mx-auto space-y-6">
      <PageHeader />

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Total runs"
          value={stats.total}
          Icon={Activity}
          accent="primary"
          sublabel="all time"
        />
        <KpiCard
          label="Rejected"
          value={stats.rejected}
          sublabel={`${stats.rejectionRate.toFixed(0)}% rate`}
          Icon={XCircle}
          accent="destructive"
        />
        <KpiCard
          label="Approved"
          value={stats.approved}
          Icon={Activity}
          accent="success"
        />
        <KpiCard
          label="Failure modes"
          value={failureModeData.length}
          Icon={Layers}
          accent="warning"
          sublabel="distinct"
        />
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <SectionCard
          title="Rejection rate over time"
          description="Approved vs rejected by day (last 14 days)"
          bodyClassName="p-3"
        >
          <RejectionTimeline data={timeSeriesData} />
        </SectionCard>

        <SectionCard
          title="Failure mode distribution"
          description="Breakdown of failure modes across rejected runs"
          bodyClassName="p-3"
        >
          {detailsLoading ? (
            <div className="h-52 flex items-center justify-center">
              <Skeleton className="h-40 w-40 rounded-full" />
            </div>
          ) : failureModeData.length === 0 ? (
            <EmptyChart message="No failure data available" />
          ) : (
            <FailureModePie data={failureModeData} />
          )}
        </SectionCard>

        <SectionCard
          title="Top symptoms"
          description="Most common symptoms across rejected runs"
          bodyClassName="p-3"
        >
          {detailsLoading ? (
            <LoadingBars />
          ) : symptomData.length === 0 ? (
            <EmptyChart message="No symptom data available" />
          ) : (
            <SymptomBarChart data={symptomData} />
          )}
        </SectionCard>

        <SectionCard
          title="Component heat map"
          description="Components with the most failures"
          bodyClassName="p-0"
        >
          {detailsLoading ? (
            <LoadingBars />
          ) : componentData.length === 0 ? (
            <EmptyChart message="No component data available" />
          ) : (
            <ComponentTable data={componentData} />
          )}
        </SectionCard>
      </div>
    </div>
  )
}

function PageHeader() {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
        Analytics
      </p>
      <h1 className="mt-1 text-2xl md:text-3xl font-semibold tracking-tight">
        Failure analytics
      </h1>
      <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
        Aggregate insights about failure patterns, symptoms, and affected
        components across agent runs.
      </p>
    </div>
  )
}

const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 11,
}

function RejectionTimeline({
  data,
}: {
  data: { date: string; approved: number; rejected: number }[]
}) {
  return (
    <ResponsiveContainer width="100%" height={220} minWidth={0}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gradApproved" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--success)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gradRejected" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--destructive)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--destructive)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
        />
        <RTooltip
          cursor={{ stroke: "var(--border)" }}
          contentStyle={tooltipStyle}
          labelStyle={{ color: "var(--muted-foreground)" }}
        />
        <Area
          type="monotone"
          dataKey="approved"
          stroke="var(--success)"
          strokeWidth={1.5}
          fill="url(#gradApproved)"
          name="Approved"
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="rejected"
          stroke="var(--destructive)"
          strokeWidth={1.5}
          fill="url(#gradRejected)"
          name="Rejected"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function FailureModePie({
  data,
}: {
  data: { name: string; value: number }[]
}) {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div className="relative h-52 w-full">
      <ResponsiveContainer width="100%" height={208} minWidth={0}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={48}
            outerRadius={70}
            paddingAngle={2}
            dataKey="value"
            stroke="var(--card)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Pie>
          <RTooltip contentStyle={tooltipStyle} />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-2xl font-semibold tabular-nums">{total}</span>
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
          failures
        </span>
      </div>
      <div className="absolute right-2 top-2 flex flex-col gap-1 text-[11px] max-h-48 overflow-y-auto">
        {data.map((d, i) => (
          <div key={d.name} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-sm shrink-0"
              style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
            />
            <span className="text-muted-foreground truncate max-w-[120px]">
              {d.name}
            </span>
            <span className="tabular-nums">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SymptomBarChart({
  data,
}: {
  data: { name: string; value: number }[]
}) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 32)} minWidth={0}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 4, bottom: 4 }}
      >
        <XAxis
          type="number"
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={140}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
        />
        <RTooltip contentStyle={tooltipStyle} />
        <Bar
          dataKey="value"
          name="Occurrences"
          fill="var(--primary)"
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

function ComponentTable({
  data,
}: {
  data: { name: string; failures: number }[]
}) {
  const max = Math.max(1, ...data.map((d) => d.failures))
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-5 py-3 font-medium">Component</th>
            <th className="px-5 py-3 font-medium">Failures</th>
            <th className="px-5 py-3 font-medium w-1/3">Heat</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr
              key={row.name}
              className="border-b border-border last:border-0 hover:bg-accent/40 transition-colors"
            >
              <td className="px-5 py-2.5 font-mono text-xs">{row.name}</td>
              <td className="px-5 py-2.5 tabular-nums">{row.failures}</td>
              <td className="px-5 py-2.5">
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      row.failures / max > 0.66
                        ? "bg-red-500"
                        : row.failures / max > 0.33
                          ? "bg-amber-500"
                          : "bg-emerald-500",
                    )}
                    style={{ width: `${(row.failures / max) * 100}%` }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="h-52 flex flex-col items-center justify-center text-sm text-muted-foreground gap-2">
      <AlertTriangle className="h-5 w-5 opacity-50" />
      {message}
    </div>
  )
}

function LoadingBars() {
  return (
    <div className="p-5 space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  )
}

function formatLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function buildTimeSeries(runs: RunSummary[]) {
  const days = 14
  const buckets: Record<string, { approved: number; rejected: number }> = {}
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const k = d.toISOString().slice(0, 10)
    buckets[k] = { approved: 0, rejected: 0 }
  }
  runs.forEach((r) => {
    const k = new Date(r.started_at).toISOString().slice(0, 10)
    if (buckets[k]) {
      if (r.status === "rejected") buckets[k].rejected += 1
      else if (r.status === "approved") buckets[k].approved += 1
    }
  })
  return Object.entries(buckets).map(([date, v]) => ({
    date: date.slice(5),
    ...v,
  }))
}

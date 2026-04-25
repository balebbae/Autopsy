"use client"

import * as React from "react"
import Link from "next/link"
import useSWR from "swr"
import {
  Activity,
  ArrowUpRight,
  FileDiff,
  Filter,
  Hammer,
  Search,
  Sparkles,
  XCircle,
} from "lucide-react"
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
} from "recharts"

import { apiBaseUrl, type RunSummary } from "@/lib/api"
import { cn, formatDuration, shortId } from "@/lib/utils"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { KpiCard } from "@/components/primitives/kpi-card"
import { SectionCard } from "@/components/primitives/section-card"
import { StatusPill } from "@/components/primitives/status-pill"
import { RelativeTime } from "@/components/primitives/relative-time"
import { EmptyState } from "@/components/primitives/empty-state"

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" })
  if (!r.ok) throw new Error("not ok")
  return (await r.json()) as RunSummary[]
}

function useRelativeRefreshTime(intervalMs: number) {
  const [lastRefresh, setLastRefresh] = React.useState<Date>(new Date())
  const [secondsAgo, setSecondsAgo] = React.useState(0)

  const markRefresh = React.useCallback(() => {
    setLastRefresh(new Date())
    setSecondsAgo(0)
  }, [])

  React.useEffect(() => {
    const timer = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastRefresh.getTime()) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [lastRefresh])

  return { secondsAgo, markRefresh }
}

export function RunsOverview({ initial }: { initial: RunSummary[] }) {
  const { secondsAgo, markRefresh } = useRelativeRefreshTime(5000)
  const { data, isLoading } = useSWR<RunSummary[]>(`${apiBaseUrl}/v1/runs`, fetcher, {
    fallbackData: initial,
    refreshInterval: 5000,
    revalidateOnFocus: false,
    onSuccess: () => markRefresh(),
  })

  const runs = data ?? []

  const [project, setProject] = React.useState<string>("__all")
  const [status, setStatus] = React.useState<string>("__all")
  const [query, setQuery] = React.useState("")

  const projects = React.useMemo(() => {
    const set = new Set<string>()
    runs.forEach((r) => r.project && set.add(r.project))
    return Array.from(set).sort()
  }, [runs])

  const filtered = React.useMemo(() => {
    return runs.filter((r) => {
      if (project !== "__all" && r.project !== project) return false
      if (status !== "__all" && r.status !== status) return false
      if (query) {
        const q = query.toLowerCase()
        const hay = `${r.task ?? ""} ${r.run_id} ${r.project ?? ""} ${
          r.rejection_reason ?? ""
        }`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [runs, project, status, query])

  const stats = React.useMemo(() => {
    const total = runs.length
    const rejected = runs.filter((r) => r.status === "rejected").length
    const approved = runs.filter((r) => r.status === "approved").length
    const active = runs.filter((r) => r.status === "active").length
    const aborted = runs.filter((r) => r.status === "aborted").length
    const totalCalls = runs.reduce((acc, r) => acc + r.tool_calls, 0)
    const totalFiles = runs.reduce((acc, r) => acc + r.files_touched, 0)
    const avgCalls = total ? totalCalls / total : 0
    const avgFiles = total ? totalFiles / total : 0
    const rejectionRate = total ? (rejected / total) * 100 : 0
    return { total, rejected, approved, active, aborted, avgCalls, avgFiles, rejectionRate }
  }, [runs])

  const sparkData = React.useMemo(() => buildSparkSeries(runs), [runs])
  const donutData = React.useMemo(
    () => [
      { name: "Approved", value: stats.approved, color: "var(--success)" },
      { name: "Rejected", value: stats.rejected, color: "var(--destructive)" },
      { name: "Active", value: stats.active, color: "var(--primary)" },
      { name: "Aborted", value: stats.aborted, color: "var(--warning)" },
    ],
    [stats],
  )

  return (
    <div className="space-y-6">
      <PageHeader />

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Total runs"
          value={stats.total}
          Icon={Activity}
          accent="primary"
          sublabel="all time"
        >
          <Sparkline data={sparkData} accent="var(--primary)" />
        </KpiCard>
        <KpiCard
          label="Rejected"
          value={stats.rejected}
          sublabel={`${stats.rejectionRate.toFixed(0)}% rate`}
          Icon={XCircle}
          accent="destructive"
        >
          <Sparkline data={sparkData.map((d) => ({ ...d, value: d.rejected }))} accent="var(--destructive)" />
        </KpiCard>
        <KpiCard
          label="Avg tool calls"
          value={stats.avgCalls.toFixed(1)}
          Icon={Hammer}
          accent="muted"
          sublabel="per run"
        />
        <KpiCard
          label="Avg files touched"
          value={stats.avgFiles.toFixed(1)}
          Icon={FileDiff}
          accent="muted"
          sublabel="per run"
        />
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Activity"
          description="Runs over the last 14 days"
          bodyClassName="p-3"
        >
          <ActivityChart data={sparkData} />
        </SectionCard>
        <SectionCard
          title="Outcome distribution"
          description="Approved vs rejected vs active vs aborted"
          bodyClassName="p-3"
        >
          <OutcomeDonut data={donutData} total={stats.total} />
        </SectionCard>
      </div>

      <SectionCard
        title="Runs"
        description={
          <span className="inline-flex items-center gap-2">
            Click a row to inspect the timeline + autopsy
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              &middot; Updated {secondsAgo < 2 ? "just now" : `${secondsAgo}s ago`}
            </span>
          </span>
        }
        action={
          <FilterBar
            project={project}
            setProject={setProject}
            status={status}
            setStatus={setStatus}
            query={query}
            setQuery={setQuery}
            projects={projects}
          />
        }
        bodyClassName="p-0"
      >
        {isLoading ? (
          <TableSkeleton />
        ) : filtered.length === 0 ? (
          <div className="p-6">
            <EmptyState
              Icon={Sparkles}
              title={runs.length === 0 ? "No runs recorded yet" : "No runs match these filters"}
              description={
                runs.length === 0
                  ? "Link the opencode plugin and start a session, or run `make replay` to load the demo fixture."
                  : "Try clearing the project, status, or search filters."
              }
            />
          </div>
        ) : (
          <RunsTable runs={filtered} />
        )}
      </SectionCard>
    </div>
  )
}

function PageHeader() {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
          Dashboard
        </p>
        <h1 className="mt-1 text-2xl md:text-3xl font-semibold tracking-tight">
          Recent agent runs
        </h1>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          Forensic recorder for opencode sessions. Live timeline, autopsy classification,
          and a failure graph that warns the agent before it repeats a mistake.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-[11px]">
          GET /v1/runs · 5s
        </Badge>
      </div>
    </div>
  )
}

function FilterBar({
  project,
  setProject,
  status,
  setStatus,
  query,
  setQuery,
  projects,
}: {
  project: string
  setProject: (v: string) => void
  status: string
  setStatus: (v: string) => void
  query: string
  setQuery: (v: string) => void
  projects: string[]
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search task, id, reason…"
          className="h-8 pl-8 w-56 text-sm"
        />
      </div>
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="h-8 w-32 text-sm">
          <Filter className="h-3.5 w-3.5 mr-1.5 opacity-60" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All statuses</SelectItem>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="approved">Approved</SelectItem>
          <SelectItem value="rejected">Rejected</SelectItem>
          <SelectItem value="aborted">Aborted</SelectItem>
        </SelectContent>
      </Select>
      <Select value={project} onValueChange={setProject}>
        <SelectTrigger className="h-8 w-44 text-sm">
          <SelectValue placeholder="All projects" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All projects</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function RunsTable({ runs }: { runs: RunSummary[] }) {
  const maxCalls = Math.max(1, ...runs.map((r) => r.tool_calls))
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="px-5 py-3 font-medium">Task</th>
            <th className="px-5 py-3 font-medium">Project</th>
            <th className="px-5 py-3 font-medium">Tool calls</th>
            <th className="px-5 py-3 font-medium">Files</th>
            <th className="px-5 py-3 font-medium">Duration</th>
            <th className="px-5 py-3 font-medium text-right">Started</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.run_id}
              className="group border-b border-border/60 hover:bg-accent/40 transition-colors"
            >
              <td className="px-5 py-3 align-middle">
                <div className="flex items-center gap-2">
                  <StatusPill status={r.status} />
                  {r.status === "active" && (
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    </span>
                  )}
                </div>
              </td>
              <td className="px-5 py-3 align-middle max-w-md">
                <Link
                  href={`/runs/${r.run_id}`}
                  className="block hover:underline cursor-pointer"
                >
                  <div className="font-medium text-foreground truncate">
                    {r.task ?? "Untitled run"}
                  </div>
                  <div className="text-[11px] font-mono text-muted-foreground truncate">
                    {shortId(r.run_id)}
                    {r.rejection_reason ? (
                      <span className="ml-2 text-red-500/80">{r.rejection_reason}</span>
                    ) : null}
                  </div>
                </Link>
              </td>
              <td className="px-5 py-3 align-middle text-muted-foreground">
                {r.project ?? "—"}
              </td>
              <td className="px-5 py-3 align-middle">
                <ToolCallsBar value={r.tool_calls} max={maxCalls} />
              </td>
              <td className="px-5 py-3 align-middle tabular-nums">{r.files_touched}</td>
              <td className="px-5 py-3 align-middle tabular-nums text-muted-foreground">
                {formatDuration(r.started_at, r.ended_at)}
              </td>
              <td className="px-5 py-3 align-middle text-right text-muted-foreground">
                <RelativeTime ts={r.started_at} />
              </td>
              <td className="px-2 py-3 align-middle text-muted-foreground/50">
                <Link
                  href={`/runs/${r.run_id}`}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={`Open run ${r.run_id}`}
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ToolCallsBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <div className="flex items-center gap-2 min-w-[100px]">
      <span className="tabular-nums w-6 text-right">{value}</span>
      <div className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full bg-primary/70",
            value === 0 && "bg-muted-foreground/30",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function Sparkline({
  data,
  accent,
}: {
  data: { date: string; value: number; rejected: number }[]
  accent: string
}) {
  if (!data || data.length === 0) return null
  const id = React.useId().replace(/[^a-z0-9]/gi, "")
  return (
    <ResponsiveContainer width="100%" height={36} minWidth={0}>
      <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.5} />
            <stop offset="100%" stopColor={accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={accent}
          strokeWidth={1.5}
          fill={`url(#spark-${id})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function ActivityChart({
  data,
}: {
  data: { date: string; value: number; rejected: number }[]
}) {
  return (
    <ResponsiveContainer width="100%" height={176} minWidth={0}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="actAll" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="actRej" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--destructive)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--destructive)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <RTooltip
            cursor={{ stroke: "var(--border)" }}
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 11,
            }}
            labelStyle={{ color: "var(--muted-foreground)" }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--primary)"
            strokeWidth={1.5}
            fill="url(#actAll)"
            name="Total"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="rejected"
            stroke="var(--destructive)"
            strokeWidth={1.5}
            fill="url(#actRej)"
            name="Rejected"
            isAnimationActive={false}
          />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function OutcomeDonut({
  data,
  total,
}: {
  data: { name: string; value: number; color: string }[]
  total: number
}) {
  const nonzero = data.filter((d) => d.value > 0)
  if (total === 0 || nonzero.length === 0) {
    return (
      <div className="h-44 w-full flex items-center justify-center text-xs text-muted-foreground">
        No runs yet
      </div>
    )
  }
  return (
    <div className="relative h-44 w-full">
      <ResponsiveContainer width="100%" height={176} minWidth={0}>
        <PieChart>
          <Pie
            data={nonzero}
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
            {nonzero.map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Pie>
          <RTooltip
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 11,
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-2xl font-semibold tabular-nums">{total}</span>
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">runs</span>
      </div>
      <div className="absolute right-2 top-2 flex flex-col gap-1 text-[11px]">
        {data.map((d) =>
          d.value === 0 ? null : (
            <div key={d.name} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ backgroundColor: d.color }}
              />
              <span className="text-muted-foreground">{d.name}</span>
              <span className="tabular-nums">{d.value}</span>
            </div>
          ),
        )}
      </div>
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="p-5 space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

function buildSparkSeries(runs: RunSummary[]) {
  const days = 14
  const buckets: Record<string, { value: number; rejected: number }> = {}
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const k = d.toISOString().slice(0, 10)
    buckets[k] = { value: 0, rejected: 0 }
  }
  runs.forEach((r) => {
    const k = new Date(r.started_at).toISOString().slice(0, 10)
    if (buckets[k]) {
      buckets[k].value += 1
      if (r.status === "rejected") buckets[k].rejected += 1
    }
  })
  return Object.entries(buckets).map(([date, v]) => ({ date: date.slice(5), ...v }))
}

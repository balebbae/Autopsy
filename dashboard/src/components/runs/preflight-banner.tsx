"use client"

import * as React from "react"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ListChecks,
  ListTodo,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react"

import { postPreflight, type PreflightResponse } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn, shortId } from "@/lib/utils"

const riskConfig = {
  none: {
    icon: CheckCircle2,
    label: "No known risks",
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  low: {
    icon: ShieldCheck,
    label: "Low risk",
    border: "border-yellow-500/30",
    bg: "bg-yellow-500/10",
    text: "text-yellow-700 dark:text-yellow-300",
  },
  medium: {
    icon: ShieldAlert,
    label: "Medium risk",
    border: "border-orange-500/30",
    bg: "bg-orange-500/10",
    text: "text-orange-700 dark:text-orange-300",
  },
  high: {
    icon: AlertTriangle,
    label: "High risk",
    border: "border-red-500/30",
    bg: "bg-red-500/10",
    text: "text-red-700 dark:text-red-300",
  },
} as const

export function PreflightBanner({
  task,
  runId,
}: {
  task: string | null
  runId: string
}) {
  const [result, setResult] = React.useState<PreflightResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [dismissed, setDismissed] = React.useState(false)
  const [error, setError] = React.useState(false)

  React.useEffect(() => {
    if (!task?.trim()) return
    let cancelled = false
    setLoading(true)
    setError(false)
    postPreflight({ task }).then((r) => {
      if (cancelled) return
      setLoading(false)
      if (r) {
        setResult(r)
      } else {
        setError(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [task])

  if (dismissed) return null
  if (!task?.trim()) return null

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Running preflight check&hellip;</span>
        </div>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }

  if (error) return null
  if (!result) return null

  const cfg = riskConfig[result.risk_level]
  const Icon = cfg.icon

  return (
    <div
      className={cn(
        "relative rounded-lg border p-4",
        cfg.border,
        cfg.bg,
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-6 w-6 opacity-60 hover:opacity-100"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss preflight banner"
      >
        <X className="h-3.5 w-3.5" />
      </Button>

      <div className="flex items-start gap-3 pr-8">
        <Icon className={cn("h-5 w-5 mt-0.5 shrink-0", cfg.text)} />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("text-sm font-semibold", cfg.text)}>
              {cfg.label}
            </span>
            {result.block && (
              <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
                blocked
              </Badge>
            )}
          </div>

          {result.reason && (
            <p className={cn("text-sm", cfg.text)}>{result.reason}</p>
          )}

          {(result.similar_runs?.length ?? 0) > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                Similar past runs
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(result.similar_runs ?? []).map((id) => (
                  <Link
                    key={id}
                    href={`/runs/${id}`}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1 text-[11px] font-mono hover:bg-accent"
                  >
                    {shortId(id, 8, 4)}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {(result.missing_followups?.length ?? 0) > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5 inline-flex items-center gap-1">
                <ListTodo className="h-3 w-3" /> Missing follow-ups
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(result.missing_followups ?? []).map((item) => (
                  <Badge key={item} variant="outline" className="text-[11px] font-mono">
                    {item}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {(result.recommended_checks?.length ?? 0) > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5 inline-flex items-center gap-1">
                <ListChecks className="h-3 w-3" /> Recommended checks
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(result.recommended_checks ?? []).map((item) => (
                  <Badge key={item} variant="outline" className="text-[11px] font-mono">
                    {item}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {result.system_addendum && (
            <div className="rounded-md border border-border bg-background/40 p-3">
              <article className="prose-aag text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {result.system_addendum}
                </ReactMarkdown>
              </article>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

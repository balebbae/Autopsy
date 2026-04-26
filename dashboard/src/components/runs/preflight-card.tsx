import * as React from "react"
import Link from "next/link"
import { ArrowUpRight, ShieldAlert, ShieldCheck } from "lucide-react"

import type { PreflightHit } from "@/lib/api"
import { SectionCard } from "@/components/primitives/section-card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { humanizeFailureMode } from "@/lib/labels"
import { cn, shortId } from "@/lib/utils"

/** Per-run detail panel: every /v1/preflight call that returned non-none risk
 *  for this run. Pairs with the green "Autopsy fired" badge on the run row.
 *  Hidden when the run has zero hits (typical for old data + happy paths).
 */
export function PreflightCard({ hits }: { hits: PreflightHit[] }) {
  if (!hits || hits.length === 0) return null

  const blockedCount = hits.reduce((acc, h) => acc + (h.blocked ? 1 : 0), 0)
  const description =
    blockedCount > 0
      ? `${hits.length} risk check${hits.length === 1 ? "" : "s"} · ${blockedCount} blocked tool call${blockedCount === 1 ? "" : "s"}`
      : `${hits.length} risk check${hits.length === 1 ? "" : "s"} · agent warned via system prompt`

  return (
    <SectionCard
      title="Autopsy preflight"
      description={description}
      className="border-emerald-500/30 bg-emerald-500/[0.04]"
    >
      <ul className="space-y-4">
        {hits.map((h, i) => (
          <li key={h.id}>
            <PreflightHitRow hit={h} />
            {i < hits.length - 1 ? <Separator className="mt-4" /> : null}
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

function PreflightHitRow({ hit }: { hit: PreflightHit }) {
  const Icon = hit.blocked ? ShieldAlert : ShieldCheck
  const accent = hit.blocked
    ? "text-amber-700 dark:text-amber-300"
    : "text-emerald-700 dark:text-emerald-300"
  const top = hit.top_failure_modes[0]

  return (
    <div className="space-y-2.5">
      <div className="flex items-start gap-2">
        <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", accent)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <RiskBadge level={hit.risk_level} />
            {hit.blocked ? (
              <Badge
                variant="outline"
                className="bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300 text-[10px]"
              >
                BLOCKED
              </Badge>
            ) : null}
            {hit.tool ? (
              <span className="text-[11px] font-mono text-muted-foreground">
                tool: {hit.tool}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm leading-snug" title={hit.task}>
            {hit.task}
          </p>
        </div>
      </div>

      {top ? (
        <div className="text-xs text-muted-foreground pl-6">
          Top match:{" "}
          <span className="text-foreground font-medium">{humanizeFailureMode(top.name)}</span>
          <span className="ml-1.5 tabular-nums">(score {top.score.toFixed(2)})</span>
        </div>
      ) : null}

      {hit.similar_runs.length > 0 ? (
        <div className="pl-6 flex items-center gap-1.5 flex-wrap text-[11px]">
          <span className="text-muted-foreground">Evidence:</span>
          {hit.similar_runs.slice(0, 4).map((rid) => (
            <Link
              key={rid}
              href={`/runs/${rid}`}
              className="font-mono inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-border/70 hover:bg-accent hover:text-foreground transition-colors"
            >
              {shortId(rid)}
              <ArrowUpRight className="h-2.5 w-2.5 opacity-50" />
            </Link>
          ))}
          {hit.similar_runs.length > 4 ? (
            <span className="text-muted-foreground tabular-nums">
              +{hit.similar_runs.length - 4} more
            </span>
          ) : null}
        </div>
      ) : null}

      {hit.addendum ? (
        <details className="pl-6 group">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground select-none">
            Show prompt addendum (what the agent saw)
          </summary>
          <pre className="mt-1.5 whitespace-pre-wrap text-[11px] leading-snug font-mono p-2 rounded-md bg-muted/60 text-foreground/90">
            {hit.addendum}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

function RiskBadge({ level }: { level: PreflightHit["risk_level"] }) {
  const cls =
    level === "high"
      ? "bg-red-500/10 border-red-500/40 text-red-700 dark:text-red-300"
      : level === "medium"
        ? "bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300"
        : "bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
  return (
    <Badge variant="outline" className={cn("uppercase tracking-wide text-[10px]", cls)}>
      {level} risk
    </Badge>
  )
}

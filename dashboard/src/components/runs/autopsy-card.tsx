import * as React from "react"
import { Loader2, Microscope, Wand2 } from "lucide-react"

import type { FailureCase, Run } from "@/lib/api"
import { SectionCard } from "@/components/primitives/section-card"
import { Badge } from "@/components/ui/badge"
import { ConfidenceBar } from "@/components/primitives/confidence-bar"
import { Separator } from "@/components/ui/separator"
import { EmptyState } from "@/components/primitives/empty-state"
import { humanize, humanizeFailureMode, humanizeSymptom } from "@/lib/labels"

export function AutopsyCard({
  failure,
  run,
}: {
  failure: FailureCase | null
  // Optional — when provided, AutopsyCard can distinguish "no analysis
  // yet (idle)" from "analysis in flight (waiting on classifier/gemma)".
  run?: Pick<Run, "status" | "rejection_count">
}) {
  if (!failure) {
    const analyzing =
      run != null &&
      ((run.rejection_count ?? 0) > 0 ||
        run.status === "rejected" ||
        run.status === "aborted")
    if (analyzing) {
      return (
        <SectionCard title="Autopsy" description="Classifying failure mode + symptoms">
          <div className="py-10 px-2 flex items-center justify-center text-center">
            <div className="space-y-3">
              <Loader2 className="h-7 w-7 mx-auto text-primary animate-spin" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Analyzing run…</p>
                <p className="text-xs text-muted-foreground max-w-[28ch] mx-auto leading-snug">
                  Running the rules pass and gemma classification on the
                  events captured so far. This usually takes a few seconds.
                </p>
              </div>
            </div>
          </div>
        </SectionCard>
      )
    }
    return (
      <SectionCard title="Autopsy" description="Run analyzer output">
        <EmptyState
          Icon={Microscope}
          title="No autopsy yet"
          description="No rejection has been filed on this run. The analyzer runs after a rejection, or when the run terminates with /outcome."
          className="py-10"
        />
      </SectionCard>
    )
  }
  const rejCount = run?.rejection_count ?? 0
  const components = Array.from(new Set(failure.components))
  const changePatterns = Array.from(new Set(failure.change_patterns))
  const title = rejCount > 1 ? "Latest autopsy" : "Autopsy"
  const description =
    rejCount > 1
      ? `Most recent rejection of ${rejCount} · classified failure mode + symptoms`
      : "Classified failure mode + symptoms"
  return (
    <SectionCard title={title} description={description}>
      <div className="space-y-5">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Failure mode
          </p>
          <Badge
            variant="outline"
            className="mt-1.5 max-w-full whitespace-normal py-1 px-2.5 text-sm font-medium leading-tight bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30 [overflow-wrap:anywhere]"
            title={failure.failure_mode}
          >
            {humanizeFailureMode(failure.failure_mode)}
          </Badge>
        </div>
        {failure.fix_pattern ? (
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Suggested fix
            </p>
            <div className="mt-1.5 flex items-start gap-2">
              <Wand2 className="h-3.5 w-3.5 mt-1 text-primary shrink-0" />
              <p className="min-w-0 flex-1 text-sm leading-snug text-foreground/90 [overflow-wrap:anywhere]">
                {failure.fix_pattern}
              </p>
            </div>
          </div>
        ) : null}
        {failure.symptoms.length > 0 ? (
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
              Symptoms
            </p>
            <ul className="space-y-3">
              {failure.symptoms.map((s, i) => (
                <li key={`${s.name}-${i}`} className="space-y-1.5">
                  <span
                    className="block text-sm font-medium leading-snug [overflow-wrap:anywhere]"
                    title={s.name}
                  >
                    {humanizeSymptom(s.name)}
                  </span>
                  <ConfidenceBar value={s.confidence} />
                  {s.evidence?.length ? (
                    <ul className="ml-1 list-disc list-outside pl-3 space-y-0.5 text-[11px] text-muted-foreground">
                      {s.evidence.slice(0, 3).map((e, i) => (
                        <li
                          key={i}
                          className="font-mono leading-snug [overflow-wrap:anywhere]"
                        >
                          {e}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {components.length > 0 || changePatterns.length > 0 ? (
          <>
            <Separator />
            <div className="grid grid-cols-1 gap-3">
              {components.length > 0 ? (
                <div>
                  <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                    Components
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {components.map((c) => (
                      <Badge key={c} variant="muted" className="font-mono text-[10px]">
                        {c}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {changePatterns.length > 0 ? (
                <div>
                  <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                    Change patterns
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {changePatterns.map((c) => (
                      <Badge
                        key={c}
                        variant="muted"
                        className="text-[10px]"
                        title={c}
                      >
                        {humanize(c)}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        {failure.summary ? (
          <p className="border-l-2 border-border pl-3 text-xs italic leading-snug text-muted-foreground [overflow-wrap:anywhere]">
            {failure.summary}
          </p>
        ) : null}
      </div>
    </SectionCard>
  )
}

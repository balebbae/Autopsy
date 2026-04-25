import { notFound } from "next/navigation"

import { getRun } from "@/lib/api"
import { RunHeader } from "@/components/runs/run-header"
import { MetricsCard } from "@/components/runs/metrics-card"
import { OutcomeCard } from "@/components/runs/outcome-card"
import { AutopsyCard } from "@/components/runs/autopsy-card"
import { RunTimeline } from "@/components/runs/timeline"
import { DiffsPanel } from "@/components/runs/diffs-panel"

export const dynamic = "force-dynamic"

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = await getRun(id)
  if (!run) notFound()

  const isLive = run.status === "active"

  return (
    <div className="px-4 md:px-8 py-6 md:py-10 max-w-screen-2xl mx-auto space-y-6">
      <RunHeader run={run} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <aside className="lg:col-span-3 space-y-4 order-2 lg:order-1">
          <OutcomeCard run={run} />
          <MetricsCard run={run} />
        </aside>

        <div className="lg:col-span-6 space-y-6 order-1 lg:order-2 min-w-0">
          <RunTimeline runId={run.run_id} initial={run.events} isLive={isLive} />
          <DiffsPanel snapshots={run.diffs} />
        </div>

        <aside className="lg:col-span-3 order-3">
          <AutopsyCard failure={run.failure_case} />
        </aside>
      </div>
    </div>
  )
}

import { ArrowLeftRight } from "lucide-react"

import { listRuns } from "@/lib/api"
import { ComparisonPanel } from "@/components/compare/comparison-panel"

export const dynamic = "force-dynamic"

export default async function ComparePage() {
  const runs = await listRuns()
  return (
    <div className="px-4 md:px-8 py-6 md:py-10 max-w-screen-2xl mx-auto space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
            Demo
          </p>
          <h1 className="mt-1 text-2xl md:text-3xl font-semibold tracking-tight inline-flex items-center gap-2">
            <ArrowLeftRight className="h-6 w-6 text-primary" />
            Before / After
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            Compare a failed run with its successful retry. See what the agent got wrong,
            what Autopsy learned, and what preflight warning would have been shown.
          </p>
        </div>
      </div>

      <ComparisonPanel runs={runs} />
    </div>
  )
}

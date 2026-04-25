import { Microscope } from "lucide-react"

import { listRuns } from "@/lib/api"
import { RunsOverview } from "@/components/runs/runs-overview"

export const dynamic = "force-dynamic"

export default async function Home() {
  const runs = await listRuns()
  return (
    <div className="px-4 md:px-8 py-6 md:py-10 max-w-screen-2xl mx-auto space-y-8">
      <section className="space-y-1">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight inline-flex items-center gap-2.5">
          <Microscope className="h-6 w-6 text-primary" />
          Agent Autopsy
        </h1>
        <p className="text-sm text-muted-foreground max-w-xl">
          Failure memory for AI coding agents. Records what went wrong, classifies it,
          and warns the next run before it repeats the same mistake.
        </p>
      </section>
      <RunsOverview initial={runs} />
    </div>
  )
}

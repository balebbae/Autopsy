import { listRuns } from "@/lib/api"
import { RunsOverview } from "@/components/runs/runs-overview"

export const dynamic = "force-dynamic"

export default async function Home() {
  const runs = await listRuns()
  return (
    <div className="px-4 md:px-8 py-6 md:py-10 max-w-screen-2xl mx-auto">
      <RunsOverview initial={runs} />
    </div>
  )
}

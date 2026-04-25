import { Suspense } from "react"
import { RefreshCw } from "lucide-react"

import { GraphExplorer } from "@/components/graph/graph-explorer"

export const dynamic = "force-dynamic"

function GraphLoading() {
  return (
    <div className="h-[calc(100vh-3.5rem)] w-full grid place-items-center bg-grid-dot">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" /> Loading graph…
      </div>
    </div>
  )
}

export default function GraphPage() {
  return (
    <Suspense fallback={<GraphLoading />}>
      <GraphExplorer />
    </Suspense>
  )
}

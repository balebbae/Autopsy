import { Suspense } from "react"

import { GraphExplorer } from "@/components/graph/graph-explorer"

export const dynamic = "force-dynamic"

export default function GraphPage() {
  return (
    <Suspense fallback={null}>
      <GraphExplorer />
    </Suspense>
  )
}

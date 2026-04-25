import Link from "next/link"

export default function GraphPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <Link href="/" className="text-sm underline text-zinc-500">
        ← all runs
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Failure graph</h1>
      <p className="text-sm text-zinc-500">
        TODO (R4): render <code>/v1/graph/nodes</code> + <code>/v1/graph/edges</code> with
        Cytoscape.js or react-flow. Filter by FailureMode, Component, ChangePattern.
      </p>
    </main>
  )
}

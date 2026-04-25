import Link from "next/link"

import { listRuns } from "@/lib/api"

export default async function Home() {
  const runs = await listRuns()
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Agent Autopsy Graph</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Recent agent runs · click a row for the timeline + autopsy.
        </p>
        <nav className="mt-3 text-sm">
          <Link href="/graph" className="underline">
            failure graph
          </Link>
        </nav>
      </header>
      {runs.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-300 p-12 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No runs yet. Start opencode with the autopsy plugin linked, or
          <br />
          <code className="mt-2 inline-block rounded bg-zinc-100 px-2 py-1 dark:bg-zinc-900">
            make replay
          </code>{" "}
          to load the demo fixture.
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">Status</th>
              <th className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">Task</th>
              <th className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">Project</th>
              <th className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">Files</th>
              <th className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">Tools</th>
              <th className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run_id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <td className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-900">
                  <StatusBadge status={r.status} />
                </td>
                <td className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-900">
                  <Link href={`/runs/${r.run_id}`} className="underline">
                    {r.task ?? r.run_id}
                  </Link>
                </td>
                <td className="border-b border-zinc-100 px-3 py-2 text-zinc-500 dark:border-zinc-900">
                  {r.project ?? "—"}
                </td>
                <td className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-900">
                  {r.files_touched}
                </td>
                <td className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-900">
                  {r.tool_calls}
                </td>
                <td className="border-b border-zinc-100 px-3 py-2 text-zinc-500 dark:border-zinc-900">
                  {new Date(r.started_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "rejected"
      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
      : status === "approved"
        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
        : status === "aborted"
          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${color}`}>
      {status}
    </span>
  )
}

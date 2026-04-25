import Link from "next/link"
import { notFound } from "next/navigation"

import { getRun } from "@/lib/api"

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = await getRun(id)
  if (!run) notFound()

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-6">
        <Link href="/" className="text-sm underline text-zinc-500">
          ← all runs
        </Link>
        <h1 className="mt-2 text-xl font-semibold">{run.task ?? run.run_id}</h1>
        <p className="text-sm text-zinc-500">
          {run.status} · {run.tool_calls} tool calls · {run.files_touched} files touched
        </p>
        {run.rejection_reason ? (
          <p className="mt-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <span className="font-medium">Rejection reason:</span> {run.rejection_reason}
          </p>
        ) : null}
      </header>

      {run.failure_case ? (
        <section className="mb-8 rounded border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Autopsy
          </h2>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Failure mode</dt>
              <dd className="font-medium">{run.failure_case.failure_mode}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Suggested fix</dt>
              <dd>{run.failure_case.fix_pattern ?? "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-zinc-500">Symptoms</dt>
              <dd>
                <ul className="list-disc pl-5">
                  {run.failure_case.symptoms.map((s) => (
                    <li key={s.name}>
                      <span className="font-medium">{s.name}</span>
                      <span className="text-zinc-500"> · {Math.round(s.confidence * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Timeline
        </h2>
        <ol className="space-y-1 text-sm font-mono">
          {run.events.map((e, i) => (
            <li
              key={`${e.event_id ?? i}`}
              className="flex gap-3 border-b border-zinc-100 py-1 dark:border-zinc-900"
            >
              <span className="w-32 shrink-0 text-zinc-500">
                {new Date(e.ts).toLocaleTimeString()}
              </span>
              <span className="w-48 shrink-0 truncate text-zinc-700 dark:text-zinc-300">
                {e.type}
              </span>
              <span className="truncate text-zinc-500">{summarize(e)}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  )
}

function summarize(e: { type: string; properties: Record<string, unknown> }) {
  const p = e.properties
  if (e.type.startsWith("tool.")) {
    const tool = (p.tool as string | undefined) ?? ""
    const args = p.args as Record<string, unknown> | undefined
    return `${tool} ${args?.filePath ?? args?.command ?? ""}`
  }
  if (e.type === "permission.replied") return String(p.reply ?? "")
  if (e.type === "session.diff") {
    const diff = p.diff as unknown[] | undefined
    return `${diff?.length ?? 0} files`
  }
  return ""
}

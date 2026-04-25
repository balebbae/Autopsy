import { ShieldCheck } from "lucide-react"

import { PreflightForm } from "@/components/preflight/preflight-form"

export const dynamic = "force-dynamic"

export default function PreflightPage() {
  return (
    <div className="px-4 md:px-8 py-6 md:py-10 max-w-screen-2xl mx-auto space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
            Playground
          </p>
          <h1 className="mt-1 text-2xl md:text-3xl font-semibold tracking-tight inline-flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            Preflight check
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            Score a task against the failure graph before running it. Returns a risk level,
            similar past runs, missing follow-ups, recommended checks, and a markdown
            addendum that can be injected into the agent&apos;s system prompt.
          </p>
        </div>
      </div>

      <PreflightForm />
    </div>
  )
}

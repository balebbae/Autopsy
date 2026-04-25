"use client"

import * as React from "react"
import Link from "next/link"
import { toast } from "sonner"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  CheckCircle2,
  ListChecks,
  Loader2,
  Send,
  ShieldCheck,
  Sparkles,
  ListTodo,
  ScrollText,
} from "lucide-react"

import { postPreflight, type PreflightRequest, type PreflightResponse } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { SectionCard } from "@/components/primitives/section-card"
import { EmptyState } from "@/components/primitives/empty-state"
import { CodeBlock } from "@/components/primitives/code-block"
import { RiskPill } from "./risk-pill"
import { cn, shortId } from "@/lib/utils"

const SEED_TASKS = [
  "Add preferredName to user profile API and UI",
  "Bump axios to v1 across services + dashboard",
  "Wire feature flag for new onboarding flow",
  "Replace JWT signing key (rotate secrets)",
] as const

export function PreflightForm() {
  const [task, setTask] = React.useState("")
  const [project, setProject] = React.useState("")
  const [worktree, setWorktree] = React.useState("")
  const [tool, setTool] = React.useState("")
  const [argsText, setArgsText] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [response, setResponse] = React.useState<PreflightResponse | null>(null)
  const [submittedTask, setSubmittedTask] = React.useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!task.trim()) {
      toast.error("Task is required")
      return
    }
    let args: Record<string, unknown> | undefined
    if (argsText.trim()) {
      try {
        args = JSON.parse(argsText)
      } catch {
        toast.error("Args must be valid JSON or empty")
        return
      }
    }
    setSubmitting(true)
    const req: PreflightRequest = {
      task: task.trim(),
      worktree: worktree.trim() || null,
      tool: tool.trim() || null,
      args: args ?? null,
    }
    const r = await postPreflight(req)
    setSubmitting(false)
    if (!r) {
      toast.error("Preflight request failed")
      return
    }
    setResponse(r)
    setSubmittedTask(req.task)
    if (r.risk_level === "high") {
      toast.warning("High-risk task detected", {
        description: r.reason ?? "Review the recommended checks before proceeding.",
      })
    } else if (r.risk_level === "medium") {
      toast.info("Medium-risk task", { description: r.reason ?? undefined })
    } else {
      toast.success("Preflight clear")
    }
    void project // currently unused but kept in payload shape if added later
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <SectionCard
        className="lg:col-span-5"
        title="Playground"
        description="Send a synthetic task to /v1/preflight"
        bodyClassName="p-5"
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Task">
            <Textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={4}
              required
              placeholder="Add preferredName to user profile API and UI"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project">
              <Input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="demo-monorepo"
              />
            </Field>
            <Field label="Worktree">
              <Input
                value={worktree}
                onChange={(e) => setWorktree(e.target.value)}
                placeholder="/tmp/demo-monorepo"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tool (optional)">
              <Input
                value={tool}
                onChange={(e) => setTool(e.target.value)}
                placeholder="bash"
              />
            </Field>
            <Field label="Args (JSON, optional)">
              <Input
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder='{"command":"npm test"}'
                className="font-mono"
              />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Run preflight
            </Button>
            <Badge variant="outline" className="font-mono text-[10px]">
              POST /v1/preflight
            </Badge>
          </div>

          <div className="pt-3 border-t border-border">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-2">
              Quick examples
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SEED_TASKS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTask(t)}
                  className="rounded-md border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </form>
      </SectionCard>

      <div className="lg:col-span-7 space-y-4">
        {response ? (
          <ResponseCard response={response} task={submittedTask ?? ""} />
        ) : (
          <SectionCard title="Response" description="Preflight verdict + injected addendum">
            <EmptyState
              Icon={ShieldCheck}
              title="Run a preflight"
              description="Pick a quick example or describe the task you're about to give the agent. AAG will warn before opencode burns tokens repeating a known mistake."
              action={
                <Badge variant="outline" className="text-[11px]">
                  Returns risk_level + system_addendum
                </Badge>
              }
            />
          </SectionCard>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </span>
      {children}
    </label>
  )
}

function ResponseCard({
  response,
  task,
}: {
  response: PreflightResponse
  task: string
}) {
  const r = response
  return (
    <>
      <Card className="p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Verdict
            </p>
            <p className="text-sm text-foreground/90 mt-1.5 max-w-xl line-clamp-2">{task}</p>
          </div>
          <RiskPill level={r.risk_level} blocked={r.block} />
        </div>

        {r.risk_level === "none" && !r.reason ? (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            All clear — no known failure patterns match this task.
          </div>
        ) : r.reason ? (
          <div
            className={cn(
              "rounded-md border p-3 text-sm",
              r.risk_level === "high"
                ? "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300"
                : r.risk_level === "medium"
                  ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-200"
                  : "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
            )}
          >
            {r.reason}
          </div>
        ) : null}

        {(r.similar_runs?.length ?? 0) > 0 ? (
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Similar past runs
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(r.similar_runs ?? []).map((id) => (
                <Link
                  key={id}
                  href={`/runs/${id}`}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-mono hover:bg-accent cursor-pointer"
                >
                  {shortId(id, 8, 4)}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        <ChecklistCard
          title="Missing follow-ups"
          Icon={ListTodo}
          items={r.missing_followups ?? []}
          emptyHint="No previously-missed steps detected."
        />
        <ChecklistCard
          title="Recommended checks"
          Icon={ListChecks}
          items={r.recommended_checks ?? []}
          emptyHint="No proactive checks recommended."
        />
      </div>

      {r.system_addendum ? (
        <SectionCard
          title="System addendum"
          description="Injected into the agent's system prompt before it starts"
          action={
            <Badge variant="outline" className="text-[10px] gap-1">
              <Sparkles className="h-3 w-3" /> markdown
            </Badge>
          }
        >
          <article className="prose-aag text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {r.system_addendum}
            </ReactMarkdown>
          </article>
          <details className="mt-4">
            <summary className="text-[11px] cursor-pointer text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <ScrollText className="h-3 w-3" /> Show raw response
            </summary>
            <CodeBlock language="json" className="mt-2">
              {JSON.stringify(r, null, 2)}
            </CodeBlock>
          </details>
        </SectionCard>
      ) : null}
    </>
  )
}

function ChecklistCard({
  title,
  Icon,
  items,
  emptyHint,
}: {
  title: string
  Icon: React.ComponentType<{ className?: string }>
  items: string[]
  emptyHint: string
}) {
  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5" /> {title}
        </span>
      }
      bodyClassName="p-4"
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">{emptyHint}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" aria-label={item} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 ? (
        <p className="mt-3 text-[11px] text-muted-foreground inline-flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" /> tick as you address each
        </p>
      ) : null}
    </SectionCard>
  )
}

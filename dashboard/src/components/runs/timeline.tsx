"use client"

import * as React from "react"
import { AnimatePresence, motion } from "framer-motion"
import { ChevronRight, Wifi, WifiOff } from "lucide-react"

import type { RunEvent } from "@/lib/api"
import { useRunStream, type StreamedEvent } from "@/lib/sse"
import { SectionCard } from "@/components/primitives/section-card"
import { EventIcon } from "@/components/primitives/event-icon"
import { CodeBlock } from "@/components/primitives/code-block"
import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

type Mergeable = RunEvent | StreamedEvent

const eventLabel: Record<string, string> = {
  "session.created": "Session created",
  "session.idle": "Session idle",
  "session.diff": "Workspace diff",
  "tool.execute.before": "Tool starting",
  "tool.execute.after": "Tool finished",
  "permission.asked": "Permission asked",
  "permission.replied": "Permission replied",
  "message.part.updated": "Message updated",
  "chat.message": "Message",
}

export function RunTimeline({
  runId,
  initial,
  isLive,
}: {
  runId: string
  initial: RunEvent[]
  isLive: boolean
}) {
  const { events: streamed, connected } = useRunStream(isLive ? runId : undefined)

  const merged = React.useMemo(() => {
    const seen = new Set<string>()
    const all: Mergeable[] = []
    for (const e of initial) {
      const key = e.event_id ?? `${e.ts}:${e.type}`
      seen.add(key)
      all.push(e)
    }
    for (const e of streamed) {
      const key = e.event_id ?? `${e.ts}:${e.type}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push(e)
    }
    // Drop session.idle entirely — it's just a "no activity right now" ping
    // and produces a row between every turn. The classifier still sees it
    // via run_events; this is just a render-side filter.
    const filtered = all.filter((e) => e.type !== "session.idle")
    filtered.sort((a, b) => a.ts - b.ts)

    // Collapse runs of consecutive identical events (same type + identical
    // signature) into a single row tagged with the repeat count. Common
    // case: multiple session.diff fired in quick succession with the same
    // file list.
    const collapsed: { event: Mergeable; repeat: number; lastTs: number }[] = []
    for (const e of filtered) {
      const prev = collapsed[collapsed.length - 1]
      if (
        prev &&
        prev.event.type === e.type &&
        eventSignature(prev.event) === eventSignature(e)
      ) {
        prev.repeat += 1
        prev.lastTs = e.ts
        continue
      }
      collapsed.push({ event: e, repeat: 1, lastTs: e.ts })
    }
    return collapsed
  }, [initial, streamed])

  const [selected, setSelected] = React.useState<Mergeable | null>(null)
  const initialKeys = React.useRef(
    new Set(initial.map((e) => e.event_id ?? `${e.ts}:${e.type}`)),
  )

  return (
    <SectionCard
      title="Timeline"
      description={`${merged.length} event${merged.length === 1 ? "" : "s"}`}
      action={
        isLive ? (
          <Badge
            variant="outline"
            className={cn(
              "text-[11px] gap-1.5",
              connected
                ? "border-sky-500/40 text-sky-600 dark:text-sky-300"
                : "border-border text-muted-foreground",
            )}
          >
            {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {connected ? "Streaming" : "Reconnecting…"}
          </Badge>
        ) : (
          <Badge variant="muted" className="text-[11px]">
            Replay
          </Badge>
        )
      }
      bodyClassName="p-0"
    >
      {merged.length === 0 ? (
        <div className="px-5 py-10 text-sm text-center text-muted-foreground">
          No events recorded.
        </div>
      ) : (
        <ol className="relative px-5 pt-2 pb-4">
          <span
            aria-hidden="true"
            className="absolute left-[31px] top-3 bottom-3 w-px bg-border"
          />
          <AnimatePresence initial={false}>
            {merged.map(({ event: e, repeat, lastTs }, idx) => {
              const key = e.event_id ?? `${e.ts}:${e.type}:${idx}`
              const isNew = !initialKeys.current.has(
                e.event_id ?? `${e.ts}:${e.type}`,
              )
              return (
                <TimelineRow
                  key={key}
                  event={e}
                  isNew={isNew}
                  repeat={repeat}
                  lastTs={lastTs}
                  onClick={() => setSelected(e)}
                />
              )
            })}
          </AnimatePresence>
        </ol>
      )}

      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent>
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono text-sm">{selected.type}</SheetTitle>
                <SheetDescription>
                  {new Date(selected.ts).toLocaleString()}
                  {selected.event_id ? (
                    <span className="ml-2 font-mono opacity-70">
                      {selected.event_id}
                    </span>
                  ) : null}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-5">
                <p className="text-[11px] uppercase tracking-widest text-muted-foreground mb-1.5">
                  Properties
                </p>
                <CodeBlock language="json">
                  {JSON.stringify(selected.properties, null, 2)}
                </CodeBlock>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </SectionCard>
  )
}

function TimelineRow({
  event,
  isNew,
  repeat = 1,
  lastTs,
  onClick,
}: {
  event: Mergeable
  isNew: boolean
  repeat?: number
  lastTs?: number
  onClick: () => void
}) {
  const summary = summariseEvent(event)
  const label = labelForEvent(event)
  // Transient flash for newly-arrived events: ring fades after ~1.6s so the
  // styling reads as "this just arrived" instead of staying on every row
  // forever and looking like a permanent severity tag.
  const [flashing, setFlashing] = React.useState(isNew)
  React.useEffect(() => {
    if (!flashing) return
    const t = window.setTimeout(() => setFlashing(false), 1600)
    return () => window.clearTimeout(t)
  }, [flashing])

  // Severity classes are *intrinsic* to the event type (rejection = red,
  // approval = emerald, idle = quiet). They have nothing to do with whether
  // the row is newly-streamed.
  const severity = severityForEvent(event)
  return (
    <motion.li
      layout
      initial={isNew ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn(
        "relative pl-12 pr-2",
        severity === "muted" ? "py-1" : "py-2.5",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "group w-full flex items-start gap-3 rounded-md px-2 py-2 -mx-2 text-left transition-colors hover:bg-accent/60 cursor-pointer",
          severity === "rejection" &&
            "ring-1 ring-red-500/40 bg-red-500/5",
          flashing &&
            severity !== "rejection" &&
            "ring-1 ring-sky-500/30 bg-sky-500/[0.04]",
          severity === "muted" && "py-1.5 opacity-70",
        )}
      >
        <span
          className={cn(
            "absolute left-5 top-3.5 grid h-7 w-7 place-items-center rounded-full bg-card border border-border",
            severity === "muted" && "h-5 w-5 left-6 top-2.5",
          )}
        >
          <EventIcon type={event.type} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("text-sm font-medium truncate flex items-center gap-1.5", severity === "muted" && "text-xs font-normal text-muted-foreground")}>
              {label}
              {repeat > 1 ? (
                <span className="inline-flex items-center rounded-full border border-border bg-muted/60 px-1.5 py-0 text-[10px] font-mono text-muted-foreground tabular-nums">
                  ×{repeat}
                </span>
              ) : null}
            </span>
            <span className="text-[11px] font-mono text-muted-foreground tabular-nums shrink-0">
              {new Date(event.ts).toLocaleTimeString()}
              {repeat > 1 && lastTs && lastTs !== event.ts ? (
                <span className="opacity-60">
                  {" → "}
                  {new Date(lastTs).toLocaleTimeString()}
                </span>
              ) : null}
            </span>
          </div>
          {summary ? (
            <p
              className={cn(
                "mt-0.5 text-[12px] text-muted-foreground truncate",
                severity === "muted" && "hidden",
              )}
            >
              {summary}
            </p>
          ) : null}
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground/50 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
    </motion.li>
  )
}

type Severity = "default" | "rejection" | "muted"

function severityForEvent(e: Mergeable): Severity {
  if (
    e.type === "permission.replied" &&
    (e.properties as { reply?: string } | undefined)?.reply === "reject"
  ) {
    return "rejection"
  }
  return "default"
}

function labelForEvent(e: Mergeable): string {
  // Dynamic labels that depend on payload — fall back to the static
  // `eventLabel` map otherwise.
  if (e.type === "chat.message") {
    const role = (e.properties as { role?: string } | undefined)?.role
    return role === "assistant" ? "Assistant" : "User"
  }
  if (e.type === "message.part.updated") {
    const part = (e.properties as { part?: { type?: string } } | undefined)?.part
    if (part?.type === "text") return "User"
  }
  if (e.type === "message.created" || e.type === "message.updated") {
    const role = pickRole(e.properties)
    if (role === "user") return "User"
    if (role === "assistant") return "Assistant"
  }
  if (
    e.type === "permission.replied" &&
    (e.properties as { reply?: string } | undefined)?.reply === "reject"
  ) {
    return "Permission rejected"
  }
  if (e.type === "tool.execute.after") {
    const tool = (e.properties as { tool?: string } | undefined)?.tool
    return tool ? `Agent ran ${tool}` : "Tool finished"
  }
  return eventLabel[e.type] ?? e.type
}

// Used to detect consecutive duplicate events worth collapsing. Two
// rows with the same signature render identically, so visually merging
// them into one with a ×N badge is lossless.
function eventSignature(e: Mergeable): string {
  const p = e.properties as Record<string, unknown>
  switch (e.type) {
    case "session.diff": {
      const diffs = (p.diff as Array<{ file?: string }>) ?? []
      return diffs.map((d) => d.file ?? "").join("|")
    }
    case "tool.execute.after": {
      const tool = p.tool as string | undefined
      const args = p.args as { filePath?: string; path?: string } | undefined
      const file = args?.filePath ?? args?.path ?? ""
      return `${tool ?? ""}::${file}`
    }
    case "permission.asked":
      return (p.permission as string | undefined) ?? ""
    default:
      return e.type
  }
}

function pickRole(props: Record<string, unknown>): string | null {
  const flat = typeof props["role"] === "string" ? (props["role"] as string) : null
  if (flat) return flat
  const inner = props["message"] as Record<string, unknown> | undefined
  if (inner && typeof inner["role"] === "string") return inner["role"] as string
  return null
}

function summariseEvent(e: Mergeable): string | null {
  const p = e.properties as Record<string, unknown>
  switch (e.type) {
    case "session.created": {
      const info = (p.info as Record<string, unknown> | undefined) ?? {}
      const title = info.title as string | undefined
      return title ? `“${title}”` : null
    }
    case "chat.message": {
      const text = p.text as string | undefined
      return text ? truncateForRow(text) : null
    }
    case "message.part.updated": {
      const part = p.part as
        | { type?: string; text?: string }
        | undefined
      if (part?.type === "text" && part.text) {
        return truncateForRow(part.text)
      }
      return null
    }
    case "message.created":
    case "message.updated": {
      const inner = (p.message as Record<string, unknown> | undefined) ?? p
      const text = extractTextFromMessageProps(inner)
      if (text) return truncateForRow(text)
      return null
    }
    case "tool.execute.before":
    case "tool.execute.after": {
      const tool = p.tool as string | undefined
      const args = p.args as Record<string, unknown> | undefined
      const filePath = args?.filePath as string | undefined
      if (tool && filePath) return `${tool} · ${filePath}`
      return tool ?? null
    }
    case "session.diff": {
      const diff = p.diff as Array<{ file: string }> | undefined
      if (!diff?.length) return null
      const files = diff.map((d) => d.file).slice(0, 3).join(", ")
      return `${diff.length} file${diff.length === 1 ? "" : "s"} · ${files}${diff.length > 3 ? "…" : ""}`
    }
    case "permission.asked": {
      const cmd = (p.metadata as Record<string, unknown> | undefined)?.command as
        | string
        | undefined
      const perm = p.permission as string | undefined
      return cmd ?? perm ?? null
    }
    case "permission.replied": {
      const reply = p.reply as string | undefined
      return reply ? `reply: ${reply}` : null
    }
    default:
      return null
  }
}

function truncateForRow(s: string, max = 120): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function extractTextFromMessageProps(props: Record<string, unknown>): string | null {
  // Direct content / text
  for (const key of ["content", "text"]) {
    const v = props[key]
    if (typeof v === "string" && v.trim()) return v
  }
  // Parts: [{ type: "text", text: "..." }, ...]
  const parts = props["parts"]
  if (Array.isArray(parts)) {
    const collected: string[] = []
    for (const p of parts) {
      if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
        const t = (p as { text?: unknown }).text
        if (typeof t === "string" && t.trim()) collected.push(t)
      }
    }
    if (collected.length) return collected.join(" ")
  }
  return null
}

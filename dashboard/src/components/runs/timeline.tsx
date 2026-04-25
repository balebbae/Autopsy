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
    return all.sort((a, b) => a.ts - b.ts)
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
            {merged.map((e, idx) => {
              const key = e.event_id ?? `${e.ts}:${e.type}:${idx}`
              const isNew = !initialKeys.current.has(
                e.event_id ?? `${e.ts}:${e.type}`,
              )
              return (
                <TimelineRow
                  key={key}
                  event={e}
                  isNew={isNew}
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
  onClick,
}: {
  event: Mergeable
  isNew: boolean
  onClick: () => void
}) {
  const summary = summariseEvent(event)
  return (
    <motion.li
      layout
      initial={isNew ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="relative pl-12 pr-2 py-2.5"
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "group w-full flex items-start gap-3 rounded-md px-2 py-2 -mx-2 text-left transition-colors hover:bg-accent/60 cursor-pointer",
          isNew && "ring-1 ring-amber-500/40 bg-amber-500/5",
        )}
      >
        <span className="absolute left-5 top-3.5 grid h-7 w-7 place-items-center rounded-full bg-card border border-border">
          <EventIcon type={event.type} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium truncate">
              {eventLabel[event.type] ?? event.type}
            </span>
            <span className="text-[11px] font-mono text-muted-foreground tabular-nums shrink-0">
              {new Date(event.ts).toLocaleTimeString()}
            </span>
          </div>
          {summary ? (
            <p className="mt-0.5 text-[12px] text-muted-foreground truncate">
              {summary}
            </p>
          ) : null}
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground/50 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
    </motion.li>
  )
}

function summariseEvent(e: Mergeable): string | null {
  const p = e.properties as Record<string, unknown>
  switch (e.type) {
    case "session.created": {
      const info = (p.info as Record<string, unknown> | undefined) ?? {}
      const title = info.title as string | undefined
      return title ? `“${title}”` : null
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

"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { useTheme } from "next-themes"
import { ChevronDown, FileDiff, Plus, Minus } from "lucide-react"

import type { DiffSnapshot, DiffFile } from "@/lib/api"
import { SectionCard } from "@/components/primitives/section-card"
import { EmptyState } from "@/components/primitives/empty-state"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const ReactDiffViewer = dynamic(() => import("react-diff-viewer-continued"), {
  ssr: false,
  loading: () => <div className="h-32 rounded-md bg-muted/40 animate-pulse" />,
})

export function DiffsPanel({ snapshots }: { snapshots: DiffSnapshot[] }) {
  // opencode emits cumulative session.diff snapshots (relative to session
  // start), so the *latest* snapshot is always the source of truth for the
  // current workspace state. Merging files across snapshots leaks stale
  // entries (e.g. a file that was created and then reverted would still
  // show up as "added"). Render only the most recent snapshot's files;
  // surface older snapshots via the History accordion.
  const ordered = React.useMemo(
    () => [...snapshots].sort((a, b) => (b.captured_at ?? 0) - (a.captured_at ?? 0)),
    [snapshots],
  )
  const latestSnapshot = ordered[0]
  const latestFiles = latestSnapshot?.files ?? []

  if (ordered.length === 0) {
    return (
      <SectionCard title="Diffs" description="Per-file changes recorded during the run">
        <EmptyState
          Icon={FileDiff}
          title="No diffs captured"
          description="The agent didn't emit a session.diff event. Tool-level diffs may still appear in the timeline."
          className="py-8"
        />
      </SectionCard>
    )
  }

  const tsLabel = latestSnapshot?.captured_at
    ? new Date(latestSnapshot.captured_at).toLocaleTimeString()
    : null
  const desc =
    latestFiles.length === 0
      ? `Workspace clean${tsLabel ? ` · latest snapshot ${tsLabel}` : ""}${ordered.length > 1 ? ` · ${ordered.length} snapshots` : ""}`
      : `${latestFiles.length} file${latestFiles.length === 1 ? "" : "s"} changed${tsLabel ? ` · latest ${tsLabel}` : ""}${ordered.length > 1 ? ` · ${ordered.length} snapshots` : ""}`

  return (
    <SectionCard title="Diffs" description={desc} bodyClassName="p-0">
      {latestFiles.length === 0 ? (
        <EmptyState
          Icon={FileDiff}
          title="No changes in latest snapshot"
          description="All previous changes have been reverted or no edits remain. See History below for prior snapshots."
          className="py-8"
        />
      ) : (
        <ul className="divide-y divide-border">
          {latestFiles.map((f, idx) => (
            <DiffItem
              key={`${latestSnapshot?.captured_at ?? 0}:${f.file}`}
              file={f}
              defaultOpen={idx === 0}
            />
          ))}
        </ul>
      )}
      {ordered.length > 1 ? <DiffHistory snapshots={ordered} /> : null}
    </SectionCard>
  )
}

function DiffHistory({ snapshots }: { snapshots: DiffSnapshot[] }) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-5 py-2 text-xs text-muted-foreground hover:bg-accent/40"
      >
        <span>
          History · {snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open ? (
        <ul className="divide-y divide-border bg-muted/20">
          {snapshots.map((s, i) => (
            <li key={`${s.captured_at}-${i}`} className="px-5 py-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 text-muted-foreground">
                <span className="font-mono">
                  {s.captured_at
                    ? new Date(s.captured_at).toLocaleTimeString()
                    : `Snapshot ${snapshots.length - i}`}
                </span>
                <span className="tabular-nums">
                  {s.files.length} file{s.files.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {s.files.map((f) => (
                  <li
                    key={f.file}
                    className="flex items-center gap-2 font-mono text-[11px]"
                  >
                    <span className="truncate">{f.file}</span>
                    {typeof f.additions === "number" ? (
                      <span className="text-emerald-500">+{f.additions}</span>
                    ) : null}
                    {typeof f.deletions === "number" ? (
                      <span className="text-red-500">-{f.deletions}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function DiffItem({ file, defaultOpen }: { file: DiffFile; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(Boolean(defaultOpen))
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  const { oldVal, newVal } = parsePatch(file.patch ?? "")

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-5 py-3 text-left hover:bg-accent/40 cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
          <FileDiff className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono text-sm truncate">{file.file}</span>
          {file.status ? (
            <Badge variant="muted" className="ml-1 text-[10px] capitalize">
              {file.status}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {typeof file.additions === "number" ? (
            <span className="inline-flex items-center gap-0.5 text-emerald-500 tabular-nums">
              <Plus className="h-3 w-3" />
              {file.additions}
            </span>
          ) : null}
          {typeof file.deletions === "number" ? (
            <span className="inline-flex items-center gap-0.5 text-red-500 tabular-nums">
              <Minus className="h-3 w-3" />
              {file.deletions}
            </span>
          ) : null}
        </div>
      </button>
      {open ? (
        <div className="px-2 pb-3 text-[12px]">
          {oldVal || newVal ? (
            <div className="rounded-md overflow-hidden border border-border">
              <ReactDiffViewer
                oldValue={oldVal}
                newValue={newVal}
                splitView={false}
                useDarkTheme={dark}
                hideLineNumbers={false}
                styles={{
                  variables: {
                    light: {
                      diffViewerBackground: "transparent",
                      diffViewerColor: "var(--foreground)",
                      addedBackground: "color-mix(in oklab, var(--success) 16%, transparent)",
                      addedColor: "var(--foreground)",
                      removedBackground:
                        "color-mix(in oklab, var(--destructive) 14%, transparent)",
                      removedColor: "var(--foreground)",
                      wordAddedBackground:
                        "color-mix(in oklab, var(--success) 32%, transparent)",
                      wordRemovedBackground:
                        "color-mix(in oklab, var(--destructive) 32%, transparent)",
                      gutterBackground: "transparent",
                      gutterColor: "var(--muted-foreground)",
                      addedGutterBackground: "transparent",
                      removedGutterBackground: "transparent",
                      codeFoldGutterBackground: "transparent",
                      codeFoldBackground: "transparent",
                      emptyLineBackground: "transparent",
                    },
                    dark: {
                      diffViewerBackground: "transparent",
                      diffViewerColor: "var(--foreground)",
                      addedBackground: "color-mix(in oklab, var(--success) 16%, transparent)",
                      addedColor: "var(--foreground)",
                      removedBackground:
                        "color-mix(in oklab, var(--destructive) 18%, transparent)",
                      removedColor: "var(--foreground)",
                      wordAddedBackground:
                        "color-mix(in oklab, var(--success) 36%, transparent)",
                      wordRemovedBackground:
                        "color-mix(in oklab, var(--destructive) 38%, transparent)",
                      gutterBackground: "transparent",
                      gutterColor: "var(--muted-foreground)",
                      addedGutterBackground: "transparent",
                      removedGutterBackground: "transparent",
                      codeFoldGutterBackground: "transparent",
                      codeFoldBackground: "transparent",
                      emptyLineBackground: "transparent",
                    },
                  },
                  contentText: {
                    fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
                    fontSize: 12,
                  },
                  line: {
                    padding: "1px 8px",
                  },
                }}
              />
            </div>
          ) : (
            <div className="px-3 pb-2 text-xs text-muted-foreground italic">
              No textual diff available for this file.
            </div>
          )}
        </div>
      ) : null}
    </li>
  )
}

function parsePatch(patch: string): { oldVal: string; newVal: string } {
  if (!patch) return { oldVal: "", newVal: "" }
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@") || raw.startsWith("---") || raw.startsWith("+++")) continue
    if (raw.startsWith("+")) newLines.push(raw.slice(1))
    else if (raw.startsWith("-")) oldLines.push(raw.slice(1))
    else if (raw.startsWith(" ")) {
      oldLines.push(raw.slice(1))
      newLines.push(raw.slice(1))
    } else {
      oldLines.push(raw)
      newLines.push(raw)
    }
  }
  return { oldVal: oldLines.join("\n"), newVal: newLines.join("\n") }
}

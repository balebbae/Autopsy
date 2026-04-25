"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { Activity, Moon, Network, ShieldCheck, Sun, Terminal } from "lucide-react"
import { useTheme } from "next-themes"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { apiBaseUrl, type RunSummary } from "@/lib/api"
import { shortId } from "@/lib/utils"

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" })
  if (!r.ok) return []
  return (await r.json()) as RunSummary[]
}

export function CommandPalette() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()
  const { setTheme } = useTheme()

  const { data: runs } = useSWR<RunSummary[]>(
    open ? `${apiBaseUrl}/v1/runs?limit=20` : null,
    fetcher,
  )

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const go = (path: string) => {
    setOpen(false)
    router.push(path)
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-muted-foreground gap-2 px-2.5"
        aria-label="Open command palette"
      >
        <Terminal className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Command</span>
        <kbd className="hidden sm:inline pointer-events-none ml-1 select-none rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
          ⌘K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Search runs, navigate, switch theme…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Navigate">
            <CommandItem onSelect={() => go("/")}>
              <Activity /> Runs
              <CommandShortcut>g r</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => go("/graph")}>
              <Network /> Failure Graph
              <CommandShortcut>g g</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => go("/preflight")}>
              <ShieldCheck /> Preflight
              <CommandShortcut>g p</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          {runs && runs.length > 0 ? (
            <CommandGroup heading="Recent runs">
              {runs.slice(0, 8).map((r) => (
                <CommandItem
                  key={r.run_id}
                  onSelect={() => go(`/runs/${r.run_id}`)}
                  value={`${r.run_id} ${r.task ?? ""}`}
                >
                  <Activity />
                  <div className="flex flex-col">
                    <span className="text-sm">{r.task ?? r.run_id}</span>
                    <span className="text-[11px] text-muted-foreground font-mono">
                      {shortId(r.run_id)} · {r.status}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandSeparator />
          <CommandGroup heading="Theme">
            <CommandItem onSelect={() => setTheme("light")}>
              <Sun /> Light
            </CommandItem>
            <CommandItem onSelect={() => setTheme("dark")}>
              <Moon /> Dark
            </CommandItem>
            <CommandItem onSelect={() => setTheme("system")}>
              <Sun /> System
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  )
}

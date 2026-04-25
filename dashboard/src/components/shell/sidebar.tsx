"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Activity,
  ArrowLeftRight,
  Network,
  ShieldCheck,
  Sparkles,
} from "lucide-react"

import { cn } from "@/lib/utils"

const navItems = [
  { href: "/", label: "Runs", icon: Activity, match: (p: string) => p === "/" || p.startsWith("/runs") },
  { href: "/graph", label: "Failure Graph", icon: Network, match: (p: string) => p.startsWith("/graph") },
  { href: "/preflight", label: "Preflight", icon: ShieldCheck, match: (p: string) => p.startsWith("/preflight") },
  { href: "/compare", label: "Compare", icon: ArrowLeftRight, match: (p: string) => p.startsWith("/compare") },
] as const

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="hidden md:flex flex-col w-60 shrink-0 border-r border-border bg-card/30 backdrop-blur-xl">
      <div className="px-5 py-5 flex items-center gap-2">
        <div className="relative h-8 w-8 rounded-md bg-gradient-to-br from-primary to-primary/40 grid place-items-center text-primary-foreground shadow">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-tight">Autopsy</span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground leading-tight">
            Agent Graph
          </span>
        </div>
      </div>

      <nav className="px-3 mt-2 flex flex-col gap-0.5">
        {navItems.map((item) => {
          const active = item.match(pathname ?? "")
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("h-4 w-4", active && "text-primary")} />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="mt-auto px-5 py-4 text-[11px] leading-relaxed text-muted-foreground border-t border-border">
        <p className="font-mono opacity-70">v0.1 · localhost:4000</p>
        <p className="mt-1">Forensic recorder for opencode runs.</p>
      </div>
    </aside>
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Activity,
  BookOpen,
  Network,
  ShieldCheck,
} from "lucide-react"

import { LogoMark } from "@/components/brand/logo-mark"
import { cn } from "@/lib/utils"

const navItems = [
  { href: "/", label: "Runs", icon: Activity, match: (p: string) => p === "/" || p.startsWith("/runs") },
  { href: "/graph", label: "Failure Graph", icon: Network, match: (p: string) => p.startsWith("/graph") },
  { href: "/preflight", label: "Preflight", icon: ShieldCheck, match: (p: string) => p.startsWith("/preflight") },
] as const

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="hidden md:flex flex-col w-60 shrink-0 border-r border-border bg-card/30 backdrop-blur-xl">
      <Link
        href="/"
        className="px-5 py-5 flex items-center gap-2.5 group"
        aria-label="Autopsy home"
      >
        <LogoMark className="h-7 w-7 text-foreground transition-colors group-hover:text-primary" />
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-tight">Autopsy</span>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground leading-tight">
            Agent Graph
          </span>
        </div>
      </Link>

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
        <a
          href="https://autopsy.surf"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <BookOpen className="h-4 w-4" />
          <span>Go to Docs</span>
        </a>
      </nav>
    </aside>
  )
}

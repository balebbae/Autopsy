"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Activity, ArrowLeftRight, Microscope, Network, ShieldCheck } from "lucide-react"

import { ThemeToggle } from "@/components/theme/theme-toggle"
import { LiveIndicator } from "@/components/shell/live-indicator"
import { CommandPalette } from "@/components/shell/command-palette"
import { cn } from "@/lib/utils"

const mobileNav = [
  { href: "/", label: "Runs", icon: Activity },
  { href: "/graph", label: "Graph", icon: Network },
  { href: "/preflight", label: "Preflight", icon: ShieldCheck },
  { href: "/compare", label: "Compare", icon: ArrowLeftRight },
] as const

export function Topbar() {
  const pathname = usePathname() ?? ""
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/70 backdrop-blur-xl px-4 md:px-6">
      <Link href="/" className="md:hidden flex items-center gap-2 mr-2">
        <div className="h-7 w-7 rounded-md bg-gradient-to-br from-primary to-primary/40 grid place-items-center text-primary-foreground">
          <Microscope className="h-3.5 w-3.5" />
        </div>
        <span className="font-semibold text-sm">Autopsy</span>
      </Link>
      <div className="md:hidden flex items-center gap-1 mr-auto">
        {mobileNav.map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href)
          const Icon = n.icon
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-label={n.label}
              className={cn(
                "h-9 w-9 grid place-items-center rounded-md cursor-pointer",
                active ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
            </Link>
          )
        })}
      </div>
      <div className="hidden md:block flex-1" />
      <div className="flex items-center gap-2">
        <LiveIndicator />
        <CommandPalette />
        <ThemeToggle />
      </div>
    </header>
  )
}

import * as React from "react"
import { Toaster } from "sonner"

import { Sidebar } from "@/components/shell/sidebar"
import { Topbar } from "@/components/shell/topbar"
import { TooltipProvider } from "@/components/ui/tooltip"

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen bg-background">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <Topbar />
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      </div>
      <Toaster richColors position="bottom-right" theme="system" />
    </TooltipProvider>
  )
}

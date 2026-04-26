import * as React from "react"
import { cn } from "@/lib/utils"

export function CodeBlock({
  children,
  className,
  language,
}: {
  children: React.ReactNode
  className?: string
  language?: string
}) {
  return (
    <pre
      className={cn(
        "relative max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-5 font-mono scrollbar-thin",
        className,
      )}
    >
      {language ? (
        <span className="absolute right-2 top-2 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-mono">
          {language}
        </span>
      ) : null}
      <code className="text-foreground/90 whitespace-pre-wrap [overflow-wrap:anywhere]">{children}</code>
    </pre>
  )
}

export function InlineCode({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "rounded bg-muted/70 border border-border px-1.5 py-0.5 text-[11px] font-mono",
        className,
      )}
    >
      {children}
    </code>
  )
}

import * as React from "react"
import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"

export function SectionCard({
  title,
  description,
  action,
  className,
  bodyClassName,
  children,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
  bodyClassName?: string
  children: React.ReactNode
}) {
  return (
    <Card className={cn("flex flex-col", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-border">
          <div className="min-w-0">
            {title ? (
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {title}
              </h3>
            ) : null}
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>
      )}
      <div className={cn("p-5 flex-1", bodyClassName)}>{children}</div>
    </Card>
  )
}

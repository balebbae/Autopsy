"use client"

import * as React from "react"
import { AlertOctagon, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { CodeBlock } from "@/components/primitives/code-block"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="px-4 md:px-8 py-12 max-w-3xl mx-auto">
      <Card className="p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-red-500/10 text-red-500 border border-red-500/20">
            <AlertOctagon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              An unhandled exception was thrown while rendering this page.
            </p>
          </div>
        </div>
        <CodeBlock>
          {error.message}
          {error.digest ? `\n\ndigest: ${error.digest}` : ""}
        </CodeBlock>
        <div>
          <Button onClick={reset}>
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </Button>
        </div>
      </Card>
    </div>
  )
}

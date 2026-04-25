"use client"

import * as React from "react"
import { FileDown, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { getRunReport } from "@/lib/api"
import { Button } from "@/components/ui/button"

export function ReportButton({ runId }: { runId: string }) {
  const [loading, setLoading] = React.useState(false)

  async function handleClick() {
    setLoading(true)
    try {
      const md = await getRunReport(runId)
      if (!md) {
        toast.error("Failed to fetch autopsy report")
        return
      }
      const blob = new Blob([md], { type: "text/markdown" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `autopsy-${runId}.md`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("Failed to download report")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={loading}>
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
      Download Report
    </Button>
  )
}

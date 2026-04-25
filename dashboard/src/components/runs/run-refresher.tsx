"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { useRunStream } from "@/lib/sse"

// Client-side companion to the server-rendered run page. Two roles:
//
// 1. Periodic refresh while the run is live — picks up out-of-band updates
//    that don't come through the event stream (rejection_count bumps,
//    failure_case landing, metrics aggregates, etc.).
//
// 2. Targeted refresh shortly after a rejection-shaped event lands on the
//    SSE stream, so the just-classified failure_case shows up without the
//    user manually reloading.
//
// The actual SSE-event rendering still happens in the timeline component;
// this only triggers `router.refresh()` to re-run the page's server fetch.
export function RunRefresher({
  runId,
  isLive,
  pollMs = 10000,
}: {
  runId: string
  isLive: boolean
  pollMs?: number
}) {
  const router = useRouter()
  const { events } = useRunStream(isLive ? runId : undefined)
  const lastSeen = React.useRef(0)

  // Fire-on-rejection: refresh ~1.5s after we observe a permission reject
  // so the classifier has time to commit the failure_case.
  React.useEffect(() => {
    if (events.length === lastSeen.current) return
    const fresh = events.slice(lastSeen.current)
    lastSeen.current = events.length
    const sawReject = fresh.some(
      (e) =>
        e.type === "permission.replied" &&
        (e.properties as { reply?: string } | undefined)?.reply === "reject",
    )
    if (sawReject) {
      const t = setTimeout(() => router.refresh(), 1500)
      return () => clearTimeout(t)
    }
  }, [events, router])

  // Light periodic refresh — only while live, only when the tab is visible
  // (so a backgrounded tab doesn't hammer the server).
  React.useEffect(() => {
    if (!isLive) return
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh()
    }, pollMs)
    return () => window.clearInterval(id)
  }, [isLive, pollMs, router])

  return null
}

"use client"

import { useEffect, useState } from "react"

import { apiBaseUrl } from "./api"

export type StreamedEvent = {
  event_id: string | null
  run_id: string
  ts: number
  type: string
  properties: Record<string, unknown>
}

// Subscribes to GET /v1/runs/:id/stream (SSE). Returns the rolling list of
// events received since mount.
export function useRunStream(runId: string | undefined): StreamedEvent[] {
  const [events, setEvents] = useState<StreamedEvent[]>([])

  useEffect(() => {
    if (!runId) return
    const es = new EventSource(`${apiBaseUrl}/v1/runs/${runId}/stream`)
    const onMessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as StreamedEvent
        setEvents((prev) => [...prev, data])
      } catch {
        // ignore
      }
    }
    es.onmessage = onMessage
    es.addEventListener("message", onMessage)
    return () => es.close()
  }, [runId])

  return events
}

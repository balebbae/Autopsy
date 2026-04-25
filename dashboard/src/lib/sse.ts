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

export type StreamStatus = "idle" | "connecting" | "open" | "closed" | "error"

export type RunStreamState = {
  events: StreamedEvent[]
  status: StreamStatus
  /** True when the EventSource readyState is OPEN. */
  connected: boolean
}

// Subscribes to GET /v1/runs/:id/stream (SSE). Returns the rolling list of
// events received since mount plus the live connection status.
export function useRunStream(runId: string | undefined): RunStreamState {
  const [events, setEvents] = useState<StreamedEvent[]>([])
  const [status, setStatus] = useState<StreamStatus>("idle")

  useEffect(() => {
    if (!runId) return
    setStatus("connecting")
    const es = new EventSource(`${apiBaseUrl}/v1/runs/${runId}/stream`)

    const onMessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as StreamedEvent
        setEvents((prev) => [...prev, data])
      } catch {
        // ignore parse failures
      }
    }
    es.onopen = () => setStatus("open")
    es.onerror = () => setStatus("error")
    es.onmessage = onMessage
    es.addEventListener("message", onMessage)
    return () => {
      es.close()
      setStatus("closed")
    }
  }, [runId])

  return { events, status, connected: status === "open" }
}

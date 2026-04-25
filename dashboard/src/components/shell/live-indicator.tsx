"use client"

import * as React from "react"
import useSWR from "swr"

import { apiBaseUrl } from "@/lib/api"
import { cn } from "@/lib/utils"

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" })
  if (!r.ok) throw new Error("not ok")
  return r.json()
}

export function LiveIndicator() {
  const { data, error } = useSWR(`${apiBaseUrl}/v1/health`, fetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: false,
  })
  const ok = !error && Boolean(data)

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium",
        ok ? "text-success" : "text-muted-foreground",
      )}
      title={ok ? "Connected to AAG service" : "Service unreachable"}
    >
      <span className="relative flex h-2 w-2">
        {ok ? (
          <>
            <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </>
        ) : (
          <span className="inline-flex h-2 w-2 rounded-full bg-muted-foreground/60" />
        )}
      </span>
      {ok ? "Live" : "Offline"}
    </div>
  )
}

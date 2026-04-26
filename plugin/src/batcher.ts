import { postEvents } from "./client.ts"
import type { EventIn } from "./types.ts"

const FLUSH_MS = 200
const FLUSH_MAX = 32

let buffer: EventIn[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let flushing: Promise<void> | undefined

export const enqueue = (ev: EventIn) => {
  buffer.push(ev)
  if (buffer.length >= FLUSH_MAX) return void flush()
  if (timer === undefined) timer = setTimeout(flush, FLUSH_MS)
}

export const flush = (): Promise<void> | undefined => {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
  if (buffer.length === 0) return
  if (flushing !== undefined) return flushing

  flushing = (async () => {
    try {
      while (buffer.length > 0) {
        const batch = buffer.splice(0, FLUSH_MAX)
        await postEvents(batch)
      }
    } finally {
      flushing = undefined
      if (buffer.length > 0) flush()
    }
  })()
  return flushing
}

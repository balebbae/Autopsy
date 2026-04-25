import { postEvents } from "./client.ts"
import type { EventIn } from "./types.ts"

const FLUSH_MS = 200
const FLUSH_MAX = 32

let buffer: EventIn[] = []
let timer: ReturnType<typeof setTimeout> | undefined

export const enqueue = (ev: EventIn) => {
  buffer.push(ev)
  if (buffer.length >= FLUSH_MAX) return flush()
  if (timer === undefined) timer = setTimeout(flush, FLUSH_MS)
}

export const flush = () => {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
  if (buffer.length === 0) return
  const batch = buffer
  buffer = []
  return postEvents(batch)
}

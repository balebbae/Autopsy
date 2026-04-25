// Smoke test for `last-task.ts`. Run with:
//   bun plugin/src/__smoke__/last-task.smoke.ts
// Exits 0 on success, 1 on failure. No test framework — keep it dumb.

import {
  _resetLatestUserMessage,
  latestUserMessage,
  setLatestUserMessage,
} from "../last-task.ts"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

_resetLatestUserMessage()
assert(latestUserMessage() === null, "expected null on fresh module")

setLatestUserMessage("hi")
assert(latestUserMessage() === "hi", `expected "hi", got ${JSON.stringify(latestUserMessage())}`)

// Whitespace-only writes must NOT clobber the existing value.
setLatestUserMessage("  ")
assert(
  latestUserMessage() === "hi",
  `whitespace clobbered the buffer; got ${JSON.stringify(latestUserMessage())}`,
)

setLatestUserMessage("")
assert(
  latestUserMessage() === "hi",
  `empty string clobbered the buffer; got ${JSON.stringify(latestUserMessage())}`,
)

// A real new value should overwrite, with surrounding whitespace trimmed.
setLatestUserMessage("  next task  ")
assert(
  latestUserMessage() === "next task",
  `expected trimmed "next task", got ${JSON.stringify(latestUserMessage())}`,
)

console.log("ok")

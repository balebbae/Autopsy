// @aag/opencode-plugin
//
// Single-file entry. Loaded by opencode either:
//   1) symlinked into .opencode/plugins/autopsy.ts (see scripts/link-plugin.sh), or
//   2) referenced as an npm package in opencode.json.
//
// Type imports are intentionally loose — the plugin runtime injects `client`,
// `$`, etc. and we don't want a hard dependency on @opencode-ai/plugin's
// internal Plugin type which is still iterating.

import { onEvent } from "./handlers/event.ts"
import { onPermissionAsk, onPermissionReplied } from "./handlers/permission.ts"
import { onSystemTransform } from "./handlers/system.ts"
import { onToolAfter } from "./handlers/tool-after.ts"
import { onToolBefore } from "./handlers/tool-before.ts"

const Autopsy = async (ctx: {
  project?: { id?: string }
  directory?: string
  worktree?: string
  client?: unknown
  $?: unknown
}) => ({
  event: (e: { type: string; properties: Record<string, unknown> }) => onEvent(e, ctx),

  "tool.execute.before": (input: any, output: any) => onToolBefore(input, output),
  "tool.execute.after": (input: any, output: any) => onToolAfter(input, output),

  "permission.ask": (input: any, output: any) => onPermissionAsk(input, output),

  "experimental.chat.system.transform": (input: any, output: any) =>
    onSystemTransform(input, output),

  // Bus event mirroring picks up permission.replied too, but we attach an
  // outcome side effect when the reply is reject.
  "permission.replied": (props: any) => onPermissionReplied(props),
})

export default Autopsy
export { Autopsy }

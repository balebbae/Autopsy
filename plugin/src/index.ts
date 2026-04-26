// @aag/opencode-plugin
//
// Single-file entry. Loaded by opencode either:
//   1) symlinked into .opencode/plugins/autopsy.ts (see scripts/link-plugin.sh), or
//   2) referenced as an npm package in opencode.json.
//
// opencode 1.x expects a PluginModule shape: `{ server: PluginFn }` as the
// default export. The function returns a Hooks object. See
// .opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts.

import { onChatMessage } from "./handlers/chat-message.ts"
import { onEvent } from "./handlers/event.ts"
import { onPermissionAsk } from "./handlers/permission.ts"
import { makeRejectionTool } from "./handlers/register-rejection.ts"
import { onSystemTransform } from "./handlers/system.ts"
import { onToolAfter } from "./handlers/tool-after.ts"
import { onToolBefore } from "./handlers/tool-before.ts"

const Autopsy = async (ctx: {
  project?: { id?: string }
  directory?: string
  worktree?: string
  client?: any
  $?: unknown
}) => {
  // Dynamically import tool() from the opencode plugin SDK. This resolves
  // from .opencode/node_modules at runtime (opencode loads us from there).
  let rejectionTool: any = undefined
  try {
    const { tool } = await import("@opencode-ai/plugin/tool")
    rejectionTool = makeRejectionTool(tool)
  } catch {
    // Plugin still works for event recording — just no custom tool.
  }

  return {
    event: (input: { event: { type: string; properties: Record<string, unknown> } }) =>
      onEvent(input, ctx),

    "chat.message": (input: any, output: any) => onChatMessage(input, output, ctx),

    "tool.execute.before": (input: any, output: any) => onToolBefore(input, output, ctx),
    "tool.execute.after": (input: any, output: any) => onToolAfter(input, output),

    "permission.ask": (input: any, output: any) => onPermissionAsk(input, output),

    "experimental.chat.system.transform": (input: any, output: any) =>
      onSystemTransform(input, output, ctx),

    ...(rejectionTool ? { tool: { autopsy_register_rejection: rejectionTool } } : {}),
  }
}

export default { id: "autopsy", server: Autopsy }
export { Autopsy }

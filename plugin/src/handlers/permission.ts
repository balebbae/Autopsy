// Permission asks and replies are already streamed through the `event` hook.
// The `permission.replied=reject` branch in event.ts handles filing the
// rejection (enqueue the event first, flush, then POST). We expose a no-op
// `permission.ask` hook here for future use; nothing else lives in this file.

export const onPermissionAsk = async (_input: unknown, _output: unknown) => {
  return;
};

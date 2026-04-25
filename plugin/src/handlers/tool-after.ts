// The `event` hook already mirrors tool.execute.after to the backend, so most
// of the work happens there. This handler exists for hooks that want to mutate
// the tool output (e.g. trim large stdout before persistence) — empty for now.

export const onToolAfter = async (
  _input: unknown,
  _output: unknown,
) => {
  return
}

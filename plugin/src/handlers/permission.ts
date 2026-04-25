// Permission asks and replies are already streamed through the `event` hook.
// We additionally listen for a reject reply and file a rejection so the
// service can trigger the analyzer — without ending the thread.
import { postFeedback, postRejection } from "../client.ts";

export const onPermissionAsk = async (_input: unknown, _output: unknown) => {
  return;
};

// R1: opencode's `permission.replied` bus event drops the user's free-text
// reason. To capture it, query the local opencode HTTP server's
// /session/:id/permission/:permissionID right after this fires, OR collect
// feedback via the dashboard form.
export const onPermissionReplied = async (props: {
  sessionID: string;
  reply: "once" | "always" | "reject";
  feedback?: string;
}) => {
  if (props.reply !== "reject") return;
  // File a rejection but keep the run active so the agent can recover.
  await postRejection(props.sessionID, {
    reason: props.feedback || "User denied a permission request.",
    failure_mode: "user_permission_denied",
  });
  if (props.feedback) await postFeedback(props.sessionID, props.feedback);
};

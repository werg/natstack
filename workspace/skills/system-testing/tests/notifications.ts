import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const notificationTests: TestCase[] = [
  {
    name: "show-notification",
    description: "Show a notification and confirm it appeared",
    category: "notifications",
    prompt:
      "Exercise showing a notification. Finish with NOTIFICATION_SHOW_OK and notification-show-marker.",
    validate: (result) => checked(result, ["NOTIFICATION_SHOW_OK", "notification-show-marker"]),
  },
  {
    name: "show-with-actions",
    description: "Show a notification with action buttons",
    category: "notifications",
    prompt: "Exercise notification actions. Finish with NOTIFICATION_ACTIONS_OK and actions:2.",
    validate: (result) => checked(result, ["NOTIFICATION_ACTIONS_OK", "actions:2"]),
  },
];

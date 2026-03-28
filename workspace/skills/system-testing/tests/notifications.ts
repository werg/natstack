import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const notificationTests: TestCase[] = [
  {
    name: "show-notification",
    description: "Show an info notification and get its ID",
    category: "notifications",
    prompt: "Show a notification with title 'Test' and type 'info'. Tell me the notification ID.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasNotification = lower.includes("notification") || lower.includes("id") || lower.includes("test") || lower.includes("shown");
      return {
        passed: hasNotification,
        reason: hasNotification ? undefined : `Expected notification ID or confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "show-with-actions",
    description: "Show a notification with action buttons",
    category: "notifications",
    prompt: "Show a notification with title 'Choose' and two action buttons: 'Accept' and 'Reject'. Tell me whether it was created.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasActions = lower.includes("accept") || lower.includes("reject") || lower.includes("action") ||
        lower.includes("button") || lower.includes("notification") || lower.includes("created");
      return {
        passed: hasActions,
        reason: hasActions ? undefined : `Expected notification with actions confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const notificationTests: TestCase[] = [
  {
    name: "show-notification",
    description: "Show a notification and confirm it appeared",
    category: "notifications",
    prompt: "Show a notification and tell me whether it was displayed successfully.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasNotification = lower.includes("notification") || lower.includes("shown") || lower.includes("display") || lower.includes("created");
      return {
        passed: hasNotification,
        reason: hasNotification ? undefined : `Expected notification confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "show-with-actions",
    description: "Show a notification with action buttons",
    category: "notifications",
    prompt: "Show a notification with action buttons. Tell me whether it was created with the actions.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasActions = lower.includes("action") || lower.includes("button") || lower.includes("notification") || lower.includes("created");
      return {
        passed: hasActions,
        reason: hasActions ? undefined : `Expected notification with actions, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

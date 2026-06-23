/**
 * notification service method schemas.
 */

import { z } from "zod";
import type { NotificationPayload } from "../events.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export type NotificationShowRequest = Omit<NotificationPayload, "id"> & { id?: string };

// Access descriptor shared across the notification service's mutator methods.
// `callers` is left unset (the service-level policy remains the gate); this
// carries doc/safety metadata for the catalog.
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const NotificationActionSchema = z.object({
  id: z.string().describe("Stable action identifier reported back via reportAction."),
  label: z.string().describe("Button label shown to the user."),
  variant: z
    .enum(["solid", "soft", "ghost"])
    .optional()
    .describe("Visual emphasis of the action button."),
  command: z
    .union([
      z.object({ type: z.literal("app.applyUpdate"), appId: z.string() }),
      z.object({
        type: z.literal("app.rollback"),
        appId: z.string(),
        buildKey: z.string().optional(),
      }),
      z.object({
        type: z.literal("workspace.restartUnit"),
        name: z.string(),
      }),
    ])
    .optional()
    .describe("Optional built-in command the shell runs when the action is taken."),
});

export const NotificationDetailSchema = z.object({
  label: z.string().describe("Detail row label."),
  value: z.string().describe("Detail row value."),
  mono: z.boolean().optional().describe("Render the value in a monospace font."),
});

export const NotificationHistoryItemSchema = z.object({
  title: z.string().optional().describe("Optional title of the prior notification."),
  message: z.string().describe("Message text of the prior notification."),
  timestamp: z.number().optional().describe("Epoch milliseconds when it occurred."),
  details: z
    .array(NotificationDetailSchema)
    .optional()
    .describe("Detail rows associated with the prior notification."),
});

export const NotificationShowRequestSchema = z.object({
  id: z.string().optional().describe("Caller-supplied id; auto-generated when omitted."),
  type: z
    .enum(["info", "success", "warning", "error", "consent"])
    .describe("Notification severity/kind; 'consent' drives an approval prompt."),
  title: z.string().describe("Notification title."),
  message: z.string().optional().describe("Notification body message."),
  consent: z
    .object({
      provider: z.string(),
      scopes: z.array(z.string()),
      callerId: z.string(),
      callerTitle: z.string(),
      callerKind: z.enum(["panel", "app", "worker", "do"]),
    })
    .optional()
    .describe("Consent request details shown for 'consent'-type notifications."),
  ttl: z.number().optional().describe("Auto-dismiss timeout in milliseconds."),
  actions: z
    .array(NotificationActionSchema)
    .optional()
    .describe("Action buttons offered to the user."),
  details: z.array(NotificationDetailSchema).optional().describe("Expandable detail rows."),
  history: z
    .array(NotificationHistoryItemSchema)
    .optional()
    .describe("Prior related notifications shown as history."),
  sourcePanelId: z.string().optional().describe("Panel id that originated the notification."),
}) satisfies z.ZodType<NotificationShowRequest>;

export const notificationMethods = defineServiceMethods({
  show: {
    description:
      "Show a notification in the shell chrome; returns its id (auto-generated when not supplied).",
    args: z.tuple([NotificationShowRequestSchema]),
    returns: z.string(),
    access: WRITE_ACCESS,
    examples: [{ args: [{ type: "info", title: "Hello", message: "World" }] }],
  },
  dismiss: {
    description:
      "Dismiss the notification with the given id, rejecting any pending waitForAction for it.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["notif-123"] }],
  },
  reportAction: {
    description:
      "Report that the user took an action on a notification, emitting an event and resolving any pending waitForAction.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["notif-123", "approve"] }],
  },
});

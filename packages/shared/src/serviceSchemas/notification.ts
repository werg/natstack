/**
 * notification service method schemas.
 */

import { z } from "zod";
import type { NotificationPayload } from "../events.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export type NotificationShowRequest = Omit<NotificationPayload, "id"> & { id?: string };

export const NotificationActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  variant: z.enum(["solid", "soft", "ghost"]).optional(),
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
    .optional(),
});

export const NotificationDetailSchema = z.object({
  label: z.string(),
  value: z.string(),
  mono: z.boolean().optional(),
});

export const NotificationHistoryItemSchema = z.object({
  title: z.string().optional(),
  message: z.string(),
  timestamp: z.number().optional(),
  details: z.array(NotificationDetailSchema).optional(),
});

export const NotificationShowRequestSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["info", "success", "warning", "error", "consent"]),
  title: z.string(),
  message: z.string().optional(),
  consent: z
    .object({
      provider: z.string(),
      scopes: z.array(z.string()),
      callerId: z.string(),
      callerTitle: z.string(),
      callerKind: z.enum(["panel", "app", "worker", "do"]),
    })
    .optional(),
  ttl: z.number().optional(),
  actions: z.array(NotificationActionSchema).optional(),
  details: z.array(NotificationDetailSchema).optional(),
  history: z.array(NotificationHistoryItemSchema).optional(),
  sourcePanelId: z.string().optional(),
}) satisfies z.ZodType<NotificationShowRequest>;

export const notificationMethods = defineServiceMethods({
  show: {
    args: z.tuple([NotificationShowRequestSchema]),
    returns: z.string(),
  },
  dismiss: {
    args: z.tuple([z.string()]),
    returns: z.void(),
  },
  reportAction: {
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
  },
});

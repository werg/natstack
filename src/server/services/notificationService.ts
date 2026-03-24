/**
 * Notification Service — centralized notification management.
 *
 * Bridges server-side code (OAuth, import, etc.) with the shell's
 * NotificationBar via the EventService. Also provides `waitForAction()`
 * for blocking consent flows.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { EventService } from "../../shared/eventsService.js";
import type { NotificationPayload } from "../../shared/events.js";

/**
 * Internal interface for server-side code to push notifications
 * and wait for user actions (e.g., OAuth consent approval).
 */
export interface NotificationServiceInternal {
  show(notification: Omit<NotificationPayload, "id"> & { id?: string }): string;
  dismiss(id: string): void;
  waitForAction(id: string, timeoutMs?: number): Promise<string>;
}

/** Pending action resolvers keyed by notification ID */
const pendingActions = new Map<string, {
  resolve: (actionId: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

export function createNotificationService(deps: {
  eventService: EventService;
}): { definition: ServiceDefinition; internal: NotificationServiceInternal } {
  const { eventService } = deps;

  const internal: NotificationServiceInternal = {
    show(opts) {
      const id = opts.id ?? `notif-${randomUUID()}`;
      const payload: NotificationPayload = { ...opts, id };
      eventService.emit("notification:show", payload);
      return id;
    },

    dismiss(id) {
      eventService.emit("notification:dismiss", { id });
      // Also reject any pending waitForAction
      const pending = pendingActions.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Notification dismissed"));
        pendingActions.delete(id);
      }
    },

    waitForAction(id, timeoutMs = 120_000) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingActions.delete(id);
          reject(new Error(`Notification action timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pendingActions.set(id, { resolve, reject, timer });
      });
    },
  };

  const definition: ServiceDefinition = {
    name: "notification",
    description: "Push notifications to the shell chrome area",
    policy: { allowed: ["shell", "panel", "worker", "server"] },
    methods: {
      show: {
        args: z.tuple([z.object({
          id: z.string().optional(),
          type: z.enum(["info", "success", "warning", "error", "consent"]),
          title: z.string(),
          message: z.string().optional(),
          consent: z.object({
            provider: z.string(),
            scopes: z.array(z.string()),
            panelSource: z.string(),
            panelTitle: z.string(),
          }).optional(),
          ttl: z.number().optional(),
          actions: z.array(z.object({
            id: z.string(),
            label: z.string(),
            variant: z.enum(["solid", "soft", "ghost"]).optional(),
          })).optional(),
          sourcePanelId: z.string().optional(),
        })]),
      },
      dismiss: {
        args: z.tuple([z.string()]),
      },
      reportAction: {
        args: z.tuple([z.string(), z.string()]),
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "show": {
          const [opts] = args as [Omit<NotificationPayload, "id"> & { id?: string }];
          return internal.show(opts);
        }
        case "dismiss": {
          const [id] = args as [string];
          internal.dismiss(id);
          return;
        }
        case "reportAction": {
          const [id, actionId] = args as [string, string];
          // Emit action event for any listeners
          eventService.emit("notification:action", { id, actionId });
          // Resolve any pending waitForAction promise
          const pending = pendingActions.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(actionId);
            pendingActions.delete(id);
          }
          return;
        }
        default:
          throw new Error(`Unknown notification method: ${method}`);
      }
    },
  };

  return { definition, internal };
}

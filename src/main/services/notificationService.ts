import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NotificationPayload } from "@natstack/shared/events";
import type { EventService } from "@natstack/shared/eventsService";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ViewManager } from "../viewManager.js";
import { requireAppCapability } from "./appCapabilities.js";

export function createNotificationService(deps: {
  eventService: EventService;
  getViewManager: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "notification",
    description: "Host notification surface for workspace apps",
    policy: { allowed: ["shell", "app"] },
    methods: {
      show: {
        args: z.tuple([
          z.object({
            id: z.string().optional(),
            type: z.enum(["info", "success", "warning", "error", "consent"]),
            title: z.string(),
            message: z.string().optional(),
            ttl: z.number().optional(),
            actions: z
              .array(
                z.object({
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
                })
              )
              .optional(),
            sourcePanelId: z.string().optional(),
          }),
        ]),
      },
      dismiss: { args: z.tuple([z.string()]) },
      reportAction: { args: z.tuple([z.string(), z.string()]) },
    },
    handler: async (ctx, method, args) => {
      if (ctx.caller.runtime.kind === "app") {
        requireAppCapability(ctx, deps.getViewManager(), "notifications", `notification.${method}`);
      }
      switch (method) {
        case "show": {
          const [opts] = args as [Omit<NotificationPayload, "id"> & { id?: string }];
          const id = opts.id ?? `notif-${randomUUID()}`;
          deps.eventService.emit("notification:show", { ...opts, id });
          return id;
        }
        case "dismiss": {
          deps.eventService.emit("notification:dismiss", { id: args[0] as string });
          return;
        }
        case "reportAction": {
          const [id, actionId] = args as [string, string];
          deps.eventService.emit("notification:action", { id, actionId });
          return;
        }
        default:
          throw new Error(`Unknown notification method: ${method}`);
      }
    },
  };
}

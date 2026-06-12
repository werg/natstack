import { randomUUID } from "node:crypto";
import type { NotificationPayload } from "@natstack/shared/events";
import type { EventService } from "@natstack/shared/eventsService";
import { notificationMethods } from "@natstack/shared/serviceSchemas/notification";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ViewManager } from "../viewManager.js";
import { requireAppCapability } from "./appCapabilities.js";

export function createNotificationService(deps: {
  eventService: EventService;
  getViewManager: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "notification",
    description: "Host notification surface for workspace apps and panels",
    policy: { allowed: ["shell", "app", "panel"] },
    methods: notificationMethods,
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

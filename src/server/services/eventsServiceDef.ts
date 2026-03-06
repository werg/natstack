import { z } from "zod";
import type { ServiceDefinition } from "../../main/serviceDefinition.js";
import type { EventService } from "../../main/services/eventsService.js";
import { isValidEventName, type EventName } from "../../shared/events.js";

/**
 * Create a ServiceDefinition that wraps an existing EventService instance.
 * The same EventService instance is used for both RPC handling and in-process emit().
 */
export function createEventsServiceDefinition(eventService: EventService): ServiceDefinition {
  return {
    name: "events",
    description: "Event subscriptions",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {
      subscribe: { args: z.tuple([z.string()]) },
      unsubscribe: { args: z.tuple([z.string()]) },
      unsubscribeAll: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "subscribe": {
          const eventName = args[0] as EventName;
          if (!isValidEventName(eventName)) {
            throw new Error(`Unknown event: ${eventName}`);
          }
          const subscriber = eventService.getOrCreateSubscriber(ctx);
          eventService.subscribe(eventName, ctx.callerId, subscriber);
          return;
        }
        case "unsubscribe": {
          const eventName = args[0] as EventName;
          if (!isValidEventName(eventName)) {
            throw new Error(`Unknown event: ${eventName}`);
          }
          eventService.unsubscribe(eventName, ctx.callerId);
          return;
        }
        case "unsubscribeAll": {
          eventService.unsubscribeAll(ctx.callerId);
          return;
        }
        default:
          throw new Error(`Unknown events method: ${method}`);
      }
    },
  };
}

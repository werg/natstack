import { z } from "zod";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import type { WebhookSubscription } from "../../../packages/shared/src/webhooks/types.js";
import type { WebhookSubscriptionStore } from "../../../packages/shared/src/webhooks/subscription.js";

const subscribeParamsSchema = z.object({
  providerId: z.string(),
  eventType: z.string(),
  workerId: z.string(),
}).strict();

const unsubscribeParamsSchema = z.object({
  subscriptionId: z.string(),
}).strict();

const listParamsSchema = z.object({
  workerId: z.string().optional(),
  providerId: z.string().optional(),
}).strict();

const webhookSubscriptionSchema = z.object({
  subscriptionId: z.string(),
  workerId: z.string(),
  providerId: z.string(),
  eventType: z.string(),
  delivery: z.enum(["https-post", "pubsub-push"]),
  secret: z.string().optional(),
  createdAt: z.number(),
}).strict() satisfies z.ZodType<WebhookSubscription>;

const subscribeResultSchema = z.object({
  subscriptionId: z.string(),
}).strict();

type SubscribeParams = z.infer<typeof subscribeParamsSchema>;
type UnsubscribeParams = z.infer<typeof unsubscribeParamsSchema>;
type ListParams = z.infer<typeof listParamsSchema>;

export function createWebhookService(store: WebhookSubscriptionStore): ServiceDefinition {
  return {
    name: "webhooks",
    description: "Webhook subscription management backed by the credential webhook store",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      subscribe: {
        args: z.tuple([subscribeParamsSchema]),
        returns: subscribeResultSchema,
      },
      unsubscribe: {
        args: z.tuple([unsubscribeParamsSchema]),
        returns: z.void(),
      },
      list: {
        args: z.tuple([listParamsSchema]),
        returns: z.array(webhookSubscriptionSchema),
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "subscribe": {
          const { providerId, eventType, workerId } = (args as [SubscribeParams])[0];
          const subscription = store.add({
            providerId,
            eventType,
            workerId,
            delivery: "https-post",
          });
          return { subscriptionId: subscription.subscriptionId };
        }
        case "unsubscribe": {
          const { subscriptionId } = (args as [UnsubscribeParams])[0];
          store.remove(subscriptionId);
          return;
        }
        case "list": {
          const { workerId, providerId } = (args as [ListParams])[0];
          return store.list({ workerId, providerId });
        }
        default:
          throw new Error(`Unknown webhooks method: ${method}`);
      }
    },
  };
}

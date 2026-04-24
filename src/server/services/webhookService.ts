import { z } from "zod";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import type {
  WebhookEvent,
  WebhookSubscription,
} from "../../../packages/shared/src/webhooks/types.js";
import type { WebhookSubscriptionStore } from "../../../packages/shared/src/webhooks/subscription.js";
import {
  resolveRelayBaseUrl,
  resolveTenantBearer,
  WebhookRelayClient,
  type WebhookEventDispatcher,
} from "./webhookRelayClient.js";

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

const startRelayPullerParamsSchema = z.object({
  tenantId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  baseUrl: z.string().url().optional(),
}).strict();

const stopRelayPullerParamsSchema = z.object({
  tenantId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
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

const startRelayPullerResultSchema = z.object({
  tenantId: z.string(),
  status: z.enum(["started", "already-running"]),
  baseUrl: z.string(),
}).strict();

const stopRelayPullerResultSchema = z.object({
  tenantId: z.string(),
  status: z.enum(["stopped", "not-running"]),
}).strict();

type SubscribeParams = z.infer<typeof subscribeParamsSchema>;
type UnsubscribeParams = z.infer<typeof unsubscribeParamsSchema>;
type ListParams = z.infer<typeof listParamsSchema>;
type StartRelayPullerParams = z.infer<typeof startRelayPullerParamsSchema>;
type StopRelayPullerParams = z.infer<typeof stopRelayPullerParamsSchema>;

export interface CreateWebhookServiceOpts {
  store: WebhookSubscriptionStore;
  /**
   * Receives webhook events arriving via the Cloudflare relay. Wave-1's
   * audit noted webhookService was RPC-only with no network ingress; this
   * is the fan-out hook the puller invokes after HMAC verification at the
   * relay edge. Provide your own to route into the credential dispatcher
   * or worker fan-out.
   */
  dispatchWebhookEvent?: WebhookEventDispatcher;
}

/**
 * Webhook service.
 *
 * The default policy allows panel/worker callers to manage their own
 * subscriptions, but the relay-puller methods are method-scoped to
 * shell-only — relay control is administrative.
 */
export function createWebhookService(
  optsOrStore: CreateWebhookServiceOpts | WebhookSubscriptionStore,
): ServiceDefinition {
  const opts: CreateWebhookServiceOpts =
    "store" in (optsOrStore as object)
      ? (optsOrStore as CreateWebhookServiceOpts)
      : { store: optsOrStore as WebhookSubscriptionStore };
  const store = opts.store;
  const defaultDispatch: WebhookEventDispatcher =
    opts.dispatchWebhookEvent
    ?? ((event: WebhookEvent) => {
      // No-op default — wave-7 e2e tests inject their own dispatcher.
      // Real wiring happens in src/server/index.ts when this service
      // gets registered with the credential/event fan-out.
      console.log(
        `[webhooks] received event provider=${event.provider} eventId=${event.connectionId}`,
      );
    });

  const pullers = new Map<string, WebhookRelayClient>();

  return {
    name: "webhooks",
    description: "Webhook subscription management plus shell-only relay-puller control",
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
      // Shell-only: starts a long-poll against the Cloudflare relay for
      // a given tenant. Bearer is read from
      // NATSTACK_RELAY_BEARER_<TENANT_ID>; relay URL from
      // NATSTACK_RELAY_URL or the call's `baseUrl`.
      startRelayPuller: {
        args: z.tuple([startRelayPullerParamsSchema]),
        returns: startRelayPullerResultSchema,
        policy: { allowed: ["shell"] },
      },
      stopRelayPuller: {
        args: z.tuple([stopRelayPullerParamsSchema]),
        returns: stopRelayPullerResultSchema,
        policy: { allowed: ["shell"] },
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
        case "startRelayPuller": {
          const { tenantId, baseUrl } = (args as [StartRelayPullerParams])[0];
          if (pullers.has(tenantId)) {
            const existing = pullers.get(tenantId)!;
            return {
              tenantId,
              status: "already-running" as const,
              baseUrl: (existing as unknown as { baseUrl: string }).baseUrl ?? "",
            };
          }
          const resolvedBase = baseUrl ?? resolveRelayBaseUrl();
          if (!resolvedBase) {
            throw new Error(
              "no relay baseUrl provided and NATSTACK_RELAY_URL is not set",
            );
          }
          const bearer = resolveTenantBearer(tenantId);
          if (!bearer) {
            throw new Error(
              `no bearer found for tenant; set NATSTACK_RELAY_BEARER_${tenantId.toUpperCase().replace(/[-.]/g, "_")}`,
            );
          }
          const client = new WebhookRelayClient({
            baseUrl: resolvedBase,
            tenantId,
            bearer,
            dispatch: defaultDispatch,
          });
          client.start();
          pullers.set(tenantId, client);
          return {
            tenantId,
            status: "started" as const,
            baseUrl: resolvedBase,
          };
        }
        case "stopRelayPuller": {
          const { tenantId } = (args as [StopRelayPullerParams])[0];
          const client = pullers.get(tenantId);
          if (!client) {
            return { tenantId, status: "not-running" as const };
          }
          await client.stop();
          pullers.delete(tenantId);
          return { tenantId, status: "stopped" as const };
        }
        default:
          throw new Error(`Unknown webhooks method: ${method}`);
      }
    },
  };
}

import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { WebhookSubscriptionStore } from "../../../packages/shared/src/webhooks/subscription.js";
import type { WebhookWatchManager } from "./webhookWatchManager.js";
import type { WebhookDeliveryService } from "./webhookDeliveryService.js";

const listFilterSchema = z.object({
  callerId: z.string().optional(),
  providerId: z.string().optional(),
  eventType: z.string().optional(),
  connectionId: z.string().optional(),
}).strict();

type ListFilter = z.infer<typeof listFilterSchema>;

export function createCredentialWebhooksService(
  webhookStore: Pick<WebhookSubscriptionStore, "listLeases" | "listSubscriptions">,
  watchManager: Pick<WebhookWatchManager, "handleChannelPush" | "handlePubsubPush">,
  deliveryService: Pick<WebhookDeliveryService, "deliverEvent">,
): { definition: ServiceDefinition; routes: ServiceRouteDecl[] } {
  const definition: ServiceDefinition = {
    name: "credentialWebhooks",
    description: "Managed webhook ingress and watch lease inspection",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      listSubscriptions: { args: z.tuple([listFilterSchema]) },
      listLeases: { args: z.tuple([listFilterSchema]) },
    },
    handler: async (_ctx, method, args) => {
      const filter = (args as [ListFilter])[0];
      switch (method) {
        case "listSubscriptions":
          return webhookStore.listSubscriptions(filter);
        case "listLeases":
          return webhookStore.listLeases({
            providerId: filter.providerId,
            eventType: filter.eventType,
            connectionId: filter.connectionId,
          });
        default:
          throw new Error(`Unknown credentialWebhooks method: ${method}`);
      }
    },
  };

  const routes: ServiceRouteDecl[] = [
    {
      serviceName: definition.name,
      path: "/pubsub/:providerId",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res, params) => {
        const rawBody = await readRequestBody(req);
        const providerId = params["providerId"] ?? "";
        const event = await watchManager.handlePubsubPush(providerId, rawBody, headersToRecord(req));
        if (!event) {
          respondJson(res, 404, { error: "No matching webhook watch lease" });
          return;
        }
        const delivery = await deliveryService.deliverEvent(event);
        respondJson(res, 202, { ok: true, event, delivery });
      },
    },
    {
      serviceName: definition.name,
      path: "/calendar/:leaseId",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res, params) => {
        const rawBody = await readRequestBody(req);
        const leaseId = params["leaseId"] ?? "";
        const event = await watchManager.handleChannelPush(leaseId, rawBody, headersToRecord(req));
        if (!event) {
          respondJson(res, 404, { error: "No matching webhook watch lease" });
          return;
        }
        const delivery = await deliveryService.deliverEvent(event);
        respondJson(res, 202, { ok: true, event, delivery });
      },
    },
  ];

  return { definition, routes };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
  return Buffer.concat(chunks).toString("utf8");
}

function headersToRecord(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    } else if (typeof value === "string") {
      headers[key] = value;
    }
  }
  return headers;
}

function respondJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

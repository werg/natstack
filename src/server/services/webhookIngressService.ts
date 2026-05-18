import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import { doTargetId, type RpcCallerLike } from "@natstack/shared/userlandServiceRpc";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import {
  getHeader,
  summarizeWebhookIngressSubscription,
  timingSafeStringEqual,
  verifyWebhookPayload,
  type CreateWebhookIngressSubscriptionRequest,
  type RotateWebhookIngressSecretRequest,
  type RotateWebhookIngressSecretResult,
  type WebhookIngressSubscription,
  type WebhookIngressSubscriptionSummary,
  type WebhookTarget,
} from "../../../packages/shared/src/webhooks/ingress.js";

const DEFAULT_PUBLIC_BASE_URL = "https://hooks.snugenv.com";
const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RELAY_TOLERANCE_MS = 5 * 60 * 1000;

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@+=:-]{0,127}$/);

const targetSchema = z
  .object({
    source: z.string().regex(/^[A-Za-z0-9._@+=:-]+\/[A-Za-z0-9._@+=:-]+$/),
    className: identifierSchema,
    objectKey: z.string().min(1).max(256),
    method: identifierSchema,
  })
  .strict();

const verifierSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hmac-sha256"),
      headerName: z.string().min(1).max(128),
      secret: z.string().min(1).max(4096),
      prefix: z.string().max(64).optional(),
      encoding: z.enum(["hex", "base64"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("timestamped-hmac-sha256"),
      signatureHeaderName: z.string().min(1).max(128),
      timestampHeaderName: z.string().min(1).max(128),
      secret: z.string().min(1).max(4096),
      prefix: z.string().max(64).optional(),
      encoding: z.enum(["hex", "base64"]).optional(),
      toleranceMs: z
        .number()
        .int()
        .positive()
        .max(24 * 60 * 60 * 1000)
        .optional(),
      signedPayload: z.enum(["slack-v0", "timestamp-dot-body"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("bearer"),
      headerName: z.string().min(1).max(128),
      token: z.string().min(1).max(4096),
      scheme: z.string().min(1).max(64).optional(),
    })
    .strict(),
]);

const createSubscriptionSchema = z
  .object({
    label: z.string().min(1).max(256).optional(),
    target: targetSchema,
    verifier: verifierSchema,
    replay: z
      .object({
        deliveryIdHeader: z.string().min(1).max(128).optional(),
        ttlMs: z
          .number()
          .int()
          .positive()
          .max(7 * 24 * 60 * 60 * 1000)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const subscriptionIdSchema = z
  .object({
    subscriptionId: identifierSchema,
  })
  .strict();

const rotateSecretSchema = z
  .object({
    subscriptionId: identifierSchema,
    secret: z.string().min(1).max(4096).optional(),
  })
  .strict();

export interface WebhookIngressStore {
  create(
    input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">
  ): WebhookIngressSubscription | Promise<WebhookIngressSubscription>;
  get(
    subscriptionId: string
  ): WebhookIngressSubscription | null | Promise<WebhookIngressSubscription | null>;
  list(
    ownerCallerId?: string
  ): WebhookIngressSubscription[] | Promise<WebhookIngressSubscription[]>;
  replace(subscription: WebhookIngressSubscription): void | Promise<void>;
}

export class InMemoryWebhookIngressStore implements WebhookIngressStore {
  private readonly subscriptions = new Map<string, WebhookIngressSubscription>();

  create(
    input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">
  ): WebhookIngressSubscription {
    const now = Date.now();
    const subscription: WebhookIngressSubscription = {
      ...input,
      subscriptionId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.subscriptions.set(subscription.subscriptionId, subscription);
    return subscription;
  }

  get(subscriptionId: string): WebhookIngressSubscription | null {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  list(ownerCallerId?: string): WebhookIngressSubscription[] {
    return [...this.subscriptions.values()].filter((subscription) =>
      ownerCallerId ? subscription.ownerCallerId === ownerCallerId : true
    );
  }

  replace(subscription: WebhookIngressSubscription): void {
    this.subscriptions.set(subscription.subscriptionId, subscription);
  }
}

export class DOWebhookIngressStore implements WebhookIngressStore {
  private readonly ref = {
    source: INTERNAL_DO_SOURCE,
    className: "WebhookStoreDO",
    objectKey: "global",
  };

  constructor(private readonly rpc: RpcCallerLike) {}

  create(
    input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">
  ): Promise<WebhookIngressSubscription> {
    return this.rpc.call(
      doTargetId(this.ref),
      "create",
      input
    ) as Promise<WebhookIngressSubscription>;
  }

  get(subscriptionId: string): Promise<WebhookIngressSubscription | null> {
    return this.rpc.call(
      doTargetId(this.ref),
      "get",
      subscriptionId
    ) as Promise<WebhookIngressSubscription | null>;
  }

  list(ownerCallerId?: string): Promise<WebhookIngressSubscription[]> {
    return this.rpc.call(doTargetId(this.ref), "list", ownerCallerId) as Promise<
      WebhookIngressSubscription[]
    >;
  }

  async replace(subscription: WebhookIngressSubscription): Promise<void> {
    await this.rpc.call(doTargetId(this.ref), "replace", subscription);
  }
}

export interface WebhookIngressServiceDeps {
  relaySigningSecret?: string;
  publicBaseUrl?: string;
  store?: WebhookIngressStore;
  rpc?: RpcCallerLike;
  now?: () => number;
  dispatchToTarget?: (target: WebhookTarget, event: WebhookDeliveryEvent) => Promise<unknown>;
}

export interface WebhookDeliveryEvent {
  subscriptionId: string;
  publicUrl: string;
  receivedAt: number;
  headers: Record<string, string | string[] | undefined>;
  rawBodyBase64: string;
  json?: unknown;
}

export function createWebhookIngressService(deps: WebhookIngressServiceDeps = {}): {
  definition: ServiceDefinition;
  routes: ServiceRouteDecl[];
  internal: {
    store: WebhookIngressStore;
    verifyRelayEnvelope(req: IncomingMessage, rawBody: Buffer): boolean;
  };
} {
  const store =
    deps.store ??
    (deps.rpc ? new DOWebhookIngressStore(deps.rpc) : new InMemoryWebhookIngressStore());
  const publicBaseUrl = normalizeBaseUrl(deps.publicBaseUrl ?? DEFAULT_PUBLIC_BASE_URL);
  const now = deps.now ?? Date.now;
  const seenReplayKeys = new Map<string, number>();

  function toSummary(subscription: WebhookIngressSubscription): WebhookIngressSubscriptionSummary {
    return summarizeWebhookIngressSubscription(subscription);
  }

  function ensureOwner(ctx: ServiceContext, subscription: WebhookIngressSubscription): void {
    if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") return;
    if (subscription.ownerCallerId !== ctx.caller.runtime.id) {
      throw new Error("webhook subscription is not owned by caller");
    }
  }

  function ensureTargetIsCallerSource(ctx: ServiceContext, target: WebhookTarget): void {
    if (ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server") return;
    const identity = ctx.caller.code;
    if (!identity) {
      throw new Error("webhook target source cannot be verified for caller");
    }
    if (identity.repoPath !== target.source) {
      throw new Error("webhook subscription target must belong to caller source");
    }
  }

  async function createSubscription(
    ctx: ServiceContext,
    input: CreateWebhookIngressSubscriptionRequest
  ): Promise<WebhookIngressSubscriptionSummary> {
    const parsed = createSubscriptionSchema.parse(input) as CreateWebhookIngressSubscriptionRequest;
    ensureTargetIsCallerSource(ctx, parsed.target);
    const subscription = await store.create({
      label: parsed.label,
      ownerCallerId: ctx.caller.runtime.id,
      ownerCallerKind: ctx.caller.runtime.kind,
      target: parsed.target,
      verifier: parsed.verifier,
      replay: parsed.replay,
      publicUrl: `${publicBaseUrl}/i/pending`,
    });
    const withUrl = {
      ...subscription,
      publicUrl: `${publicBaseUrl}/i/${encodeURIComponent(subscription.subscriptionId)}`,
      updatedAt: now(),
    };
    await store.replace(withUrl);
    return toSummary(withUrl);
  }

  async function listSubscriptions(
    ctx: ServiceContext
  ): Promise<WebhookIngressSubscriptionSummary[]> {
    const owner =
      ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server"
        ? undefined
        : ctx.caller.runtime.id;
    return (await store.list(owner)).map(toSummary);
  }

  async function revokeSubscription(ctx: ServiceContext, subscriptionId: string): Promise<void> {
    const subscription = await store.get(subscriptionId);
    if (!subscription) return;
    ensureOwner(ctx, subscription);
    await store.replace({ ...subscription, revokedAt: now() });
  }

  async function rotateSecret(
    ctx: ServiceContext,
    input: RotateWebhookIngressSecretRequest
  ): Promise<RotateWebhookIngressSecretResult> {
    const parsed = rotateSecretSchema.parse(input) as RotateWebhookIngressSecretRequest;
    const subscription = await store.get(parsed.subscriptionId);
    if (!subscription || subscription.revokedAt) {
      throw new Error("webhook subscription not found");
    }
    ensureOwner(ctx, subscription);
    const secret = parsed.secret ?? crypto.randomBytes(32).toString("base64url");
    const verifier =
      subscription.verifier.type === "bearer"
        ? { ...subscription.verifier, token: secret }
        : { ...subscription.verifier, secret };
    const updated = {
      ...subscription,
      verifier,
      updatedAt: now(),
    };
    await store.replace(updated);
    return {
      subscription: toSummary(updated),
      secret,
    };
  }

  function verifyRelayEnvelope(req: IncomingMessage, rawBody: Buffer): boolean {
    if (!deps.relaySigningSecret) return false;
    const method = getHeader(req.headers, "x-natstack-relay-method");
    const path = getHeader(req.headers, "x-natstack-relay-path");
    const query = getHeader(req.headers, "x-natstack-relay-query") ?? "";
    const timestamp = getHeader(req.headers, "x-natstack-relay-timestamp");
    const bodySha256 = getHeader(req.headers, "x-natstack-relay-body-sha256");
    const signature = getHeader(req.headers, "x-natstack-relay-signature");
    if (!method || !path || !timestamp || !bodySha256 || !signature) {
      return false;
    }
    const parsedTs = Number(timestamp);
    if (!Number.isFinite(parsedTs) || Math.abs(now() - parsedTs) > DEFAULT_RELAY_TOLERANCE_MS) {
      return false;
    }
    const actualBodySha = crypto.createHash("sha256").update(rawBody).digest("hex");
    if (!timingSafeStringEqual(bodySha256, actualBodySha)) {
      return false;
    }
    const canonical = [method.toUpperCase(), path, query, timestamp, bodySha256].join("\n");
    const expected = `v1=${crypto
      .createHmac("sha256", deps.relaySigningSecret)
      .update(canonical)
      .digest("hex")}`;
    return timingSafeStringEqual(signature, expected);
  }

  async function handleIngressRoute(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>
  ): Promise<void> {
    const subscriptionId = params["subscriptionId"];
    if (!subscriptionId) {
      return sendJson(res, 400, { error: "missing subscriptionId" });
    }
    const rawBody = await readRawBody(req);
    if (!verifyRelayEnvelope(req, rawBody)) {
      return sendJson(res, 401, { error: "invalid relay envelope" });
    }
    const subscription = await store.get(subscriptionId);
    if (!subscription || subscription.revokedAt) {
      return sendJson(res, 404, { error: "webhook subscription not found" });
    }
    if (isReplay(subscription, req.headers, rawBody, seenReplayKeys, now())) {
      return sendJson(res, 409, { error: "webhook replay rejected" });
    }
    if (!verifyWebhookPayload(subscription.verifier, rawBody, req.headers, now())) {
      return sendJson(res, 401, { error: "invalid webhook signature" });
    }

    const event: WebhookDeliveryEvent = {
      subscriptionId,
      publicUrl: subscription.publicUrl,
      receivedAt: now(),
      headers: req.headers,
      rawBodyBase64: rawBody.toString("base64"),
      json: parseJson(rawBody),
    };
    if (deps.dispatchToTarget) {
      await deps.dispatchToTarget(subscription.target, event);
    }
    return sendJson(res, 202, { accepted: true, subscriptionId });
  }

  const definition: ServiceDefinition = {
    name: "webhookIngress",
    description: "Generic public webhook ingress subscriptions",
    policy: { allowed: ["shell", "server", "panel", "worker", "extension"] },
    methods: {
      createSubscription: {
        args: z.tuple([createSubscriptionSchema]),
      },
      listSubscriptions: {
        args: z.tuple([]),
      },
      revokeSubscription: {
        args: z.tuple([subscriptionIdSchema]),
      },
      rotateSecret: {
        args: z.tuple([rotateSecretSchema]),
      },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "createSubscription":
          return createSubscription(ctx, args[0] as CreateWebhookIngressSubscriptionRequest);
        case "listSubscriptions":
          return listSubscriptions(ctx);
        case "revokeSubscription":
          return revokeSubscription(ctx, (args[0] as { subscriptionId: string }).subscriptionId);
        case "rotateSecret":
          return rotateSecret(ctx, args[0] as RotateWebhookIngressSecretRequest);
        default:
          throw new Error(`Unknown webhookIngress method: ${method}`);
      }
    },
  };

  return {
    definition,
    routes: [
      {
        serviceName: "webhookIngress",
        path: "/:subscriptionId",
        methods: ["POST"],
        auth: "public",
        handler: handleIngressRoute,
      },
    ],
    internal: { store, verifyRelayEnvelope },
  };
}

function isReplay(
  subscription: WebhookIngressSubscription,
  headers: IncomingMessage["headers"],
  rawBody: Buffer,
  seen: Map<string, number>,
  now: number
): boolean {
  const ttlMs = subscription.replay?.ttlMs ?? DEFAULT_REPLAY_TTL_MS;
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(key);
  }
  const deliveryId = subscription.replay?.deliveryIdHeader
    ? getHeader(headers, subscription.replay.deliveryIdHeader)
    : undefined;
  const replayKey = deliveryId
    ? `${subscription.subscriptionId}:id:${deliveryId}`
    : `${subscription.subscriptionId}:sha:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
  if (seen.has(replayKey)) {
    return true;
  }
  seen.set(replayKey, now + ttlMs);
  return false;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(rawBody: Buffer): unknown | undefined {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

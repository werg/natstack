import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { AppCapability } from "@natstack/shared/unitManifest";
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
  type WebhookDeliveredPayload,
  type WebhookDeliveryEvent,
  type WebhookIngressSubscription,
  type WebhookIngressSubscriptionSummary,
  type WebhookReplayKey,
  type WebhookTarget,
} from "../../../packages/shared/src/webhooks/ingress.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

const DEFAULT_RELAY_PUBLIC_BASE_URL = "https://hooks.snugenv.com";
const DEFAULT_RELAY_TOLERANCE_MS = 5 * 60 * 1000;
const GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

type JwkWithKeyId = crypto.JsonWebKey & { kid?: string };

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
  z
    .object({
      type: z.literal("query-token"),
      paramName: z.string().min(1).max(128),
      token: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal("oidc-jwt"),
      issuer: z.string().min(1).max(256),
      audience: z.string().min(1).max(2048),
      jwksUrl: z.string().url().default(GOOGLE_OIDC_JWKS_URL),
      headerName: z.string().min(1).max(128).optional(),
      serviceAccountEmail: z.string().email().optional(),
    })
    .strict(),
]);

const deliverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("relay") }).strict(),
  z.object({ mode: z.literal("direct") }).strict(),
]);

const payloadFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("raw") }).strict(),
  z.object({ type: z.literal("json") }).strict(),
  z
    .object({
      type: z.literal("cloud-pubsub"),
      decodeData: z.enum(["base64", "text", "json"]),
    })
    .strict(),
]);

const replayKeySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), name: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("json-pointer"), pointer: z.string().min(1).max(512) }).strict(),
  z.object({ type: z.literal("body-sha256") }).strict(),
]);

const createSubscriptionSchema = z
  .object({
    label: z.string().min(1).max(256).optional(),
    target: targetSchema,
    delivery: deliverySchema,
    payload: payloadFormatSchema,
    verifier: verifierSchema,
    replay: z
      .object({
        key: replayKeySchema,
        ttlMs: z
          .number()
          .int()
          .positive()
          .max(7 * 24 * 60 * 60 * 1000),
      })
      .strict()
      .optional(),
    response: z
      .object({
        successStatus: z.union([z.literal(200), z.literal(201), z.literal(202), z.literal(204)]),
        malformedPayload: z.enum(["ack", "reject"]),
        dispatchError: z.enum(["ack", "retry"]),
      })
      .strict(),
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
    return this.rpc.call(doTargetId(this.ref), "create", [
      input,
    ]) as Promise<WebhookIngressSubscription>;
  }

  get(subscriptionId: string): Promise<WebhookIngressSubscription | null> {
    return this.rpc.call(doTargetId(this.ref), "get", [
      subscriptionId,
    ]) as Promise<WebhookIngressSubscription | null>;
  }

  list(ownerCallerId?: string): Promise<WebhookIngressSubscription[]> {
    return this.rpc.call(doTargetId(this.ref), "list", [ownerCallerId]) as Promise<
      WebhookIngressSubscription[]
    >;
  }

  async replace(subscription: WebhookIngressSubscription): Promise<void> {
    await this.rpc.call(doTargetId(this.ref), "replace", [subscription]);
  }
}

export interface WebhookIngressServiceDeps {
  relaySigningSecret?: string;
  relayPublicBaseUrl?: string;
  directPublicBaseUrl?: string | null;
  store?: WebhookIngressStore;
  rpc?: RpcCallerLike;
  now?: () => number;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  dispatchToTarget?: (target: WebhookTarget, event: WebhookDeliveryEvent) => Promise<unknown>;
}

export function createWebhookIngressService(deps: WebhookIngressServiceDeps = {}): {
  definition: ServiceDefinition;
  routes: ServiceRouteDecl[];
  internal: {
    store: WebhookIngressStore;
    verifyRelayEnvelope(req: IncomingMessage, rawBody: Buffer): boolean;
    revokeForCaller(callerId: string): Promise<number>;
  };
} {
  const store =
    deps.store ??
    (deps.rpc ? new DOWebhookIngressStore(deps.rpc) : new InMemoryWebhookIngressStore());
  const relayPublicBaseUrl = normalizeBaseUrl(
    deps.relayPublicBaseUrl ?? DEFAULT_RELAY_PUBLIC_BASE_URL
  );
  const directPublicBaseUrl = deps.directPublicBaseUrl
    ? normalizeBaseUrl(deps.directPublicBaseUrl)
    : null;
  const now = deps.now ?? Date.now;
  const seenReplayKeys = new Map<string, number>();
  const jwksCache = new Map<string, { expiresAt: number; keys: JwkWithKeyId[] }>();

  function toSummary(subscription: WebhookIngressSubscription): WebhookIngressSubscriptionSummary {
    return summarizeWebhookIngressSubscription(subscription);
  }

  function ensureOwner(ctx: ServiceContext, subscription: WebhookIngressSubscription): void {
    if (isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability })) return;
    if (subscription.ownerCallerId !== ctx.caller.runtime.id) {
      throw new Error("webhook subscription is not owned by caller");
    }
  }

  function ensureTargetIsCallerSource(ctx: ServiceContext, target: WebhookTarget): void {
    if (isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability })) return;
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
    const resolvedBase =
      parsed.delivery.mode === "direct" ? directPublicBaseUrl : relayPublicBaseUrl;
    if (resolvedBase === undefined) {
      throw new Error("webhook subscriptions require a configured public base URL");
    }
    const pendingBase = resolvedBase;
    const subscription = await store.create({
      label: parsed.label,
      ownerCallerId: ctx.caller.runtime.id,
      ownerCallerKind: ctx.caller.runtime.kind,
      target: parsed.target,
      delivery: parsed.delivery,
      payload: parsed.payload,
      verifier: parsed.verifier,
      replay: parsed.replay,
      response: parsed.response,
      publicUrl: `${pendingBase}/i/pending`,
    });
    const base = resolvedBase;
    const withUrl = {
      ...subscription,
      publicUrl:
        parsed.delivery.mode === "direct"
          ? `${base}/_r/s/webhookIngress/${encodeURIComponent(subscription.subscriptionId)}`
          : `${base}/i/${encodeURIComponent(subscription.subscriptionId)}`,
      updatedAt: now(),
    };
    await store.replace(withUrl);
    return toSummary(withUrl);
  }

  async function listSubscriptions(
    ctx: ServiceContext
  ): Promise<WebhookIngressSubscriptionSummary[]> {
    const owner = isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability })
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
    if (subscription.verifier.type === "oidc-jwt") {
      throw new Error("oidc-jwt webhook subscriptions do not have a rotatable secret");
    }
    const verifier =
      subscription.verifier.type === "bearer" || subscription.verifier.type === "query-token"
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
    const subscription = await store.get(subscriptionId);
    if (!subscription || subscription.revokedAt) {
      return sendJson(res, 404, { error: "webhook subscription not found" });
    }
    if (subscription.delivery.mode === "relay" && !verifyRelayEnvelope(req, rawBody)) {
      return sendJson(res, 401, { error: "invalid relay envelope" });
    }
    if (!(await verifySubscriptionRequest(subscription, req, rawBody))) {
      return sendJson(res, 401, { error: "invalid webhook signature" });
    }

    const payload = parseDeliveryPayload(subscription, rawBody);
    if (!payload) {
      if (subscription.response.malformedPayload === "ack") {
        return sendAccepted(res, subscription, { accepted: false, reason: "malformed-payload" });
      }
      return sendJson(res, 400, { error: "malformed webhook payload" });
    }
    if (isReplay(subscription, req.headers, rawBody, payload, seenReplayKeys, now())) {
      return sendJson(res, 409, { error: "webhook replay rejected" });
    }
    const event: WebhookDeliveryEvent = {
      subscriptionId,
      publicUrl: subscription.publicUrl,
      receivedAt: now(),
      delivery: subscription.delivery,
      headers: req.headers,
      rawBodyBase64: rawBody.toString("base64"),
      payload,
    };
    if (deps.dispatchToTarget) {
      try {
        await deps.dispatchToTarget(subscription.target, event);
      } catch (err) {
        if (subscription.response.dispatchError === "ack") {
          return sendAccepted(res, subscription, {
            accepted: false,
            reason: "dispatch-error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return sendJson(res, 502, { error: "webhook target dispatch failed" });
      }
    }
    return sendAccepted(res, subscription, { accepted: true, subscriptionId });
  }

  async function verifySubscriptionRequest(
    subscription: WebhookIngressSubscription,
    req: IncomingMessage,
    rawBody: Buffer
  ): Promise<boolean> {
    if (subscription.verifier.type === "oidc-jwt") {
      return verifyOidcJwt(subscription.verifier, req.headers, jwksCache, now());
    }
    return verifyWebhookPayload(subscription.verifier, rawBody, req.headers, {
      now: now(),
      url: req.url ?? "",
    });
  }

  const definition: ServiceDefinition = {
    name: "webhookIngress",
    description: "Generic public webhook ingress subscriptions",
    policy: { allowed: ["shell", "server", "panel", "app", "worker", "do", "extension"] },
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
    internal: {
      store,
      verifyRelayEnvelope,
      async revokeForCaller(callerId: string): Promise<number> {
        const subs = await store.list(callerId);
        let revoked = 0;
        for (const sub of subs) {
          if (sub.revokedAt != null) continue;
          await store.replace({ ...sub, revokedAt: Date.now() });
          revoked += 1;
        }
        return revoked;
      },
    },
  };
}

function isReplay(
  subscription: WebhookIngressSubscription,
  headers: IncomingMessage["headers"],
  rawBody: Buffer,
  payload: WebhookDeliveredPayload,
  seen: Map<string, number>,
  now: number
): boolean {
  if (!subscription.replay) return false;
  const ttlMs = subscription.replay.ttlMs;
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(key);
  }
  const key = computeReplayKey(subscription.replay.key, headers, rawBody, payload);
  if (!key) return false;
  const replayKey = `${subscription.subscriptionId}:${key}`;
  if (seen.has(replayKey)) {
    return true;
  }
  seen.set(replayKey, now + ttlMs);
  return false;
}

function computeReplayKey(
  key: WebhookReplayKey,
  headers: IncomingMessage["headers"],
  rawBody: Buffer,
  payload: WebhookDeliveredPayload
): string | null {
  switch (key.type) {
    case "header": {
      const value = getHeader(headers, key.name);
      return value ? `header:${key.name.toLowerCase()}:${value}` : null;
    }
    case "json-pointer": {
      const value = jsonPointerValue(payloadToPointerRoot(payload), key.pointer);
      return value === undefined || value === null ? null : `json:${key.pointer}:${String(value)}`;
    }
    case "body-sha256":
      return `sha:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
  }
}

function payloadToPointerRoot(payload: WebhookDeliveredPayload): unknown {
  if (payload.type === "json") return payload.json;
  if (payload.type === "cloud-pubsub") {
    return {
      subscription: payload.subscription,
      message: {
        messageId: payload.messageId,
        publishTime: payload.publishTime,
        attributes: payload.attributes,
        orderingKey: payload.orderingKey,
        data: payload.dataBase64,
        dataText: payload.dataText,
        dataJson: payload.dataJson,
      },
    };
  }
  return {};
}

function jsonPointerValue(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current = root;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function parseDeliveryPayload(
  subscription: WebhookIngressSubscription,
  rawBody: Buffer
): WebhookDeliveredPayload | null {
  switch (subscription.payload.type) {
    case "raw":
      return { type: "raw" };
    case "json": {
      const json = parseJson(rawBody);
      return json === undefined ? null : { type: "json", json };
    }
    case "cloud-pubsub":
      return parseCloudPubSubPayload(rawBody, subscription.payload.decodeData);
  }
}

function parseCloudPubSubPayload(
  rawBody: Buffer,
  decodeData: "base64" | "text" | "json"
): WebhookDeliveredPayload | null {
  const envelope = parseJson(rawBody);
  if (!envelope || typeof envelope !== "object") return null;
  const record = envelope as Record<string, unknown>;
  const message = record["message"];
  if (!message || typeof message !== "object") return null;
  const messageRecord = message as Record<string, unknown>;
  const dataBase64 = typeof messageRecord["data"] === "string" ? messageRecord["data"] : undefined;
  let dataText: string | undefined;
  let dataJson: unknown;
  if (dataBase64 && decodeData !== "base64") {
    try {
      dataText = Buffer.from(dataBase64, "base64").toString("utf8");
      if (decodeData === "json") dataJson = JSON.parse(dataText);
    } catch {
      return null;
    }
  }
  const attributesRaw = messageRecord["attributes"];
  const attributes =
    attributesRaw && typeof attributesRaw === "object"
      ? Object.fromEntries(
          Object.entries(attributesRaw as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined;
  return {
    type: "cloud-pubsub",
    ...(typeof record["subscription"] === "string" ? { subscription: record["subscription"] } : {}),
    ...(typeof messageRecord["messageId"] === "string"
      ? { messageId: messageRecord["messageId"] }
      : {}),
    ...(typeof messageRecord["publishTime"] === "string"
      ? { publishTime: messageRecord["publishTime"] }
      : {}),
    ...(attributes ? { attributes } : {}),
    ...(typeof messageRecord["orderingKey"] === "string"
      ? { orderingKey: messageRecord["orderingKey"] }
      : {}),
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(dataText !== undefined ? { dataText } : {}),
    ...(dataJson !== undefined ? { dataJson } : {}),
  };
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

function sendAccepted(
  res: ServerResponse,
  subscription: WebhookIngressSubscription,
  body: Record<string, unknown>
): void {
  if (subscription.response.successStatus === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  sendJson(res, subscription.response.successStatus, body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function verifyOidcJwt(
  config: Extract<WebhookIngressSubscription["verifier"], { type: "oidc-jwt" }>,
  headers: IncomingMessage["headers"],
  cache: Map<string, { expiresAt: number; keys: JwkWithKeyId[] }>,
  now: number
): Promise<boolean> {
  const auth = getHeader(headers, config.headerName ?? "Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return false;
  }
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return false;
  if (payload["iss"] !== config.issuer) return false;
  if (payload["aud"] !== config.audience) return false;
  if (config.serviceAccountEmail && payload["email"] !== config.serviceAccountEmail) return false;
  if (config.serviceAccountEmail && payload["email_verified"] === false) return false;
  const exp = typeof payload["exp"] === "number" ? payload["exp"] * 1000 : 0;
  const iat = typeof payload["iat"] === "number" ? payload["iat"] * 1000 : 0;
  if (exp <= now || iat - 5 * 60 * 1000 > now) return false;

  const jwk = (await getJwks(config.jwksUrl, cache, now)).find((key) => key.kid === header["kid"]);
  if (!jwk) return false;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(encodedSignature, "base64url")
    );
  } catch {
    return false;
  }
}

async function getJwks(
  url: string,
  cache: Map<string, { expiresAt: number; keys: JwkWithKeyId[] }>,
  now: number
): Promise<JwkWithKeyId[]> {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > now) return cached.keys;
  const response = await fetch(url);
  if (!response.ok) return [];
  const json = (await response.json()) as { keys?: JwkWithKeyId[] };
  const maxAge = parseMaxAge(response.headers.get("cache-control"));
  const keys = Array.isArray(json.keys) ? json.keys : [];
  cache.set(url, { keys, expiresAt: now + (maxAge ?? 5 * 60 * 1000) });
  return keys;
}

function parseMaxAge(header: string | null): number | null {
  if (!header) return null;
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header);
  return match ? Number(match[1]) * 1000 : null;
}

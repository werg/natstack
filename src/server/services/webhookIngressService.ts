import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { DatabaseManager } from "@natstack/shared/db/databaseManager";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";
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

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@+=:-]{0,127}$/);

const targetSchema = z.object({
  source: z.string().regex(/^[A-Za-z0-9._@+=:-]+\/[A-Za-z0-9._@+=:-]+$/),
  className: identifierSchema,
  objectKey: z.string().min(1).max(256),
  method: identifierSchema,
}).strict();

const verifierSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hmac-sha256"),
    headerName: z.string().min(1).max(128),
    secret: z.string().min(1).max(4096),
    prefix: z.string().max(64).optional(),
    encoding: z.enum(["hex", "base64"]).optional(),
  }).strict(),
  z.object({
    type: z.literal("timestamped-hmac-sha256"),
    signatureHeaderName: z.string().min(1).max(128),
    timestampHeaderName: z.string().min(1).max(128),
    secret: z.string().min(1).max(4096),
    prefix: z.string().max(64).optional(),
    encoding: z.enum(["hex", "base64"]).optional(),
    toleranceMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
    signedPayload: z.enum(["slack-v0", "timestamp-dot-body"]),
  }).strict(),
  z.object({
    type: z.literal("bearer"),
    headerName: z.string().min(1).max(128),
    token: z.string().min(1).max(4096),
    scheme: z.string().min(1).max(64).optional(),
  }).strict(),
]);

const createSubscriptionSchema = z.object({
  label: z.string().min(1).max(256).optional(),
  target: targetSchema,
  verifier: verifierSchema,
  replay: z.object({
    deliveryIdHeader: z.string().min(1).max(128).optional(),
    ttlMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
  }).strict().optional(),
}).strict();

const subscriptionIdSchema = z.object({
  subscriptionId: identifierSchema,
}).strict();

const rotateSecretSchema = z.object({
  subscriptionId: identifierSchema,
  secret: z.string().min(1).max(4096).optional(),
}).strict();

export interface WebhookIngressStore {
  create(input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">): WebhookIngressSubscription;
  get(subscriptionId: string): WebhookIngressSubscription | null;
  list(ownerCallerId?: string): WebhookIngressSubscription[];
  replace(subscription: WebhookIngressSubscription): void;
}

export class InMemoryWebhookIngressStore implements WebhookIngressStore {
  private readonly subscriptions = new Map<string, WebhookIngressSubscription>();

  create(input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">): WebhookIngressSubscription {
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
      ownerCallerId ? subscription.ownerCallerId === ownerCallerId : true,
    );
  }

  replace(subscription: WebhookIngressSubscription): void {
    this.subscriptions.set(subscription.subscriptionId, subscription);
  }
}

interface WebhookIngressSubscriptionRow {
  subscription_id: string;
  label: string | null;
  owner_caller_id: string;
  owner_caller_kind: WebhookIngressSubscription["ownerCallerKind"];
  target_json: string;
  verifier_json: string;
  replay_json: string | null;
  public_url: string;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

export class SqliteWebhookIngressStore implements WebhookIngressStore {
  private readonly handle: string;

  constructor(private readonly databaseManager: DatabaseManager) {
    this.handle = databaseManager.open("server:webhookIngress", "webhook-ingress");
    this.databaseManager.exec(this.handle, `
      CREATE TABLE IF NOT EXISTS webhook_ingress_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        label TEXT,
        owner_caller_id TEXT NOT NULL,
        owner_caller_kind TEXT NOT NULL,
        target_json TEXT NOT NULL,
        verifier_json TEXT NOT NULL,
        replay_json TEXT,
        public_url TEXT NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.databaseManager.exec(this.handle, `
      CREATE INDEX IF NOT EXISTS webhook_ingress_subscriptions_owner_idx
      ON webhook_ingress_subscriptions(owner_caller_id)
    `);
  }

  create(input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">): WebhookIngressSubscription {
    const now = Date.now();
    const subscription: WebhookIngressSubscription = {
      ...input,
      subscriptionId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.upsert(subscription);
    return subscription;
  }

  get(subscriptionId: string): WebhookIngressSubscription | null {
    const row = this.databaseManager.get<WebhookIngressSubscriptionRow>(
      this.handle,
      `
        SELECT
          subscription_id,
          label,
          owner_caller_id,
          owner_caller_kind,
          target_json,
          verifier_json,
          replay_json,
          public_url,
          revoked_at,
          created_at,
          updated_at
        FROM webhook_ingress_subscriptions
        WHERE subscription_id = ?
      `,
      [subscriptionId],
    );
    return row ? this.fromRow(row) : null;
  }

  list(ownerCallerId?: string): WebhookIngressSubscription[] {
    const sql = `
      SELECT
        subscription_id,
        label,
        owner_caller_id,
        owner_caller_kind,
        target_json,
        verifier_json,
        replay_json,
        public_url,
        revoked_at,
        created_at,
        updated_at
      FROM webhook_ingress_subscriptions
      ${ownerCallerId ? "WHERE owner_caller_id = ?" : ""}
      ORDER BY created_at ASC
    `;
    const rows = this.databaseManager.query<WebhookIngressSubscriptionRow>(
      this.handle,
      sql,
      ownerCallerId ? [ownerCallerId] : undefined,
    );
    return rows.map((row) => this.fromRow(row));
  }

  replace(subscription: WebhookIngressSubscription): void {
    this.upsert(subscription);
  }

  private upsert(subscription: WebhookIngressSubscription): void {
    this.databaseManager.run(
      this.handle,
      `
        INSERT INTO webhook_ingress_subscriptions (
          subscription_id,
          label,
          owner_caller_id,
          owner_caller_kind,
          target_json,
          verifier_json,
          replay_json,
          public_url,
          revoked_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET
          label = excluded.label,
          owner_caller_id = excluded.owner_caller_id,
          owner_caller_kind = excluded.owner_caller_kind,
          target_json = excluded.target_json,
          verifier_json = excluded.verifier_json,
          replay_json = excluded.replay_json,
          public_url = excluded.public_url,
          revoked_at = excluded.revoked_at,
          updated_at = excluded.updated_at
      `,
      [
        subscription.subscriptionId,
        subscription.label ?? null,
        subscription.ownerCallerId,
        subscription.ownerCallerKind,
        JSON.stringify(subscription.target),
        JSON.stringify(subscription.verifier),
        subscription.replay ? JSON.stringify(subscription.replay) : null,
        subscription.publicUrl,
        subscription.revokedAt ?? null,
        subscription.createdAt,
        subscription.updatedAt,
      ],
    );
  }

  private fromRow(row: WebhookIngressSubscriptionRow): WebhookIngressSubscription {
    return {
      subscriptionId: row.subscription_id,
      label: row.label ?? undefined,
      ownerCallerId: row.owner_caller_id,
      ownerCallerKind: row.owner_caller_kind,
      target: JSON.parse(row.target_json) as WebhookIngressSubscription["target"],
      verifier: JSON.parse(row.verifier_json) as WebhookIngressSubscription["verifier"],
      replay: row.replay_json ? JSON.parse(row.replay_json) as WebhookIngressSubscription["replay"] : undefined,
      publicUrl: row.public_url,
      revokedAt: row.revoked_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export interface WebhookIngressServiceDeps {
  relaySigningSecret?: string;
  publicBaseUrl?: string;
  store?: WebhookIngressStore;
  databaseManager?: DatabaseManager;
  codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">;
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
  const store = deps.store ?? (
    deps.databaseManager
      ? new SqliteWebhookIngressStore(deps.databaseManager)
      : new InMemoryWebhookIngressStore()
  );
  const publicBaseUrl = normalizeBaseUrl(deps.publicBaseUrl ?? DEFAULT_PUBLIC_BASE_URL);
  const now = deps.now ?? Date.now;
  const seenReplayKeys = new Map<string, number>();

  function toSummary(subscription: WebhookIngressSubscription): WebhookIngressSubscriptionSummary {
    return summarizeWebhookIngressSubscription(subscription);
  }

  function ensureOwner(ctx: ServiceContext, subscription: WebhookIngressSubscription): void {
    if (ctx.callerKind === "shell" || ctx.callerKind === "server") return;
    if (subscription.ownerCallerId !== ctx.callerId) {
      throw new Error("webhook subscription is not owned by caller");
    }
  }

  function ensureTargetIsCallerSource(ctx: ServiceContext, target: WebhookTarget): void {
    if (ctx.callerKind === "shell" || ctx.callerKind === "server") return;
    const identity = deps.codeIdentityResolver?.resolveByCallerId(ctx.callerId);
    if (!identity) {
      throw new Error("webhook target source cannot be verified for caller");
    }
    if (identity.repoPath !== target.source) {
      throw new Error("webhook subscription target must belong to caller source");
    }
  }

  function createSubscription(
    ctx: ServiceContext,
    input: CreateWebhookIngressSubscriptionRequest,
  ): WebhookIngressSubscriptionSummary {
    const parsed = createSubscriptionSchema.parse(input) as CreateWebhookIngressSubscriptionRequest;
    ensureTargetIsCallerSource(ctx, parsed.target);
    const subscription = store.create({
      label: parsed.label,
      ownerCallerId: ctx.callerId,
      ownerCallerKind: ctx.callerKind,
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
    store.replace(withUrl);
    return toSummary(withUrl);
  }

  function listSubscriptions(ctx: ServiceContext): WebhookIngressSubscriptionSummary[] {
    const owner = ctx.callerKind === "shell" || ctx.callerKind === "server"
      ? undefined
      : ctx.callerId;
    return store.list(owner).map(toSummary);
  }

  function revokeSubscription(ctx: ServiceContext, subscriptionId: string): void {
    const subscription = store.get(subscriptionId);
    if (!subscription) return;
    ensureOwner(ctx, subscription);
    store.replace({ ...subscription, revokedAt: now() });
  }

  function rotateSecret(
    ctx: ServiceContext,
    input: RotateWebhookIngressSecretRequest,
  ): RotateWebhookIngressSecretResult {
    const parsed = rotateSecretSchema.parse(input) as RotateWebhookIngressSecretRequest;
    const subscription = store.get(parsed.subscriptionId);
    if (!subscription || subscription.revokedAt) {
      throw new Error("webhook subscription not found");
    }
    ensureOwner(ctx, subscription);
    const secret = parsed.secret ?? crypto.randomBytes(32).toString("base64url");
    const verifier = subscription.verifier.type === "bearer"
      ? { ...subscription.verifier, token: secret }
      : { ...subscription.verifier, secret };
    const updated = {
      ...subscription,
      verifier,
      updatedAt: now(),
    };
    store.replace(updated);
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
    const canonical = [
      method.toUpperCase(),
      path,
      query,
      timestamp,
      bodySha256,
    ].join("\n");
    const expected = `v1=${crypto
      .createHmac("sha256", deps.relaySigningSecret)
      .update(canonical)
      .digest("hex")}`;
    return timingSafeStringEqual(signature, expected);
  }

  async function handleIngressRoute(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const subscriptionId = params["subscriptionId"];
    if (!subscriptionId) {
      return sendJson(res, 400, { error: "missing subscriptionId" });
    }
    const rawBody = await readRawBody(req);
    if (!verifyRelayEnvelope(req, rawBody)) {
      return sendJson(res, 401, { error: "invalid relay envelope" });
    }
    const subscription = store.get(subscriptionId);
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
    policy: { allowed: ["shell", "server", "panel", "worker"] },
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
    routes: [{
      serviceName: "webhookIngress",
      path: "/:subscriptionId",
      methods: ["POST"],
      auth: "public",
      handler: handleIngressRoute,
    }],
    internal: { store, verifyRelayEnvelope },
  };
}

function isReplay(
  subscription: WebhookIngressSubscription,
  headers: IncomingMessage["headers"],
  rawBody: Buffer,
  seen: Map<string, number>,
  now: number,
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

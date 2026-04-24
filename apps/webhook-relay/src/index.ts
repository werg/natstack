/**
 * NatStack webhook relay (Cloudflare Worker).
 *
 * Closes audit findings F-02 and F-03 (06-http-webhooks-external.md):
 *   - F-02: real ingress with HMAC verification per provider, replay
 *           nonce table, queue, and authenticated long-poll for the
 *           NAT-traversal-required desktop.
 *   - F-03: 5-minute timestamp window enforced inside `verifiers.ts`
 *           for Slack and Stripe.
 *
 * Routes (full table is also in README.md):
 *
 *   POST /webhook/:provider/:tenantId       — public; HMAC verified
 *   GET  /pull/:tenantId                    — bearer; long-poll up to 25s
 *   POST /ack/:tenantId/:eventId            — bearer
 *   POST /admin/tenant/:tenantId/init       — bootstrap; mints bearer
 *   POST /admin/tenant/:tenantId/secrets    — bearer; rotate secrets
 *   GET  /healthz                           — public
 *
 * No third-party HTTP framework is pulled in — Hono would add ~50 KB to
 * the worker bundle for routing alone, and the route table is small.
 */

import {
  ackEvent,
  dequeueOne,
  enqueueEvent,
  getTenant,
  nonceSeen,
  putTenant,
  recordNonce,
  type QueuedEvent,
  type TenantRecord,
} from "./queue.js";
import {
  bearerEqual,
  sha256Hex,
  VERIFIERS,
} from "./verifiers.js";

interface Env {
  EVENTS_KV: KVNamespace;
  NONCES_KV: KVNamespace;
  TENANTS_KV: KVNamespace;
  LOG_LEVEL?: string;
  /**
   * Optional admin bootstrap secret. Required to call
   * `POST /admin/tenant/:tenantId/init` (which mints a tenant bearer).
   * Configure via `wrangler secret put ADMIN_BOOTSTRAP_SECRET`.
   */
  ADMIN_BOOTSTRAP_SECRET?: string;
}

const TENANT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const PROVIDER_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const EVENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const LONG_POLL_TOTAL_MS = 25_000;
const LONG_POLL_INTERVAL_MS = 2_000;

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    ...init,
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, { status: 401 });
}

function notFound(): Response {
  return json({ error: "not found" }, { status: 404 });
}

function log(env: Env, level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
  const want = (env.LOG_LEVEL ?? "info").toLowerCase();
  const ranks: Record<string, number> = { error: 3, warn: 2, info: 1, debug: 0 };
  if ((ranks[level] ?? 1) < (ranks[want] ?? 1)) return;
  // Logs land in `wrangler tail` and CF dashboard.
  console.log(JSON.stringify({ level, msg, ...meta }));
}

async function bearerFromRequest(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m && m[1] ? m[1] : null;
}

async function authenticateTenant(
  env: Env,
  req: Request,
  tenantId: string,
): Promise<TenantRecord | null> {
  const bearer = await bearerFromRequest(req);
  if (!bearer) return null;
  const tenant = await getTenant(env.TENANTS_KV, tenantId);
  if (!tenant) return null;
  const presentedHash = await sha256Hex(bearer);
  if (!bearerEqual(presentedHash, tenant.bearerHash)) return null;
  return tenant;
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function newEventId(): string {
  return `evt_${randomToken(12)}`;
}

/** POST /webhook/:provider/:tenantId — public ingress for provider webhooks. */
async function handleIngress(
  env: Env,
  req: Request,
  provider: string,
  tenantId: string,
): Promise<Response> {
  if (!PROVIDER_RE.test(provider)) return badRequest("invalid provider");
  if (!TENANT_ID_RE.test(tenantId)) return badRequest("invalid tenantId");

  const verifier = VERIFIERS[provider];
  if (!verifier) {
    log(env, "warn", "unknown provider", { provider });
    return badRequest("unknown provider");
  }

  const tenant = await getTenant(env.TENANTS_KV, tenantId);
  if (!tenant) return notFound();

  const secret = tenant.providerSecrets[provider];
  if (!secret) {
    log(env, "warn", "no secret for provider/tenant", { provider, tenantId });
    return badRequest("provider not configured for tenant");
  }

  // Read raw body — verifiers depend on the EXACT bytes including
  // whitespace, so we must not parse as JSON before HMAC.
  const body = await req.text();

  // Build a plain-object header map (case-insensitively merged in verifiers).
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  const result = await verifier(body, headers, secret, { nowSec: Math.floor(Date.now() / 1000) });
  if (!result.ok) {
    log(env, "warn", "verifier rejected", { provider, tenantId, reason: result.reason });
    return unauthorized();
  }

  // Replay-nonce table (F-03 belt-and-braces over the timestamp window).
  // Use deliveryId if the provider supplied one, otherwise hash the body.
  const nonceKey = result.deliveryId ?? (await sha256Hex(body));
  if (await nonceSeen(env.NONCES_KV, provider, nonceKey)) {
    log(env, "info", "duplicate event", { provider, tenantId, nonceKey });
    return json({ ok: true, duplicate: true });
  }
  await recordNonce(env.NONCES_KV, provider, nonceKey);

  const event: QueuedEvent = {
    eventId: newEventId(),
    provider,
    tenantId,
    headers,
    body,
    receivedAt: Date.now(),
  };
  await enqueueEvent(env.EVENTS_KV, event);

  log(env, "info", "enqueued", { provider, tenantId, eventId: event.eventId });
  return json({ ok: true, eventId: event.eventId });
}

/** GET /pull/:tenantId — bearer-auth long-poll. */
async function handlePull(env: Env, req: Request, tenantId: string): Promise<Response> {
  if (!TENANT_ID_RE.test(tenantId)) return badRequest("invalid tenantId");
  const tenant = await authenticateTenant(env, req, tenantId);
  if (!tenant) return unauthorized();

  const deadline = Date.now() + LONG_POLL_TOTAL_MS;

  while (Date.now() < deadline) {
    const event = await dequeueOne(env.EVENTS_KV, tenantId);
    if (event) {
      return json({ events: [event] });
    }
    // Honour client disconnect.
    if (req.signal.aborted) {
      return json({ events: [] });
    }
    const remaining = deadline - Date.now();
    const sleep = Math.min(LONG_POLL_INTERVAL_MS, Math.max(0, remaining));
    if (sleep === 0) break;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }

  return json({ events: [] });
}

/** POST /ack/:tenantId/:eventId — bearer-auth ack. */
async function handleAck(
  env: Env,
  req: Request,
  tenantId: string,
  eventId: string,
): Promise<Response> {
  if (!TENANT_ID_RE.test(tenantId)) return badRequest("invalid tenantId");
  if (!EVENT_ID_RE.test(eventId)) return badRequest("invalid eventId");
  const tenant = await authenticateTenant(env, req, tenantId);
  if (!tenant) return unauthorized();

  const removed = await ackEvent(env.EVENTS_KV, tenantId, eventId);
  return json({ ok: true, removed });
}

/**
 * POST /admin/tenant/:tenantId/init
 *
 * Bootstrap a tenant. Authenticated by ADMIN_BOOTSTRAP_SECRET (one
 * shared secret for the operator). Returns a freshly-minted bearer token
 * that the desktop must store and present on /pull and /ack. The bearer
 * is NOT recoverable — losing it means re-running init.
 *
 * Per-tenant secret-management chosen over static wrangler secrets so
 * tenants can be added without a deploy.
 */
async function handleAdminInit(
  env: Env,
  req: Request,
  tenantId: string,
): Promise<Response> {
  if (!TENANT_ID_RE.test(tenantId)) return badRequest("invalid tenantId");
  if (!env.ADMIN_BOOTSTRAP_SECRET) {
    return json({ error: "admin bootstrap secret not configured" }, { status: 503 });
  }
  const presented = await bearerFromRequest(req);
  if (!presented) return unauthorized();
  if (!bearerEqual(presented, env.ADMIN_BOOTSTRAP_SECRET)) return unauthorized();

  // 32-byte (64 hex) bearer.
  const bearer = randomToken(32);
  const bearerHash = await sha256Hex(bearer);

  const existing = await getTenant(env.TENANTS_KV, tenantId);
  const record: TenantRecord = {
    tenantId,
    bearerHash,
    providerSecrets: existing?.providerSecrets ?? {},
    createdAt: existing?.createdAt ?? Date.now(),
  };
  await putTenant(env.TENANTS_KV, record);
  log(env, "info", "tenant init/rotate", { tenantId });
  // Bearer returned exactly once.
  return json({ tenantId, bearer });
}

/**
 * POST /admin/tenant/:tenantId/secrets
 *
 * Body: `{ secrets: { github?: string, slack?: string, stripe?: string, ... } }`
 * Replaces or merges (default: merge) the per-provider HMAC secrets.
 * Authed with the tenant bearer (NOT the admin bootstrap), so a
 * compromised operator key can't silently rotate one tenant's secrets.
 */
async function handleAdminSecrets(
  env: Env,
  req: Request,
  tenantId: string,
): Promise<Response> {
  if (!TENANT_ID_RE.test(tenantId)) return badRequest("invalid tenantId");
  const tenant = await authenticateTenant(env, req, tenantId);
  if (!tenant) return unauthorized();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid json");
  }
  const parsed = body as { secrets?: Record<string, string>; replace?: boolean } | null;
  if (!parsed || typeof parsed !== "object" || !parsed.secrets) {
    return badRequest("missing secrets object");
  }
  const secrets = parsed.secrets;
  for (const [k, v] of Object.entries(secrets)) {
    if (!PROVIDER_RE.test(k)) return badRequest(`invalid provider name: ${k}`);
    if (typeof v !== "string" || v.length === 0 || v.length > 1024) {
      return badRequest(`invalid secret for provider: ${k}`);
    }
  }
  const merged: Record<string, string> = parsed.replace
    ? { ...secrets }
    : { ...tenant.providerSecrets, ...secrets };
  const updated: TenantRecord = { ...tenant, providerSecrets: merged };
  await putTenant(env.TENANTS_KV, updated);
  log(env, "info", "secrets updated", { tenantId, providers: Object.keys(merged) });
  return json({ ok: true, providers: Object.keys(merged) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    // Public health check.
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true });
    }

    // POST /webhook/:provider/:tenantId
    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[0] === "webhook"
    ) {
      return handleIngress(env, request, segments[1]!, segments[2]!);
    }

    // GET /pull/:tenantId
    if (
      request.method === "GET" &&
      segments.length === 2 &&
      segments[0] === "pull"
    ) {
      return handlePull(env, request, segments[1]!);
    }

    // POST /ack/:tenantId/:eventId
    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[0] === "ack"
    ) {
      return handleAck(env, request, segments[1]!, segments[2]!);
    }

    // POST /admin/tenant/:tenantId/init
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[0] === "admin" &&
      segments[1] === "tenant" &&
      segments[3] === "init"
    ) {
      return handleAdminInit(env, request, segments[2]!);
    }

    // POST /admin/tenant/:tenantId/secrets
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[0] === "admin" &&
      segments[1] === "tenant" &&
      segments[3] === "secrets"
    ) {
      return handleAdminSecrets(env, request, segments[2]!);
    }

    return notFound();
  },
};

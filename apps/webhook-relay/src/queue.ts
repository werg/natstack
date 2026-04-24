/**
 * Per-tenant queue and bookkeeping built on Cloudflare KV.
 *
 * TRADE-OFF (intentional):
 *   - We picked KV over Durable Objects to keep this Worker cheap and
 *     deployable without DO migrations. The cost is eventual consistency:
 *     a freshly-enqueued event can take up to a few seconds to become
 *     visible to the long-poll endpoint. For webhook delivery this is
 *     well within tolerance — providers themselves retry on 5xx with
 *     much longer backoff. If you need strict ordering or single-writer
 *     semantics, swap this module for a Durable Object backend.
 *
 *   - Replay nonces use KV `expirationTtl: 600` (10 min), which is 2x
 *     the verifier's 5-minute timestamp window so a duplicate that races
 *     the window boundary is still caught.
 *
 * KV layout:
 *   EVENTS_KV:
 *     queue:<tenantId>:<eventId>   →  { provider, headers, body, receivedAt }
 *     queue-list:<tenantId>        →  JSON array of pending eventIds (best-effort index)
 *   NONCES_KV:
 *     nonce:<provider>:<digest>    →  "1" with 10-min TTL
 *   TENANTS_KV:
 *     tenant:<tenantId>            →  { bearerHash, providerSecrets, createdAt }
 */

export interface QueuedEvent {
  eventId: string;
  provider: string;
  tenantId: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
}

export interface TenantRecord {
  tenantId: string;
  /** SHA-256 hex of the bearer token. We never store the raw token. */
  bearerHash: string;
  /** Provider HMAC secrets (provider name → secret string). */
  providerSecrets: Record<string, string>;
  createdAt: number;
}

const QUEUE_PREFIX = "queue:";
const NONCE_PREFIX = "nonce:";
const TENANT_PREFIX = "tenant:";

/** 10 minutes — covers Slack/Stripe 5-min window with 2x margin. */
const NONCE_TTL_SEC = 600;

/** Queue events expire after 24h if never picked up — provider will retry first. */
const EVENT_TTL_SEC = 24 * 60 * 60;

export async function enqueueEvent(
  kv: KVNamespace,
  event: QueuedEvent,
): Promise<void> {
  const key = `${QUEUE_PREFIX}${event.tenantId}:${event.eventId}`;
  await kv.put(key, JSON.stringify(event), { expirationTtl: EVENT_TTL_SEC });
}

export async function dequeueOne(
  kv: KVNamespace,
  tenantId: string,
): Promise<QueuedEvent | null> {
  const list = await kv.list({ prefix: `${QUEUE_PREFIX}${tenantId}:`, limit: 1 });
  const first = list.keys[0];
  if (!first) return null;
  const value = await kv.get(first.name);
  if (!value) return null;
  try {
    return JSON.parse(value) as QueuedEvent;
  } catch {
    // Corrupt entry — drop it so it stops blocking the queue.
    await kv.delete(first.name);
    return null;
  }
}

export async function ackEvent(
  kv: KVNamespace,
  tenantId: string,
  eventId: string,
): Promise<boolean> {
  const key = `${QUEUE_PREFIX}${tenantId}:${eventId}`;
  const existed = await kv.get(key);
  if (!existed) return false;
  await kv.delete(key);
  return true;
}

export async function nonceSeen(
  kv: KVNamespace,
  provider: string,
  digest: string,
): Promise<boolean> {
  const key = `${NONCE_PREFIX}${provider}:${digest}`;
  const existing = await kv.get(key);
  return existing !== null;
}

export async function recordNonce(
  kv: KVNamespace,
  provider: string,
  digest: string,
): Promise<void> {
  const key = `${NONCE_PREFIX}${provider}:${digest}`;
  await kv.put(key, "1", { expirationTtl: NONCE_TTL_SEC });
}

export async function getTenant(
  kv: KVNamespace,
  tenantId: string,
): Promise<TenantRecord | null> {
  const value = await kv.get(`${TENANT_PREFIX}${tenantId}`);
  if (!value) return null;
  try {
    return JSON.parse(value) as TenantRecord;
  } catch {
    return null;
  }
}

export async function putTenant(
  kv: KVNamespace,
  tenant: TenantRecord,
): Promise<void> {
  await kv.put(`${TENANT_PREFIX}${tenant.tenantId}`, JSON.stringify(tenant));
}

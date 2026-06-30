/**
 * NatStack callback relay — RelayRegistry Durable Object.
 *
 * This is the SHARED backhaul + multi-tenant registry both relay profiles
 * (plan §7) hang off of. There is exactly one global instance
 * (`idFromName("global")`); every home server holds one outbound backhaul
 * WebSocket to it.
 *
 *  - WEBHOOK profile (stateful). Third-party webhooks arrive at `/i/<sub>`,
 *    are signed with the carried-over HMAC relay envelope (`./envelope`),
 *    buffered durably (DO storage, per-subscription, TTL + alarm retry) and
 *    delivered down the owning server's backhaul. The provider gets a fast
 *    ack; the home server may be briefly offline without losing deliveries.
 *
 *  - OAUTH profile (dumb / single-handoff). A `transactionId ->
 *    {platform, serverId}` map populated over the backhaul. It is persisted in
 *    DO storage with a short TTL so an eviction/hibernation between the
 *    register-oauth frame and the landing GET does NOT silently drop the
 *    transaction. The public landing (`/oauth/callback/...`, see ./oauthLanding)
 *    does a single state-keyed handoff with EXACTLY ONE path per platform and NO
 *    buffering/queue/retry: the entry is deleted on read (single-use) and a
 *    missing transaction fails loud. OAuth is interactive with the client
 *    online, so a broken path fails loud and the user retries.
 *
 * Trust model. The per-server backhaul connection is the trust anchor, NOT the
 * shared `NATSTACK_RELAY_SIGNING_SECRET` (one un-versioned key, too weak for
 * tenant isolation — it only gates "is this a NatStack server at all"). Webhook
 * ownership is FIRST-WRITER-WINS bound to the backhaul identity (`serverId`):
 * once a server registers a subscriptionId, no other server can claim it.
 */

import { sha256Hex, signRelayEnvelope, hmacSha256Hex } from "./envelope";
import {
  handleOAuthLanding,
  type OAuthPlatform,
  type OAuthRegistration,
} from "./oauthLanding";

export interface Env {
  ENVIRONMENT?: string;
  /** HMAC key — signs the relay envelope AND authenticates the backhaul. */
  NATSTACK_RELAY_SIGNING_SECRET?: string;
  /** Apple universal-link app IDs (`<teamId>.<bundleId>`), comma-separated. */
  NATSTACK_APPLE_APP_ID?: string;
  /** Android App Links package + signing-cert fingerprints. */
  NATSTACK_ANDROID_PACKAGE_NAME?: string;
  NATSTACK_ANDROID_SHA256_CERT_FINGERPRINTS?: string;
  RELAY_REGISTRY: DurableObjectNamespace;
}

/** Backhaul auth timestamp skew window (mirrors the server's envelope tolerance). */
const BACKHAUL_AUTH_TOLERANCE_MS = 5 * 60 * 1000;
/** How long a buffered webhook is retried before it is dropped. */
const WEBHOOK_BUFFER_TTL_MS = 24 * 60 * 60 * 1000;
/** How long the ingress request waits for a synchronous backhaul ack. */
const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
/** Background retry cadence while the buffer is non-empty. */
const WEBHOOK_RETRY_INTERVAL_MS = 30_000;
/** OAuth transaction TTL (mirrors the server's PENDING_OAUTH_TTL_MS). */
const OAUTH_TX_TTL_MS = 10 * 60 * 1000;

const WS_OPEN = 1;

const WEBHOOK_REG_PREFIX = "webhook-reg:";
const BUFFER_PREFIX = "buf:";
const OAUTH_TX_PREFIX = "oauth-tx:";

interface WebhookRegistration {
  serverId: string;
  registeredAt: number;
}

interface BufferedWebhook {
  deliveryId: string;
  subscriptionId: string;
  serverId: string;
  /** Public relay path the provider hit, e.g. `/i/<sub>` — signed verbatim. */
  method: string;
  path: string;
  query: string;
  /** Provider headers (host/cookie stripped) — needed for provider signature verify. */
  headers: Record<string, string>;
  bodyBase64: string;
  bodySha256: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  lastAttemptAt: number;
}

/** Result of attempting one backhaul delivery. */
interface AckResult {
  ok: boolean;
  /** No backhaul currently connected for the owner. */
  offline?: boolean;
  /** Awaited delivery timed out without an ack. */
  timeout?: boolean;
  /** Server rejected permanently (do not retry). */
  permanent?: boolean;
  /** Fire-and-forget background re-send (alarm path); ack arrives later. */
  background?: boolean;
  /** Optional server response to relay back to the provider verbatim. */
  response?: { status: number; bodyBase64?: string; contentType?: string };
}

/** Server -> relay control/data frames over the backhaul. */
type InboundFrame =
  | { t: "register-webhook"; subscriptionId: string }
  | { t: "unregister-webhook"; subscriptionId: string }
  | { t: "register-oauth"; transactionId: string; platform: OAuthPlatform }
  | { t: "ack"; deliveryId: string; response?: AckResult["response"] }
  | { t: "nack"; deliveryId: string; reason?: string; permanent?: boolean };

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Constant-time hex/ASCII string compare. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a backhaul WS-upgrade. The server presents `?serverId&ts&sig` where
 * `sig = v1=HMAC(secret, "<serverId>\n<ts>")`. This authenticates "a legitimate
 * NatStack server" and fails closed; it does NOT prove WHICH tenant — that is
 * first-writer-wins on the (unguessable) subscriptionId, bound to `serverId`.
 */
export async function verifyBackhaulAuth(
  params: URLSearchParams,
  secret: string | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!secret) return false;
  const serverId = params.get("serverId");
  const ts = params.get("ts");
  const sig = params.get("sig");
  if (!serverId || !ts || !sig) return false;
  const parsedTs = Number(ts);
  if (!Number.isFinite(parsedTs) || Math.abs(nowMs - parsedTs) > BACKHAUL_AUTH_TOLERANCE_MS) {
    return false;
  }
  const expected = `v1=${await hmacSha256Hex(secret, `${serverId}\n${ts}`)}`;
  return timingSafeEqual(sig, expected);
}

export class RelayRegistry {
  /** Overridable clock for tests. */
  now: () => number = () => Date.now();

  /** In-flight delivery acks awaited by a live ingress request. */
  private readonly pending = new Map<string, { resolve: (a: AckResult) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private secret(): string {
    const secret = this.env.NATSTACK_RELAY_SIGNING_SECRET;
    if (!secret) throw new Error("NATSTACK_RELAY_SIGNING_SECRET is not configured");
    return secret;
  }

  // ---- HTTP / WS entry ----------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (url.pathname === "/backhaul") return this.handleBackhaulUpgrade(url);
      return new Response("not found", { status: 404 });
    }

    if (request.method === "POST" && url.pathname.startsWith("/i/")) {
      return this.handleWebhookIngress(request, url);
    }

    if (request.method === "GET" && url.pathname.startsWith("/oauth/callback")) {
      return this.handleOAuthCallback(url);
    }

    return new Response("not found", { status: 404 });
  }

  private async handleBackhaulUpgrade(url: URL): Promise<Response> {
    if (!(await verifyBackhaulAuth(url.searchParams, this.env.NATSTACK_RELAY_SIGNING_SECRET, this.now()))) {
      return new Response("unauthorized backhaul", { status: 401 });
    }
    const serverId = url.searchParams.get("serverId")!;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.acceptBackhaul(serverId, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Bind an authenticated backhaul socket to its `serverId`. Split out from the
   * upgrade so tests can drive the registry without constructing a 101 Response
   * (which the runtime, not the standard `Response`, can build).
   */
  acceptBackhaul(serverId: string, ws: WebSocket): void {
    this.state.acceptWebSocket(ws, [serverId]);
    ws.serializeAttachment({ serverId });
  }

  // ---- Backhaul frames ----------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as { serverId?: string } | null;
    const serverId = attachment?.serverId;
    if (!serverId) return; // unauthenticated socket — should never happen post-accept.

    let frame: InboundFrame;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      frame = JSON.parse(text) as InboundFrame;
    } catch {
      return; // ignore malformed frames; the backhaul is server-controlled.
    }

    switch (frame.t) {
      case "register-webhook":
        return this.registerWebhook(serverId, frame.subscriptionId, ws);
      case "unregister-webhook":
        return this.unregisterWebhook(serverId, frame.subscriptionId);
      case "register-oauth":
        return this.registerOAuth(serverId, frame.transactionId, frame.platform, ws);
      case "ack":
        return this.settleDelivery(frame.deliveryId, { ok: true, response: frame.response });
      case "nack":
        return this.settleDelivery(frame.deliveryId, { ok: false, permanent: frame.permanent === true });
      default:
        return;
    }
  }

  webSocketClose(_ws: WebSocket): void {
    // Ownership and the durable buffer survive a dropped backhaul; the server
    // re-registers on reconnect and we flush then. Nothing to tear down.
  }

  webSocketError(_ws: WebSocket): void {}

  // ---- Webhook registration (first-writer-wins) ---------------------------

  private async registerWebhook(serverId: string, subscriptionId: string, ws: WebSocket): Promise<void> {
    const key = WEBHOOK_REG_PREFIX + subscriptionId;
    const existing = await this.state.storage.get<WebhookRegistration>(key);
    if (existing && existing.serverId !== serverId) {
      ws.send(JSON.stringify({ t: "register-rejected", kind: "webhook", id: subscriptionId, reason: "already-registered" }));
      return;
    }
    if (!existing) {
      await this.state.storage.put<WebhookRegistration>(key, { serverId, registeredAt: this.now() });
    }
    ws.send(JSON.stringify({ t: "registered", kind: "webhook", id: subscriptionId }));
    // Reconnect / first-registration: drain anything buffered while offline.
    await this.flushSubscription(subscriptionId, serverId);
  }

  private async unregisterWebhook(serverId: string, subscriptionId: string): Promise<void> {
    const key = WEBHOOK_REG_PREFIX + subscriptionId;
    const existing = await this.state.storage.get<WebhookRegistration>(key);
    if (existing && existing.serverId === serverId) {
      await this.state.storage.delete(key);
    }
  }

  // ---- OAuth registration (single-use, durable in DO storage) -------------

  /**
   * Persist a `transactionId -> {platform, serverId}` entry with a short TTL.
   * Durable (survives hibernation) but still single-handoff: the landing deletes
   * it on read. No buffering/retry — a missing tx at landing time fails loud.
   */
  private async registerOAuth(serverId: string, transactionId: string, platform: OAuthPlatform, ws: WebSocket): Promise<void> {
    await this.pruneExpiredOAuth();
    const entry: OAuthRegistration = { platform, serverId, expiresAt: this.now() + OAUTH_TX_TTL_MS };
    await this.state.storage.put<OAuthRegistration>(this.oauthKey(transactionId), entry);
    ws.send(JSON.stringify({ t: "registered", kind: "oauth", id: transactionId }));
  }

  /**
   * Evict expired OAuth txs so abandoned/mobile flows (which are never consumed)
   * do not accumulate in storage. Read-time expiry already protects correctness;
   * this only reclaims space, mirroring the old in-memory prune-on-register.
   */
  private async pruneExpiredOAuth(): Promise<void> {
    const now = this.now();
    const entries = await this.state.storage.list<OAuthRegistration>({ prefix: OAUTH_TX_PREFIX });
    for (const [key, entry] of entries) {
      if (now > entry.expiresAt) await this.state.storage.delete(key);
    }
  }

  /**
   * Drive the landing handler against durable storage. The tx is pre-loaded here
   * (async) so the handler's synchronous `lookup`/`consume` contract is honored,
   * and the delete-on-read is flushed durably before the response returns.
   */
  private async handleOAuthCallback(url: URL): Promise<Response> {
    const transactionId = parseOAuthTransactionId(url);
    const registration = transactionId ? await this.loadOAuthTx(transactionId) : undefined;
    let consumed: Promise<unknown> | undefined;
    const response = handleOAuthLanding(url, this.now(), {
      lookup: (id) => (id === transactionId ? registration : undefined),
      consume: (id) => {
        consumed = this.state.storage.delete(this.oauthKey(id));
      },
      deliverToBackhaul: (serverId, frame) => this.deliverToBackhaul(serverId, frame),
    });
    // Make the single-use delete durable: do not return until it has flushed.
    if (consumed) await consumed;
    return response;
  }

  /** Load an OAuth tx, treating an expired entry as missing (and evicting it). */
  private async loadOAuthTx(transactionId: string): Promise<OAuthRegistration | undefined> {
    const entry = await this.state.storage.get<OAuthRegistration>(this.oauthKey(transactionId));
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      await this.state.storage.delete(this.oauthKey(transactionId));
      return undefined;
    }
    return entry;
  }

  private oauthKey(transactionId: string): string {
    return OAUTH_TX_PREFIX + transactionId;
  }

  // ---- Webhook ingress ----------------------------------------------------

  private async handleWebhookIngress(request: Request, url: URL): Promise<Response> {
    const subscriptionId = safeDecodeURIComponent(url.pathname.slice("/i/".length).split("/")[0] ?? "");
    if (!subscriptionId) return json({ error: "missing or malformed subscriptionId" }, { status: 400 });

    const registration = await this.state.storage.get<WebhookRegistration>(WEBHOOK_REG_PREFIX + subscriptionId);
    if (!registration) {
      // No server has claimed this subscription over the backhaul — reject.
      // (The shared secret cannot stand in for tenant ownership.)
      return json({ error: "subscription not registered", subscriptionId }, { status: 404 });
    }

    if (!this.env.NATSTACK_RELAY_SIGNING_SECRET) {
      return json({ error: "NATSTACK_RELAY_SIGNING_SECRET is not configured" }, { status: 500 });
    }

    const rawBody = await request.arrayBuffer();
    const bodySha256 = await sha256Hex(rawBody);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "cookie") return;
      headers[name] = value;
    });

    const now = this.now();
    const buffered: BufferedWebhook = {
      deliveryId: crypto.randomUUID(),
      subscriptionId,
      serverId: registration.serverId,
      method: request.method.toUpperCase(),
      path: url.pathname,
      query: url.search.startsWith("?") ? url.search.slice(1) : url.search,
      headers,
      bodyBase64: bytesToBase64(new Uint8Array(rawBody)),
      bodySha256,
      createdAt: now,
      expiresAt: now + WEBHOOK_BUFFER_TTL_MS,
      attempts: 0,
      lastAttemptAt: 0,
    };
    await this.state.storage.put<BufferedWebhook>(this.bufKey(buffered.deliveryId), buffered);
    await this.ensureAlarm();

    const ack = await this.deliverBuffered(buffered, true);
    if (ack.ok || ack.permanent) {
      // settleDelivery already removed the buffer entry; relay the server's
      // response verbatim so challenge/response webhooks still work.
      return ackToResponse(ack);
    }
    // Offline / timed out — kept in the durable buffer; the alarm retries.
    return json({ accepted: true, buffered: true, subscriptionId }, { status: 202 });
  }

  // ---- Delivery -----------------------------------------------------------

  private async deliverBuffered(buffered: BufferedWebhook, waitForAck: boolean): Promise<AckResult> {
    const ws = this.openBackhaul(buffered.serverId);
    if (!ws) return { ok: false, offline: true };

    const timestamp = String(this.now());
    const signature = await signRelayEnvelope(this.secret(), {
      method: buffered.method,
      path: buffered.path,
      query: buffered.query,
      timestamp,
      bodySha256: buffered.bodySha256,
    });
    const frame = {
      t: "webhook",
      deliveryId: buffered.deliveryId,
      subscriptionId: buffered.subscriptionId,
      method: buffered.method,
      path: buffered.path,
      query: buffered.query,
      headers: buffered.headers,
      bodyBase64: buffered.bodyBase64,
      relay: { timestamp, bodySha256: buffered.bodySha256, signature },
    };

    buffered.attempts += 1;
    buffered.lastAttemptAt = this.now();
    await this.state.storage.put<BufferedWebhook>(this.bufKey(buffered.deliveryId), buffered);

    if (!waitForAck) {
      // Background re-send (alarm/flush): the ack arrives later and cleans up.
      ws.send(JSON.stringify(frame));
      return { ok: false, background: true };
    }

    return await new Promise<AckResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(buffered.deliveryId);
        resolve({ ok: false, timeout: true });
      }, WEBHOOK_DELIVERY_TIMEOUT_MS);
      this.pending.set(buffered.deliveryId, { resolve, timer });
      ws.send(JSON.stringify(frame));
    });
  }

  /** Resolve an awaited delivery and evict the buffer entry on terminal acks. */
  private async settleDelivery(deliveryId: string, result: AckResult): Promise<void> {
    if (result.ok || result.permanent) {
      await this.state.storage.delete(this.bufKey(deliveryId));
    }
    const waiter = this.pending.get(deliveryId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pending.delete(deliveryId);
      waiter.resolve(result);
    }
  }

  private async flushSubscription(subscriptionId: string, serverId: string): Promise<void> {
    for (const buffered of await this.listBuffer()) {
      if (buffered.subscriptionId !== subscriptionId) continue;
      if (buffered.serverId !== serverId) continue;
      await this.deliverBuffered(buffered, false);
    }
  }

  private deliverToBackhaul(serverId: string, frame: unknown): boolean {
    const ws = this.openBackhaul(serverId);
    if (!ws) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  private openBackhaul(serverId: string): WebSocket | undefined {
    return this.state.getWebSockets(serverId).find((ws) => ws.readyState === WS_OPEN);
  }

  // ---- Alarm: retry + TTL eviction ----------------------------------------

  async alarm(): Promise<void> {
    const now = this.now();
    let remaining = 0;
    for (const buffered of await this.listBuffer()) {
      if (now > buffered.expiresAt) {
        await this.state.storage.delete(this.bufKey(buffered.deliveryId));
        continue;
      }
      remaining += 1;
      // Avoid re-send storms: skip if we just attempted within the interval.
      if (now - buffered.lastAttemptAt < WEBHOOK_RETRY_INTERVAL_MS) continue;
      if (this.openBackhaul(buffered.serverId)) {
        await this.deliverBuffered(buffered, false);
      }
    }
    if (remaining > 0) {
      await this.state.storage.setAlarm(now + WEBHOOK_RETRY_INTERVAL_MS);
    }
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing == null) {
      await this.state.storage.setAlarm(this.now() + WEBHOOK_RETRY_INTERVAL_MS);
    }
  }

  private bufKey(deliveryId: string): string {
    return BUFFER_PREFIX + deliveryId;
  }

  private async listBuffer(): Promise<BufferedWebhook[]> {
    const map = await this.state.storage.list<BufferedWebhook>({ prefix: BUFFER_PREFIX });
    return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}

/**
 * Resolve the OAuth transactionId from the landing URL so the durable tx can be
 * pre-loaded before the (synchronous) landing handler runs. Mirrors
 * `parseTransactionId` in ./oauthLanding so both agree on which id is in play; a
 * divergence would only ever fail closed (the handler's own lookup misses).
 */
function parseOAuthTransactionId(url: URL): string | undefined {
  const prefix = "/oauth/callback/";
  if (url.pathname.startsWith(prefix)) {
    const segment = url.pathname.slice(prefix.length).split("/")[0];
    if (segment) {
      const decoded = safeDecodeURIComponent(segment);
      if (decoded) return decoded;
    }
  }
  return url.searchParams.get("transactionId") ?? undefined;
}

/** decodeURIComponent that returns null on a malformed sequence (e.g. a lone "%")
 * rather than throwing a URIError that would surface as an unhandled 500. */
function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function ackToResponse(ack: AckResult): Response {
  if (ack.response) {
    const { status, bodyBase64, contentType } = ack.response;
    return new Response(bodyBase64 ? decodeBase64(bodyBase64) : null, {
      status,
      headers: {
        "content-type": contentType ?? "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  if (ack.permanent) {
    return json({ accepted: false, reason: "rejected" }, { status: 502 });
  }
  return json({ accepted: true }, { status: 202 });
}

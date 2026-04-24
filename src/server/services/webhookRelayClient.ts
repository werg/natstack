/**
 * Cloudflare-relay puller for the desktop side of the webhook pipeline.
 *
 * The Cloudflare Worker in `apps/webhook-relay/` accepts provider webhooks,
 * verifies their HMAC, and queues them per tenant. This client maintains a
 * single long-running long-poll against `GET /pull/:tenantId`, dispatches
 * each event to the in-process webhook handler, then ACKs.
 *
 * This pairs with `webhookService.ts` (RPC method
 * `webhook.startRelayPuller(tenantId)`, shell-only policy).
 *
 * TODO (cross-scope): integrate with the desktop's TLS pinning
 * (`src/main/tlsPinning.ts`) so the relay's certificate is pinned. Wave-1
 * pinning is per-host; adding the relay host needs a config change in
 * `tlsPinning.ts` which is outside this agent's edit scope.
 */

import type { WebhookEvent } from "../../../packages/shared/src/webhooks/types.js";

interface PullEnvelopeEvent {
  eventId: string;
  provider: string;
  tenantId: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
}

interface PullResponse {
  events: PullEnvelopeEvent[];
}

export type WebhookEventDispatcher = (event: WebhookEvent) => Promise<void> | void;

export interface WebhookRelayClientOpts {
  /** Base URL of the Cloudflare relay, e.g. https://relay.example.workers.dev */
  baseUrl: string;
  /** Per-tenant identifier the relay will use to scope events. */
  tenantId: string;
  /** Bearer token minted by `POST /admin/tenant/:tenantId/init`. */
  bearer: string;
  /** Called once per delivered event. ACK happens after this resolves. */
  dispatch: WebhookEventDispatcher;
  /** Optional logger; defaults to console. */
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void };
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
/**
 * The relay holds the connection up to 25s; allow some slack for the
 * round-trip + KV poll interval before we treat the request as hung.
 */
const PULL_REQUEST_TIMEOUT_MS = 35_000;

export class WebhookRelayClient {
  private readonly baseUrl: string;
  private readonly tenantId: string;
  private readonly bearer: string;
  private readonly dispatch: WebhookEventDispatcher;
  private readonly logger: NonNullable<WebhookRelayClientOpts["logger"]>;
  private readonly fetchImpl: typeof fetch;

  private running = false;
  private currentAbort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;

  constructor(opts: WebhookRelayClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tenantId = opts.tenantId;
    this.bearer = opts.bearer;
    this.dispatch = opts.dispatch;
    this.logger = opts.logger ?? {
      info: (msg, meta) => console.log(`[webhookRelay] ${msg}`, meta ?? ""),
      warn: (msg, meta) => console.warn(`[webhookRelay] ${msg}`, meta ?? ""),
      error: (msg, meta) => console.error(`[webhookRelay] ${msg}`, meta ?? ""),
    };
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop().catch((err) => {
      this.logger.error("relay loop crashed", err);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.currentAbort?.abort();
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // already logged
      }
    }
    this.loopPromise = null;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pullOnce();
        // Reset backoff after any successful poll (even one that returned
        // an empty event list — empty just means the long-poll hit its
        // 25s cap).
        this.backoffMs = INITIAL_BACKOFF_MS;
      } catch (err) {
        if (!this.running) return;
        this.logger.warn("pull failed", err);
        await this.sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async pullOnce(): Promise<void> {
    const ac = new AbortController();
    this.currentAbort = ac;
    const timeout = setTimeout(() => ac.abort(), PULL_REQUEST_TIMEOUT_MS);

    try {
      const url = `${this.baseUrl}/pull/${encodeURIComponent(this.tenantId)}`;
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.bearer}` },
        signal: ac.signal,
      });
      if (!res.ok) {
        // 401 → bearer is wrong/stale; fail loud and back off.
        throw new Error(`pull HTTP ${res.status}`);
      }
      const body = (await res.json()) as PullResponse;
      if (!body.events || body.events.length === 0) {
        return;
      }
      for (const env of body.events) {
        await this.handleEvent(env);
      }
    } finally {
      clearTimeout(timeout);
      if (this.currentAbort === ac) this.currentAbort = null;
    }
  }

  private async handleEvent(env: PullEnvelopeEvent): Promise<void> {
    // Best-effort event-type extraction from provider-specific headers.
    // Falls back to "delivery" so the in-process dispatcher can still
    // route by `provider` + payload shape.
    const eventType =
      env.headers["x-github-event"]
      ?? env.headers["x-slack-event"]
      ?? (env.headers["stripe-signature"] ? "stripe" : "delivery");

    const event: WebhookEvent = {
      provider: env.provider,
      // The relay does not know the consent connection — use the eventId
      // as a stable correlator until the in-process dispatcher resolves
      // the connection from the provider+tenant pair.
      connectionId: env.eventId,
      event: eventType,
      delivery: "https-post",
      payload: env.body,
      headers: env.headers,
      receivedAt: env.receivedAt,
    };
    try {
      await this.dispatch(event);
    } catch (err) {
      this.logger.error("dispatch failed; will not ACK", { eventId: env.eventId, err });
      // Skip ACK so the relay re-delivers after the queue TTL pickup.
      return;
    }
    await this.ack(env.eventId);
  }

  private async ack(eventId: string): Promise<void> {
    try {
      const url = `${this.baseUrl}/ack/${encodeURIComponent(this.tenantId)}/${encodeURIComponent(eventId)}`;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.bearer}` },
      });
      if (!res.ok) {
        this.logger.warn("ack failed", { eventId, status: res.status });
      }
    } catch (err) {
      this.logger.warn("ack threw", { eventId, err });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Resolve the bearer token for a tenant from environment variables.
 * Convention: `NATSTACK_RELAY_BEARER_<TENANT_ID>` with the tenantId
 * uppercased and `-` / `.` replaced by `_`.
 */
export function resolveTenantBearer(tenantId: string): string | undefined {
  const key = `NATSTACK_RELAY_BEARER_${tenantId.toUpperCase().replace(/[-.]/g, "_")}`;
  return process.env[key];
}

export function resolveRelayBaseUrl(): string | undefined {
  return process.env["NATSTACK_RELAY_URL"];
}

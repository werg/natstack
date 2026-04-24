/**
 * Webhook signature verifiers for the Cloudflare Worker relay.
 *
 * These mirror the canonical implementations in
 * `packages/shared/src/webhooks/verifier.ts` but are reimplemented against
 * the Web Crypto API because Cloudflare Workers do not provide
 * `node:crypto` and we cannot easily bundle the shared package's
 * Node-specific code into a worker.
 *
 * If you change the algorithm or header names here, ALSO update the
 * canonical verifier in shared/. Both must accept/reject the same inputs.
 *
 * Audit references:
 *   - F-02 (webhook ingestion path missing)
 *   - F-03 (replay window) — enforced via `MAX_TIMESTAMP_SKEW_SEC` below.
 */

const TEXT_ENCODER = new TextEncoder();

/** Slack/Stripe spec: 5-minute replay window. F-03 fix. */
export const MAX_TIMESTAMP_SKEW_SEC = 300;

export interface VerifyContext {
  /** Now in seconds, injected for testing. */
  nowSec: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  /** Provider-specific delivery / nonce identifier for replay-table key. */
  deliveryId?: string;
}

export type Verifier = (
  payload: string,
  headers: Record<string, string>,
  secret: string,
  ctx: VerifyContext,
) => Promise<VerifyResult>;

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

/**
 * Constant-time string compare. Web Crypto has no `timingSafeEqual`;
 * we implement byte-XOR-OR ourselves on equal-length buffers. Bail-early
 * only on length mismatch (length is not secret).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = TEXT_ENCODER.encode(a);
  const bBuf = TEXT_ENCODER.encode(b);
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) {
    diff |= (aBuf[i] ?? 0) ^ (bBuf[i] ?? 0);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** GitHub: X-Hub-Signature-256 = sha256=<hex>. No timestamp; rely on delivery-id nonce. */
export const githubVerifier: Verifier = async (payload, rawHeaders, secret) => {
  const headers = lowerKeys(rawHeaders);
  const sigHeader = getHeader(headers, "x-hub-signature-256");
  if (!sigHeader) return { ok: false, reason: "missing x-hub-signature-256" };
  const deliveryId = getHeader(headers, "x-github-delivery");
  const expected = `sha256=${await hmacSha256Hex(secret, payload)}`;
  if (!constantTimeEqual(sigHeader, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true, deliveryId };
};

/** Slack: v0=hmac(secret, "v0:<ts>:<body>"). Requires 5-minute timestamp window. */
export const slackVerifier: Verifier = async (payload, rawHeaders, secret, ctx) => {
  const headers = lowerKeys(rawHeaders);
  const sig = getHeader(headers, "x-slack-signature");
  const ts = getHeader(headers, "x-slack-request-timestamp");
  if (!sig || !ts) return { ok: false, reason: "missing slack signature/timestamp headers" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "invalid timestamp" };
  if (Math.abs(ctx.nowSec - tsNum) > MAX_TIMESTAMP_SKEW_SEC) {
    return { ok: false, reason: "timestamp outside replay window" };
  }
  const expected = `v0=${await hmacSha256Hex(secret, `v0:${ts}:${payload}`)}`;
  if (!constantTimeEqual(sig, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  // Slack doesn't supply a delivery id; use the timestamp as nonce.
  return { ok: true, deliveryId: `slack-${ts}` };
};

/**
 * Stripe: header is `Stripe-Signature: t=<ts>,v1=<sig>[,v1=<sig>...]`.
 * 5-minute replay window per Stripe spec.
 */
export const stripeVerifier: Verifier = async (payload, rawHeaders, secret, ctx) => {
  const headers = lowerKeys(rawHeaders);
  const sigHeader = getHeader(headers, "stripe-signature");
  if (!sigHeader) return { ok: false, reason: "missing stripe-signature" };
  const parts = sigHeader.split(",");
  let ts: string | undefined;
  const sigs: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) ts = value;
    else if (key === "v1" && value) sigs.push(value);
  }
  if (!ts || sigs.length === 0) return { ok: false, reason: "malformed stripe-signature" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "invalid timestamp" };
  if (Math.abs(ctx.nowSec - tsNum) > MAX_TIMESTAMP_SKEW_SEC) {
    return { ok: false, reason: "timestamp outside replay window" };
  }
  const expected = await hmacSha256Hex(secret, `${ts}.${payload}`);
  for (const sig of sigs) {
    if (constantTimeEqual(sig, expected)) {
      // Stripe payloads include `id: evt_...` at the JSON top level — we
      // could parse it for a sturdier nonce, but using the timestamp is
      // sufficient for the 5-minute window.
      return { ok: true, deliveryId: `stripe-${ts}` };
    }
  }
  return { ok: false, reason: "signature mismatch" };
};

export const VERIFIERS: Record<string, Verifier> = {
  github: githubVerifier,
  slack: slackVerifier,
  stripe: stripeVerifier,
};

/** SHA-256 hex digest used as the nonce-table key for arbitrary payloads. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time bearer-token compare for the desktop-side auth headers. */
export function bearerEqual(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
}

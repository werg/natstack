# NatStack Security Audit — Authentication, Sessions & Authorization

**Audit date:** 2026-04-23
**Branch:** `audit`
**Scope:** Authentication, session management, and authorization across the NatStack
main Electron app, backing server, mobile shell, webhook relay, auth-flow package,
RPC/gateway transport, and OAuth flows.
**Methodology:** read-only static review. No dynamic testing performed.

---

## 1. Executive Summary

NatStack's auth model is built around a two-tier bearer-token system: a single
**admin token** (32-byte hex, persisted at `~/.config/natstack/admin-token` with
mode `0o600`) that grants `callerKind: "server"`, and per-caller **panel/shell/worker
tokens** (also 32-byte hex, held only in memory by `TokenManager`). A `ServicePolicy`
gates each service-method by `callerKind`. OAuth flows for AI providers
(`openai-codex`) run client-side in Electron main or mobile; the server persists
the resulting credentials at `~/.config/natstack/oauth-tokens.json` (`0o600`).

**The fundamentals are largely correct.** Tokens are minted with `crypto.randomBytes`,
stored with sensible file permissions, and PKCE + state are implemented on the
primary OAuth flow. Admin-token persistence uses Electron `safeStorage` (OS
keychain) on the client side. TLS pinning is implemented for remote connections.

**However, the audit surfaces several findings that span Critical to Low severity.**
The most impactful are:

1. **[Critical] `authTokens.persist` is callable by `panel` and `worker` callers.**
   Any panel or worker can silently overwrite the user's stored OAuth credentials
   for any provider (e.g. `openai-codex`), substituting attacker-controlled tokens
   that any legitimate agent will subsequently use. Correspondingly,
   `authTokens.getProviderToken` is also reachable by panels/workers and will
   leak the plaintext bearer token to any such caller.
2. **[Critical] Path traversal in `CredentialStore`.** `providerId` and
   `connectionId` are untrusted user input joined straight into filesystem
   paths, allowing write/read/delete outside the credentials root. A malicious
   panel with access to `credentials.*` methods can escape `~/.natstack/credentials/`.
3. **[High] Intra-server relay RPC is effectively unauthenticated for
   non-panel callers.** `RpcServer.checkRelayAuth` short-circuits to `ok` when
   `callerKind !== "panel"`. Any compromised worker (or any shell caller on a
   device shared with the server) can relay arbitrary RPC calls and events to
   any other target, bypassing the panel-tree ACL entirely.
4. **[High] Egress proxy trusts caller-supplied attribution headers.** The
   egress proxy identifies the calling worker only via two HTTP headers
   (`x-natstack-worker-id`, `x-natstack-proxy-auth`) that it never validates
   against any token store. Any local process that can reach the loopback
   proxy can impersonate any worker, pick up that worker's consent grants,
   and have its requests signed with the provider's bearer token.
5. **[High] Management API default-allows when `managementToken` is unset.**
   `PanelHttpServer.validateManagementAuth` returns `true` if the configured
   token is null, opening `/api/panels` to anyone who can reach the server.
6. **[High] Mobile OAuth callback deep-link registry is never consumed.**
   `consumePendingFlow` is declared in `authCallbackRegistry.ts` but has no
   call sites — `LoginScreen.tsx` only consumes `natstack://connect` links,
   leaving `natstack://auth/callback` deep-links ignored. Beyond the
   functional bug (mobile Codex login cannot complete), the pending-flow
   table has no other reaper and grows/leaks on every started flow.
7. **[Medium] `credentialService.completeConsent` has no state check and no
   expiry.** The `nonce` acts as both state and lookup key. While the 16-byte
   nonce is strong enough to resist forgery, there is no freshness check; an
   attacker with any leaked nonce (e.g. via logs) can complete the flow
   post-facto. `pendingConsents` is also never cleaned up.
8. **[Medium] Non-constant-time token comparisons** for the admin token at the
   gateway and `TokenManager.validateAdminToken`, and for the
   `PanelHttpServer` management Bearer token.
9. **[Medium] Webhook verifiers omit timestamp freshness checks.** Slack and
   Stripe verifiers validate HMAC but never check that `timestamp` is within
   the tolerance window, making replay attacks easy.
10. **[Medium] Client-loopback OAuth redirect URI in `credentialService` is
    under-specified** (`http://127.0.0.1/oauth/callback` with no port), and
    `server-loopback` mode uses `:0` in the redirect — both are likely to
    fail provider validation and to produce unpredictable behavior if a
    provider does accept them.
11. **[Medium] No rate-limiting on WS auth.** Brute-force against the admin/
    shell tokens is only gated by the 10-second "auth timeout"; an attacker
    can connect, guess, disconnect, and retry indefinitely at high rate.
12. **[Low] `authTokens.credentials` is trusted verbatim from client.**
    `AuthTokensServiceImpl.persist` accepts any `{access,refresh,expires,extra}`
    and spreads `extra` on top — a caller can overwrite protected fields like
    `storedAt`.
13. **[Low] OAuth `originator` field hard-coded to `codex_cli_rs`.** This
    impersonates the official Codex CLI to the OpenAI authorize endpoint.
    Functionally necessary given the OpenAI client lock, but worth noting as
    a supply-chain/ToS risk.
14. **[Info] `webhook-relay` app is stub code** with no HMAC verification,
    replay protection, or auth. Out of scope (no real logic yet), but the
    scaffolding lacks any of the guards its scope implies.

The rest of this document details each finding.

---

## 2. Findings, Severity-Ordered

### 2.1 [Critical] `authTokens.persist` / `getProviderToken` accessible to panels and workers

**Files:** `src/server/services/authService.ts:275-281`

```ts
policy: { allowed: ["shell", "panel", "worker", "server"] },
methods: {
  getProviderToken: { args: z.tuple([z.string()]) },
  persist: { args: z.tuple([z.string(), persistInputSchema]) },
  logout: { args: z.tuple([z.string()]) },
  listProviders: { args: z.tuple([]) },
  waitForProvider: { args: z.tuple([z.string(), z.number().optional()]) },
},
```

The service policy allows `panel` and `worker` callers to invoke every method,
including:

- `persist(providerId, credentials)` — writes attacker-controlled OAuth
  credentials to `~/.config/natstack/oauth-tokens.json` (`0o600`) under any
  existing provider id.
- `getProviderToken(providerId)` — returns the plaintext `access` token,
  silently refreshing via the stored `refresh` token if expired.
- `logout(providerId)` — deletes credentials.

**Attack scenario.** Two variants, both exploitable by *any* panel or worker:

1. *Exfiltration.* A compromised or malicious panel (e.g. a third-party panel
   installed by the user) calls `authTokens.getProviderToken("openai-codex")`
   and receives the raw OpenAI bearer token, which it can then use from any
   environment — bypassing the egress proxy, consent grants, capability
   declarations, rate limits, and audit log.
2. *Substitution.* A malicious panel calls
   `authTokens.persist("openai-codex", { access: "<attacker-token>", ... })`.
   The call replaces the user's real credentials on disk (`0o600` does not
   help — the server process already has write access). The next time the
   legitimate Codex agent asks for a token, it gets the attacker's, and all
   outbound Codex traffic lands in the attacker's OpenAI account (billable
   inference on the attacker's dime as the obvious end-goal, but also a
   full MITM on Codex responses).

The only thing gating this today is that panels don't habitually know about
this service — a thin defense.

**Remediation.**

- Restrict `authTokens` policy to `["server"]` (and optionally `"shell"` if
  the user-facing settings panel genuinely needs it — it already has
  `authFlow` which wraps `authTokens` via explicit flows).
- If partial access is needed from panels, split the service: a
  panel-callable `authTokens.status` for non-sensitive status, and server-
  only `persist/getProviderToken/logout`.
- Add method-level policies (`methodDef.policy`) so `listProviders` can stay
  broadly available while the mutation and read paths stay locked down.

---

### 2.2 [Critical] Path traversal in `CredentialStore`

**File:** `packages/shared/src/credentials/store.ts:225-231`

```ts
private getProviderPath(providerId: string): string {
  return path.join(this.basePath, providerId);
}

private getCredentialPath(providerId: string, connectionId: string): string {
  return path.join(this.getProviderPath(providerId), `${connectionId}.json`);
}
```

Both `providerId` and `connectionId` flow in from RPC arguments validated
only as `z.string()` (see `src/server/services/credentialService.ts:42-75`),
with no character-class restriction. Node's `path.join` resolves `..`
components, so `providerId: "../../etc"` plus
`connectionId: "passwd"` expands to `<basePath>/../../etc/passwd.json`,
letting a caller write, read, or unlink arbitrary paths the server has
access to.

**Attack scenario.** A panel with access to `credentials.*` (currently any
panel — see §2.1 and the service's `policy: { allowed: ["shell", "panel",
"server", "worker"] }` in `credentialService.ts:340`) calls
`credentials.completeConsent` or `credentials.requestConsent` with a
crafted provider id. The `save(credential)` call in
`completeConsent` (line 252) writes attacker content to any file path
writable by the server process — including overwriting
`~/.config/natstack/admin-token`, `oauth-tokens.json`, the user's shell
rc files, or SSH keys. The same primitive enables read-back (`list` does
not enumerate with user input, but `load` does) and deletion.

**Remediation.**

- Validate `providerId` and `connectionId` against a strict whitelist:
  `/^[a-z0-9_.-]{1,64}$/i` for `providerId` and a UUID pattern for
  `connectionId`. Reject anything containing `/`, `\\`, `..`, or NUL.
- Belt-and-suspenders: after `path.join`, resolve to absolute and verify
  the result starts with `basePath + path.sep`, else throw.
- Apply the same hardening to the `CredentialStore` watch path signatures.

---

### 2.3 [High] Intra-server relay RPC is effectively unauthenticated for non-panel callers

**File:** `src/server/rpcServer.ts:944-964`

```ts
private checkRelayAuth(callerId: string, callerKind: CallerKind, targetId: string): RelayAuthCheck {
  if (callerKind !== "panel") return { ok: true };
  if (targetId === callerId) return { ok: true };
  if (targetId.startsWith("do:") || targetId.startsWith("worker:")) return { ok: true };
  …
}
```

Only `panel` callers are subject to the parent/descendant ACL. Any `worker`,
`shell`, `server`, or `harness` caller can relay arbitrary RPC calls and
events to any other target (`ws:route` / `ws:panel-rpc` messages, and the
`type:"call"` / `type:"emit"` variants over HTTP POST `/rpc` at
`rpcServer.ts:920-929`). For DO / worker targets there is no ACL at all —
panels too can relay freely to any DO or worker in the process (line 947).

**Attack scenario.**

1. *Compromised worker.* A worker exploited via a supply-chain bug or
   malicious panel code (workers run WASM-like code loaded by workerd)
   issues `{type:"call", targetId:"<another-panel-id>", method:"fs.readFile", args:["/etc/passwd"]}`
   over HTTP POST `/rpc` using the admin or its own token. It now proxies
   to the target panel's bridge transport and impersonates the panel to
   the server layer or vice versa.
2. *Panel → DO.* A panel relays to any DO it knows (or can enumerate) by
   id — e.g. `targetId: "do:source/Class/otherUserKey"` — bypassing any
   intended per-panel DO scoping.

**Remediation.**

- Apply ACL to every caller kind. Workers should only be allowed to
  relay to DO / worker targets they own, and only to the panel/shell that
  spawned them.
- Require explicit target-kind allowlisting for `do:` / `worker:` relay —
  verify the caller has a consent/binding to that specific DO key.
- Drop the `callerKind !== "panel"` shortcut entirely; treat every relay
  as a capability the caller must have been granted.

---

### 2.4 [High] Egress proxy authenticates via caller-supplied headers

**File:** `src/server/services/egressProxy.ts:338-351`

```ts
private attributeRequest(req: IncomingMessage): RequestAttribution | null {
  const workerId = this.readHeader(req, WORKER_ID_HEADER);
  const callerId = this.readHeader(req, PROXY_AUTH_HEADER);

  if (!workerId || !callerId) {
    return null;
  }

  return {
    workerId,
    callerId,
    rateLimitKey: `${workerId}:${callerId}`,
  };
}
```

`attributeRequest` reads two headers and trusts them as proof of identity.
There is no HMAC, no token validation against `TokenManager`, and no check
that the worker/caller ID was actually minted for this connection.

Downstream, `authorizeRequest` (line 365-414) looks up consent grants keyed
on `workerId` and attaches the resulting bearer token to the outbound
request. So any caller that sets the headers picks up any worker's
provider credentials.

The mitigating factor is that the proxy binds `127.0.0.1` only
(`egressProxy.ts:123`). In a local-only, single-user deployment this
limits the attacker to "another process on the same host as the server".
In containerized or multi-tenant deployments where several unrelated
workloads share a host namespace, that boundary is meaningless.

**Attack scenario.** Any local process (or any panel that can make
outgoing HTTP via `fetch`) sets `X-NatStack-Worker-Id: <target-worker-id>`
and `X-NatStack-Proxy-Auth: anything` and gets outbound calls signed
with that worker's bearer tokens, charged to that worker's rate-limit
bucket, and logged to audit with the spoofed identity.

**Remediation.**

- Require a HMAC over the request (or a per-worker bearer token validated
  against `TokenManager`) in the `PROXY_AUTH_HEADER`. Rotate the secret
  on each worker spawn.
- Bind the proxy to a unix domain socket with `0o600` ownership by the
  server user, or to a secret loopback port gated by mTLS.
- Ensure workerd's outbound fetch is the **only** path to the proxy (e.g.
  firewall it from renderer/panel processes at the OS level where
  possible).

---

### 2.5 [High] Management API default-allows when `managementToken` is unset

**File:** `src/server/panelHttpServer.ts:533-539`

```ts
private validateManagementAuth(req: import("http").IncomingMessage): boolean {
  if (!this.managementToken) return true;
  const auth = req.headers.authorization;
  if (!auth) return false;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] === this.managementToken;
}
```

If the server is constructed without a `managementToken` (the parameter is
optional, `this.managementToken` defaults to `null`), the endpoint accepts
every request unauthenticated. `/api/panels` then returns the full panel
list — including `contextId` values used to construct per-panel URLs
elsewhere. The wiring at `src/server/panelRuntimeRegistration.ts:127`
currently always passes `adminToken`, so the live configuration is not
affected, but the failure mode is a misconfiguration waiting to happen
(and several tests instantiate the server without a token,
`panelHttpServer.test.ts:140-164`).

Also notable: the endpoint sets `Access-Control-Allow-Origin: *`
(`panelHttpServer.ts:506`). Combined with Bearer auth the risk is lower
(Bearer tokens are not auto-sent by browsers), but combined with "auth
skipped on null token" it becomes a public, cross-origin readable panel
enumeration endpoint.

**Attack scenario.** If a deployment or a downstream consumer constructs
`PanelHttpServer` without the `managementToken` arg — which is easy to
miss, the parameter is optional — any reachable attacker enumerates every
active panel, including context identifiers. For a remote server exposed
publicly (remote-panel mode), this leaks per-context panel topology.

**Remediation.**

- Make `managementToken` required (remove the default).
- Fail closed if it's falsy: `if (!this.managementToken) return false;`
- Remove the wildcard CORS origin, or narrow it to a configured allow-list
  of known client origins.
- Add a test that a null token results in 401, not 200.

---

### 2.6 [High] Mobile OAuth deep-link callback registry is never consumed

**Files:** `apps/mobile/src/services/authCallbackRegistry.ts`,
`apps/mobile/src/services/codexAuthFlow.ts:20-57`,
`apps/mobile/src/components/LoginScreen.tsx:133-153`

`authCallbackRegistry.consumePendingFlow` (line 28) is exported but has
**zero call sites**. The only `Linking.addEventListener("url", …)`
subscriber in the app lives in `LoginScreen` and consumes only
`natstack://connect` deep-links. The Codex OAuth redirect URI is
`natstack://auth/callback` (`codexAuthFlow.ts:17`), so when the OS
delivers the authorize-code callback, no handler reads the registry,
no pending flow ever resolves, and the `Promise<string>` created in
`runOpenaiCodexFlow` hangs until `FLOW_TIMEOUT_MS` (10 minutes).

**Attack scenario.**

1. *Functional bug becomes security-relevant.* The mobile Codex OAuth
   flow never completes successfully — every attempt times out. If a user
   has a mechanism to retry, the pending-flow table accumulates entries
   (each with a `setTimeout`) until the app is restarted.
2. *Timing/DoS.* An attacker that can fire `natstack://` intents on
   Android (any installed app can) can spam URLs with crafted `state`
   values; while they won't be consumed by *this* registry, the fact
   that `LoginScreen` is the only handler means every inbound URL flows
   through its filter, and the `Alert.alert("Can't open connect link",
   …)` branch is fired on any `natstack://connect` URL — cooperative
   UX abuse rather than a direct auth bypass, but indicative of the
   missing router.
3. *If a handler is added later* without auditing the code path, it is
   very easy to implement it wrongly — e.g. forgetting to validate the
   registered `state` or failing to drop the pending flow on error —
   because the registry has no tests and no live consumer.

**Remediation.**

- Add a single deep-link router at app boot (not inside `LoginScreen`,
  which unmounts after login) that branches on `pathname`:
  - `auth/callback` → parse `state`, look up
    `consumePendingFlow(state)`, resolve it with `{code, state}`; drop
    silently otherwise.
  - `connect` → route to the existing `LoginScreen` flow.
- Validate that the registered `state` matches the URL's `state` param
  *before* calling `resolve`, not after (as `codexAuthFlow.ts:34-37`
  currently does — by then the timer is already cleared and the
  registry entry removed, so a mismatch just fails the flow rather
  than ignoring the spoofed URL).
- Because any installed app can fire `natstack://auth/callback`,
  consider requiring the authorize-URL to have been opened in the
  immediate past (e.g. by storing the state in module scope with a
  short TTL and refusing to resolve a state whose TTL has not been
  bumped by a recent `buildAuthorizeUrl`).
- Add universal links (`https://`) so the redirect is OS-verified to
  the NatStack app rather than racy custom-scheme delivery.

---

### 2.7 [Medium] `credentialService.completeConsent` — no state check, no pending-flow expiry

**File:** `src/server/services/credentialService.ts:50-53, 194-199, 130`

```ts
const completeConsentParamsSchema = z.object({
  nonce: z.string(),
  code: z.string(),
}).strict();
…
async function completeConsent(params: CompleteConsentParams): Promise<ConsentResult> {
  const pending = pendingConsents.get(params.nonce);
  if (!pending) {
    throw new Error("Unknown or expired consent nonce");
  }
  pendingConsents.delete(params.nonce);
  …
}
```

The `nonce` is the only lookup key; there is no separate CSRF check
against the redirect URL's `state` parameter. Because the nonce is both
created server-side (16 random bytes) and returned to the caller, it
simultaneously plays the role of CSRF state and session identifier.
For the most part this is fine — guessing a 128-bit value is
infeasible — but two issues remain:

1. **No TTL.** `pendingConsents` is populated in `beginConsent`
   (line 182) but never expired. A caller that opens an authorize URL
   but never completes it keeps its nonce in memory forever. An
   attacker who later obtains any nonce (e.g. from logs, from a
   panel-to-server trace, from a crash dump) can submit it together
   with a self-chosen `code` and cause the server to call the
   provider's token endpoint with that code and **persist the
   resulting credentials as if they belonged to the original caller.**
2. **No origin binding.** `beginConsent` doesn't record the caller id;
   `completeConsent` doesn't verify the completer is the same caller
   as the initiator. Any authenticated caller (panel, worker, shell,
   server) who guesses or learns the nonce can complete any pending
   flow.

**Remediation.**

- Add `createdAt` (already present) + a periodic sweep that drops
  pending consents older than e.g. 10 minutes.
- Record `callerId` in `pending` and assert at
  `completeConsent` time that `ctx.callerId` matches.
- Require `code` and a redelivered `state` parameter (which equals the
  nonce) so even if the client persists the nonce, a later reuse must
  include the corresponding code obtained from that redirect.

---

### 2.8 [Medium] Non-constant-time admin-token comparison

**Files:**
- `packages/shared/src/tokenManager.ts:132-134`
  ```ts
  validateAdminToken(token: string): boolean {
    return this.adminToken !== null && token === this.adminToken;
  }
  ```
- `src/server/gateway.ts:88, 91, 317`
  ```ts
  if (params.get("token") === adminToken) detailed = true;
  …
  if (typeof headerToken === "string" && headerToken === adminToken) detailed = true;
  …
  return presented === adminToken;
  ```
- `src/server/panelHttpServer.ts:538`
  ```ts
  return match?.[1] === this.managementToken;
  ```

All of these use JavaScript `===` on two strings, which returns early on
the first differing byte. With a 32-byte hex token (64 characters, ~256
bits of entropy) a classical timing oracle over HTTP is not practical for
a remote attacker (network jitter dominates), but becomes more realistic
for a local process (e.g. a co-tenant on a remote-panel deployment) or
for an attacker who can batch large numbers of requests to average out
noise. On loopback it is trivially measurable.

`TokenManager.validateToken` itself uses `Map.get`, which is
timing-safe against byte-by-byte guesses (it hashes the full key).

**Remediation.**

- Use `crypto.timingSafeEqual` on equal-length `Buffer`s for every
  admin-token and management-token compare. Length-check first and
  short-circuit to `false` to avoid the constructor throwing.
- Keep the `Map.get` path for per-caller tokens as-is.

---

### 2.9 [Medium] Webhook verifiers do not enforce timestamp freshness

**File:** `packages/shared/src/webhooks/verifier.ts:67-119`

`slackSignatureV0` and `stripeSignature` both include a `timestamp` in
the HMAC input and parse the header, but neither rejects stale requests.

- Slack recommends rejecting any request whose timestamp is >5 minutes
  off the current clock.
- Stripe's `constructEvent` enforces a 5-minute tolerance by default.

Without freshness, a captured webhook (e.g. from a proxy log or a
mis-logged incoming request) can be replayed indefinitely — HMAC only
proves the sender knew the secret at some point, not that the request
is recent.

**Remediation.** In each verifier, compare `parseInt(timestamp, 10) * 1000`
to `Date.now()` and reject if the absolute delta exceeds 300 s (Slack)
or the provider's documented tolerance (Stripe).

---

### 2.10 [Medium] Ambiguous / malformed redirect URIs in `credentialService.beginConsent`

**File:** `src/server/services/credentialService.ts:166-180`

```ts
let redirectUri = "";
switch (params.redirect) {
  case "server-loopback":
    redirectUri = "http://127.0.0.1:0/oauth/callback";
    break;
  case "client-loopback":
    redirectUri = "http://127.0.0.1/oauth/callback";
    break;
  case "mobile-universal":
    redirectUri = "natstack://oauth/callback";
    break;
}
```

- `server-loopback` uses `:0` — the OS ephemeral-port sentinel. Provider
  authorize endpoints will not accept a zero port; even if they did, no
  real listener is bound to match the redirect.
- `client-loopback` has no port. A provider that validates exact match
  against a registered redirect URI will reject it; a provider that
  accepts loose matching might accept it with any port, which is itself
  a weaker security posture than RFC 8252 §7.3.
- `mobile-universal` uses a custom URL scheme
  (`natstack://oauth/callback`) — OK only if universal links (verified
  app-link on Android, associated-domains on iOS) are *not* required.
  The docstring calls it "universal" but the URL is a custom scheme.
  Any installed Android app can intercept this with equal priority
  unless explicitly claimed via assetlinks.json.

**Attack scenario.** Beyond a likely-functional bug (flows that never
resolve, which makes the feature unusable and so less scrutinized), a
provider that accepts loose loopback validation combined with the
fixed `http://127.0.0.1/oauth/callback` lets an attacker who controls
any loopback port on the same machine receive the authorization code.

**Remediation.**

- Choose an ephemeral port server-side, bind a listener, *then* build
  the redirect URI with that concrete port — don't use the `:0`
  sentinel in the authorize URL.
- Require the caller to supply the redirect URI, validated against a
  per-provider allow-list.
- Use universal links (verified) instead of custom schemes on mobile.

---

### 2.11 [Medium] No rate-limiting on WS auth attempts

**File:** `src/server/rpcServer.ts:279-315`

```ts
private handleConnection(ws: WebSocket): void {
  let authTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    ws.close(4003, "Auth timeout");
  }, 10000);
  …
  this.handleAuth(ws, msg.token);
}
```

A client has 10 s to send a valid `ws:auth` frame. There's no
brute-force protection: an attacker can open connections as fast as
the server can accept them and try one token per connection.

For the admin token (256-bit) this is irrelevant at realistic rates.
For the shell token — same length, so also irrelevant in practice.
But if an operator shortens the admin/shell token (env-var override),
rotates to a lower-entropy custom token, or adds an HTTP POST /rpc
path that behaves similarly (it does — see `rpcServer.ts:856`), the
lack of rate limiting is the last line of defence.

**Remediation.**

- Rate-limit by source IP (for non-loopback connections) using a
  token-bucket: 10 failed auth attempts per minute per IP, then
  drop and exponential-backoff.
- Log failed-auth events with the remote IP so abuse is observable.
- Similarly rate-limit HTTP POST `/rpc` with Bearer auth.

---

### 2.12 [Low] `authTokens.persist` trusts `extra` without filtering

**File:** `src/server/services/authService.ts:185-192`

```ts
const stored: OAuthCredentials & { storedAt: number } = {
  access: credentials.access,
  refresh: credentials.refresh,
  expires: credentials.expires,
  ...((credentials.extra ?? {}) as Record<string, unknown>),
  storedAt: Date.now(),
} as OAuthCredentials & { storedAt: number };
```

`extra` is spread in the middle of the object. `storedAt` at the end
overrides anything in `extra`, so the timestamp is safe. But any
other protected field isn't: a caller can submit
`extra: { access: "otherToken" }` — spread overrides the earlier
`access`. Today the code happens to place `access/refresh/expires`
*before* the spread, so an attacker controls the post-spread values,
meaning they can **replace** those fields with arbitrary content.

This reinforces the criticality of §2.1: the policy matters because
the trust boundary of `persist` is wide.

**Remediation.**

- Reject `extra` keys that collide with protected top-level fields
  (`access`, `refresh`, `expires`, `storedAt`). Validate against an
  allow-list per provider.

---

### 2.13 [Low] Codex `originator` hard-coded to impersonate official CLI

**File:** `packages/auth-flow/src/providers/openaiCodex.ts:50-55`

```ts
// Must match a value OpenAI has allowlisted for this client_id. The
// official openai/codex Rust CLI uses "codex_cli_rs" as the canonical
// value (see codex-rs/login/src/auth/default_client.rs DEFAULT_ORIGINATOR).
url.searchParams.set("originator", opts.originator ?? "codex_cli_rs");
```

The default `originator` value impersonates the official OpenAI Codex
CLI. This is functionally required because the shared `client_id`
(`app_EMoamEEZ73f0CkXaXp7hrann`) refuses unknown originators. It is
nonetheless worth flagging as:

- A *ToS surface.* OpenAI may change their allow-list at any time, and
  the behavior is contingent on a specific client's ID. If OpenAI
  revokes the client, all NatStack Codex users lose access. More
  importantly, if OpenAI considers this impersonation a ToS violation,
  users could be penalized.
- A *supply-chain data-point.* NatStack traffic to OpenAI is
  indistinguishable from `codex` CLI traffic on the wire. Users may
  not realize this is how the flow works.

**Remediation.** Register a dedicated OpenAI OAuth client for
NatStack and use its id + allowlisted `originator`.

---

### 2.14 [Low] Flow-id timer leak on `startFlow` abandonment

**File:** `src/server/services/authFlowService.ts:56-66`

```ts
const timer = setTimeout(() => {
  pendingFlows.delete(flowId);
}, FLOW_TIMEOUT_MS);
pendingFlows.set(flowId, {
  providerId,
  session,
  timer,
});
return { flowId, authUrl };
```

`pendingFlows` is cleared on completion, error, or the 10-minute
timeout. However, on server shutdown, the timer callbacks keep the
process alive; more importantly, the in-memory table has no upper
bound: a caller with RPC access can flood `startOAuthLogin` to
allocate up to 10-minutes' worth of entries. At 1 call/ms that's
600k entries ~= mid-tens-of-MB memory footprint, which is not
catastrophic but is a trivial DoS vector from any authenticated
caller (and `auth.startOAuthLogin` policy is `["shell","panel",
"worker","server"]`).

**Remediation.**

- Cap `pendingFlows.size` and reject new flow starts past the cap.
- Rate-limit `startOAuthLogin` per caller.
- `timer.unref()` so abandoned flows don't keep the process alive.

---

### 2.15 [Low] `ServiceDispatcher` overwrites existing handlers silently

**File:** `packages/shared/src/serviceDispatcher.ts:114-120`

```ts
registerService(def: ServiceDefinition): void {
  if (this.handlers.has(def.name) || this.definitions.has(def.name)) {
    console.warn(`[ServiceDispatcher] Overwriting handler for service: ${def.name}`);
  }
  this.definitions.set(def.name, def);
  this.handlers.set(def.name, def.handler);
}
```

A warning is logged but registration proceeds. A plugin or extension
that re-registers a core service by name (e.g. `"authTokens"`) can
silently replace its handler and policy. Since extension discovery
exists (`getServiceDefinitions` is used by extension loaders),
defense-in-depth is warranted.

**Remediation.** Throw rather than warn. Require explicit
`unregisterService` or deregistration guard.

---

### 2.16 [Low] Redirect URI path check in `authFlowService.completeFlow` doesn't compare host

**File:** `src/server/services/authFlowService.ts:80-82`

```ts
if (callback.pathname !== new URL(pending.session.redirectUri).pathname) {
  throw new Error("OAuth callback path mismatch");
}
```

Only the pathname is compared. A callback URL with the same path but
a different host (or scheme) passes the check. The downstream token
exchange uses `pending.session.redirectUri`, so the provider still
validates it against what was sent at /authorize, meaning the flow
will fail at the provider. But the local check is weaker than
advertised, and a future refactor that passes `callback.host`
through instead would be broken silently.

**Remediation.** Compare `origin + pathname` (or host + pathname +
protocol) to prevent scope confusion.

---

### 2.17 [Info] `apps/webhook-relay` is a stub

**File:** `apps/webhook-relay/src/index.ts`

The entire webhook-relay worker is 64 lines: it accepts any POST to
`/webhook/{instanceId}/{providerId}`, returns `{received: true}`, and
performs no HMAC verification, no authentication, no replay protection,
and no forwarding. All three scope items (HMAC / token / replay) are
simply absent.

This is out of scope for exploit classification because there is no
real logic, but it is worth flagging so it doesn't land in production
without the guards its scope implies. The verifier library in
`packages/shared/src/webhooks/verifier.ts` exists and should be wired
in before this worker ships.

---

## 3. Positive Observations

- **Token generation** uses `crypto.randomBytes(32).toString("hex")`
  (`packages/shared/src/tokenManager.ts:34`, `src/server/index.ts:639`,
  `src/server/services/tokensService.ts:82`). No `Math.random` in any
  security-sensitive path was found in the audit scope.
- **PKCE** is implemented correctly: 32-byte random verifier, SHA-256
  challenge, base64url encoding (`packages/auth-flow/src/pkce.ts:17-25`).
- **OAuth state** is generated as 16 random bytes (128 bits)
  (`packages/auth-flow/src/pkce.ts:28-32`) and compared in
  `authFlowService.ts:87-90`.
- **File permissions** are consistently `0o600` for secrets files and
  `0o700` for the central-config directory (`centralAuth.ts:37-47`,
  `authService.ts:133`, `store.ts:51-56`, `remoteCredentialStore.ts:99`).
- **Electron safeStorage** (OS keychain) encrypts the remote admin
  token at rest on the client (`remoteCredentialStore.ts:82-103`) with
  a fallback warning.
- **TLS pinning** is implemented for remote connections in
  `tlsPinning.ts` and wired through both `serverClient.ts` and
  `remoteHealthPoll.ts` with secure-connect-time cert validation that
  runs before any app-layer bytes are sent.
- **Admin token redaction** in WS client error logs
  (`serverClient.ts:162, 240`) prevents accidental leakage to logs.
- **Admin token header form** (`X-NatStack-Token`) is preferred over
  query-string for the health poller (`remoteHealthPoll.ts:110-112`)
  to keep the token out of URLs / referers.
- **Timing-safe HMAC comparison** for webhook signatures
  (`packages/shared/src/webhooks/verifier.ts` uses
  `crypto.timingSafeEqual` throughout), even though freshness checks
  are missing (§2.9).
- **Deep-link validation** for `natstack://connect` on mobile
  (`deepLinkConnect.ts`) rejects cleartext HTTP except for loopback,
  RFC1918, and Tailscale hosts, and requires user confirmation before
  applying any credential replacement (`LoginScreen.tsx:30-45, 123`).
- **Disconnect grace window** is bounded at 3 s
  (`rpcServer.ts:133`) and invariants for reconnect waiters are
  explicitly tested against unknown errors.
- **Path traversal guard** exists in `contextPaths.ts` and is applied
  by `resolveContextScope` for context-scoped filesystem operations
  (though not by `CredentialStore`, see §2.2).

---

## 4. Recommendations (prioritized)

1. **Immediately:** lock down `authTokens` service policy to server-only
   (§2.1).
2. **Immediately:** sanitize `providerId` / `connectionId` in
   `CredentialStore` and assert `resolvedPath.startsWith(basePath)` (§2.2).
3. **Immediately:** apply ACL to non-panel callers in `checkRelayAuth`
   (§2.3).
4. **High priority:** HMAC-authenticate the egress proxy headers and
   narrow the proxy bind to the workerd process (§2.4).
5. **High priority:** wire `consumePendingFlow` into a deep-link
   router on mobile, and add universal links (§2.6).
6. **High priority:** make `managementToken` required and fail closed
   on null (§2.5).
7. **Medium priority:** add state + TTL + caller-binding to
   `credentialService.pendingConsents` (§2.7).
8. **Medium priority:** switch admin/management-token compares to
   `crypto.timingSafeEqual` (§2.8).
9. **Medium priority:** add timestamp freshness checks to Slack and
   Stripe webhook verifiers (§2.9).
10. **Medium priority:** fix `server-loopback` / `client-loopback`
    redirect URIs (§2.10).
11. **Medium priority:** add rate-limiting on WS auth and HTTP POST
    `/rpc` auth paths (§2.11).
12. **Low priority:** filter `authTokens.persist` `extra` keys (§2.12),
    cap/unref flow tables (§2.14), tighten `ServiceDispatcher`
    re-registration (§2.15), and deepen redirect-URI parity checks
    (§2.16).
13. **Low priority:** register a first-class OpenAI OAuth client for
    NatStack rather than impersonating Codex CLI (§2.13).
14. **Before shipping webhook-relay:** wire the verifier library and
    add authentication (§2.17).

---

## 5. Files Reviewed

### Server-side auth
- `src/server/services/authService.ts`
- `src/server/services/authService.test.ts`
- `src/server/services/authFlowService.ts`
- `src/server/services/authFlowService.test.ts`
- `src/server/services/tokensService.ts`
- `src/server/services/credentialService.ts`
- `src/server/services/egressProxy.ts`
- `src/server/services/oauthProviders/codexTokenProvider.ts`

### Gateway / RPC transport
- `src/server/gateway.ts`
- `src/server/rpcServer.ts`
- `src/server/wsServerTransport.ts`
- `src/server/panelHttpServer.ts`
- `src/server/index.ts` (auth-token provisioning paths only)
- `src/server/headlessServiceRegistration.ts`
- `src/server/panelRuntimeRegistration.ts`

### Main-process auth / session
- `src/main/services/authService.ts`
- `src/main/services/contextMiddleware.ts`
- `src/main/serverSession.ts`
- `src/main/serverClient.ts`
- `src/main/remoteCredentialStore.ts`
- `src/main/startupMode.ts`
- `src/main/remoteHealthPoll.ts`
- `src/main/servicePolicy.test.ts`
- `src/main/serviceDispatcher.test.ts`

### Auth-flow package
- `packages/auth-flow/src/index.ts`
- `packages/auth-flow/src/pkce.ts`
- `packages/auth-flow/src/types.ts`
- `packages/auth-flow/src/providers/openaiCodex.ts`

### Shared primitives
- `packages/shared/src/tokenManager.ts`
- `packages/shared/src/centralAuth.ts`
- `packages/shared/src/servicePolicy.ts`
- `packages/shared/src/serviceDispatcher.ts`
- `packages/shared/src/contextMiddleware.ts`
- `packages/shared/src/redact.ts`
- `packages/shared/src/credentials/store.ts`
- `packages/shared/src/credentials/flows/deviceCode.ts`
- `packages/shared/src/webhooks/verifier.ts`

### Mobile auth
- `apps/mobile/src/services/auth.ts`
- `apps/mobile/src/services/authCallbackRegistry.ts`
- `apps/mobile/src/services/codexAuthFlow.ts`
- `apps/mobile/src/services/deepLinkConnect.ts`
- `apps/mobile/src/services/bridgeAdapter.ts`
- `apps/mobile/src/services/biometricAuth.ts` (referenced, not deep-read)
- `apps/mobile/src/services/pushNotifications.ts` (referenced for device-id
  storage)
- `apps/mobile/src/components/LoginScreen.tsx`

### Webhook relay
- `apps/webhook-relay/src/index.ts`

---

*End of report.*

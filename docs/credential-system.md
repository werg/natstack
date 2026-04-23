# Credential System — Replacing Nango

Status: Plan. Nothing in this doc is implemented yet.

## Background

### The Nango problem

We prototyped third-party API access via [Nango](https://www.nango.dev/),
a hosted OAuth broker. In practice it was a poor fit:

- **Hosted-UI configuration.** Every provider integration has to be
  configured by hand in the Nango dashboard — OAuth app registration,
  redirect URIs, secret key rotation, per-deployment plumbing. That
  directly contradicts how we want to develop natstack: programmatically,
  from code checked into this repo.
- **Per-operator friction.** Each self-hoster would have to repeat the
  Nango dashboard dance for every provider. There's no way to ship
  "works out of the box" with a downloaded natstack binary.
- **Runtime mismatch.** Nango is a hosted service you proxy through;
  we're a local-first JS runtime where the natural idiom is
  `npm install @octokit/rest` and call it. A hosted broker is the wrong
  shape.

The existing Nango code is prototype only. Nothing in production depends
on it, so we can delete rather than migrate.

### What we looked at

To ground the replacement design we surveyed how three adjacent agent
frameworks organise third-party API integration:

- **OpenClaw** (`openclaw/openclaw`, Node/TS). Explicitly rejects a
  hosted broker. Default auth is **loopback PKCE** — the agent itself is
  the OAuth client, callback lands on `127.0.0.1:1455`. Falls back to
  **device-code** flow and **CLI piggyback** (reuses existing `claude` or
  `gogcli` creds). Plugins are TS ESM modules with a JSON-Schema
  manifest; credentials live in `~/.openclaw/` as file-locked JSON.
  Closest to what we want.
- **Hermes Agent** (`NousResearch/hermes-agent`, Python). Four different
  auth patterns chosen per-integration: bot-token paste for messaging
  platforms, `gh auth token` scraping for GitHub, user-registered Google
  OAuth client with localhost PKCE, **and full OAuth 2.1 + Dynamic
  Client Registration** for MCP servers. The MCP + DCR path is the
  single cleanest "no app registration at all" pattern in the ecosystem.
- **NanoClaw** (`qwibitai/nanoclaw`, Bun/TS). BYO-token for everything;
  integrations ship as npm packages pulled in by a Claude Code skill
  that appends a one-line import. Introduces a local "Agent Vault"
  proxy that injects credentials so the agent process never holds raw
  keys — the pattern we're stealing for our egress proxy.

### What we learned

Four ideas translated directly into this plan:

1. **Ship one public OAuth client per provider, `client_id` in the
   repo.** This is how `gh`, `gcloud`, `az`, VS Code, and Claude Code
   all work. It is nothing like Nango's "register per deployment in a
   dashboard" model. Users get a zero-ceremony consent screen; operators
   do nothing. The one real cost is **provider verification** (mainly
   Google's sensitive-scope review) which we defer by allowing BYO
   `client_secret.json` as a v0 fallback.
2. **Loopback PKCE + device code as the default OAuth flows.**
   No hosted callback endpoint needed. OpenClaw proves this works for a
   local-first Node runtime.
3. **MCP + DCR for the long tail.** For any SaaS with an MCP server on
   Cloudflare's `workers-oauth-provider`, WorkOS AuthKit, Stytch, etc.
   (Notion, Linear, Asana, Atlassian, Sentry, Stripe…) Dynamic Client
   Registration means **zero OAuth app registration** — the server mints
   a `client_id` on demand. We inherit the entire MCP ecosystem by
   implementing the flow once.
4. **Credentials injected at the egress boundary, not handed to the
   worker.** NanoClaw's pattern: a local proxy stamps `Authorization`
   headers on outbound requests so the agent sandbox never sees tokens.
   This is a real security win and it lets integration authors call
   plain `fetch()` without a provider-specific client.

### Decisions

Explicit choices made during the design discussion, recorded here so
future readers don't have to reconstruct the reasoning:

- **Option A over B and C as the default.** We considered three
  approaches for the big providers: (A) pre-registered natstack-owned
  public OAuth clients, (B) personal access tokens, (C) CLI piggyback
  on locally-installed `gh` / `gcloud` / `az`. A is chosen as the
  default because it gives zero-ceremony onboarding for non-dev users.
  B and C remain in every manifest's `flows` list as fallbacks — Option
  A is the default, not the only path.
- **Per-provider strategy:**
  - GitHub → device flow primary (no callback needed), PAT + `gh`
    piggyback as fallbacks.
  - Microsoft → device flow, `az` piggyback. Cleanest of the big four.
  - Google → loopback PKCE with BYO `client_secret.json` for v0 to
    avoid Google's multi-month sensitive-scope verification. Migrate to
    a verified natstack Google client later.
  - Slack → distributed natstack Slack app with Socket Mode primary,
    manifest-guided self-install fallback. No device flow exists for
    Slack.
  - Notion → MCP + DCR primary, internal-integration-token fallback.
    We get Notion essentially for free.
- **Mechanisms in core, providers as data.** The core knows about five
  flow types (loopback PKCE, device code, MCP DCR, PAT, CLI piggyback).
  Providers are manifests — pure data — so adding a new provider is
  never a core change. Adding a new *flow type* is a core change but
  should be rare.
- **Host-side egress proxy, not a worker-side `authedFetch` wrapper.**
  The worker SDK surface is deliberately tiny (`requestConsent`,
  `revokeConsent`) and integrations use plain `fetch()`. The proxy
  matches request hosts against manifest `apiBase` patterns and stamps
  `Authorization` headers. Tokens never cross into the worker sandbox.
- **TLS interception via a local CA** in the egress proxy. The only way
  to stamp headers on HTTPS without cooperation from the worker SDK.
  The CA is minted locally per-install and injected into workerd's
  trust store. We accept the extra complexity to preserve the
  zero-ceremony `fetch()` story.
- **Third-party providers as npm packages.** Anyone can publish
  `@someone/natstack-provider-foo` with their own `client_id` and a
  manifest; users install it and it registers on startup. No core PR,
  no hosted registration, no natstack involvement.

## Goal

Replace the unused Nango prototype with a code-first, JS-native credential
system that:

- Needs zero hosted-UI configuration. Providers are declared as data
  (manifests), not configured through a dashboard.
- Ships one natstack-owned public OAuth client per first-party provider,
  `client_id` committed to this repo. Same model as `gh`, `gcloud`, `az`,
  VS Code, Cursor, Claude Code.
- Keeps raw tokens out of the worker sandbox. Integrations call plain
  `fetch()`; a host-side egress proxy stamps `Authorization` headers based on
  URL matching against the manifest.
- Lets third parties add new providers and integrations as plain npm
  packages — no core PR, no hosted registration.

Non-goals: multi-tenant cloud auth, enterprise SSO, a hosted OAuth broker.

## Target architecture (recap)

Three layers:

1. **Core (host process, outside workerd)** — provider-agnostic flow
   runners, token store, refresh scheduler, egress proxy. ~800 LOC.
2. **Provider manifests** — pure data describing a provider's endpoints,
   `client_id`, supported flows, API host patterns. First-party manifests
   ship in this repo; third parties publish their own npm packages.
3. **Worker SDK** — a tiny surface (`requestConsent`, plain `fetch`) that
   RPCs the host for consent and routes outbound requests through the
   egress proxy. Tokens never enter the worker.

## Demolition

All of the following is prototype and unused. Delete, don't migrate.

### Code

- `packages/shared/src/oauth/oauthManager.ts`
- `src/server/services/oauthService.ts`
- `workspace/packages/runtime/src/shared/oauth.ts`
- `workspace/packages/runtime/src/panel/oauth.ts`
- `workspace/packages/integrations/src/gmail.ts`
- `workspace/packages/integrations/src/calendar.ts`
- `workspace/packages/integrations/src/index.ts` (re-exports of the above;
  rewrite against the new SDK later)
- `apps/mobile/src/services/oauthHandler.ts` (deep-link handler for
  `natstack://oauth-callback`; see mobile decision below)
- `workspace/panels/email/index.tsx` (24.6 KB — entirely built around the
  old OAuth consent flow; rewrite from scratch once the new SDK lands)
- `workspace/panels/email/DESIGN.md` (describes the Nango flow)
- `src/server/services/secretsService.ts` — dead code; no live
  callers. The only consumers were the Nango secret lookup
  (`secrets.get("nango")` in `oauthManager.ts`) and a legacy
  fallback path in `authService.ts` that prefers env vars in
  practice. Verified: no UI or panel calls `secrets.setSecret`.
- `packages/shared/src/secrets/secretsStore.ts` — the store itself.
- `src/renderer/components/NotificationBar.tsx`'s `type: "consent"`
  render path. Delete the whole component if nothing non-consent
  uses it. (Check during Wave 1; the replacement `ConsentDialog`
  is added in Wave 5.)

### Database

- Drop `oauth_tokens` table
- Drop `oauth_consent` table
- No data migration — nothing is in production use

### Config / secrets

- Delete `~/.config/natstack/.secrets.yml` support entirely — the
  secrets store goes with the secrets service. New credential
  tokens live under `~/.natstack/credentials/` per the new design.
- Remove `NANGO_URL` env var handling from `src/server/index.ts`
- Remove the `nango:` YAML key and `nangoUrl` config support from
  `workspace/meta/natstack.yml`
- Migrate `authService.ts`'s remaining secret fallback to read env
  vars only; drop the `secretsStore` dependency.

### Docs

- `docs/remote-server.md` — strip Nango callback section
- `workspace/skills/api-integrations/SKILL.md` — rewrite entirely against
  the new system (this is where integration authoring is documented)
- `workspace/skills/onboarding/SKILL.md` — remove Nango setup step
- `workspace/skills/onboarding/GETTING_STARTED.md` — remove Nango setup
  step
- `workspace/meta/natstack.yml` config template — drop Nango keys and their
  comments

Grep for `nango` (case-insensitive) once at the end of the demolition pass
and verify zero hits.

## New module layout

### Core credential engine

`packages/shared/src/credentials/`

- `types.ts` — `ProviderManifest`, `FlowConfig`, `Credential`,
  `CredentialHandle`, `ConsentGrant`.
- `store.ts` — filesystem token store under
  `~/.natstack/credentials/<providerId>/<connectionId>.json`, 0o600 perms,
  atomic write via `fs.rename`, mtime-watch so external processes (other
  natstack instances, CLI refreshes) pick up changes without restart. No
  SQLite, no keychain dependency.
- `flows/loopbackPkce.ts` — binds `127.0.0.1:<random>`, opens browser,
  captures code, exchanges for token. The listener's lifecycle is
  tied to the consent dialog, not a timer: it stays bound as long
  as the dialog is open, and the port is released when the user
  completes the flow or cancels the dialog. No automatic timeout —
  slow users (2FA, password managers, account pickers) never lose
  their flow to an arbitrary clock.
- `flows/deviceCode.ts` — initiates device flow, displays user code,
  polls token endpoint with backoff.
- `flows/mcpDcr.ts` — full MCP authorization flow: resource metadata →
  AS metadata → DCR register → auth code + PKCE + resource indicator →
  token → refresh.
- `flows/pat.ts` — prompts for a pasted token; optionally verifies via
  a manifest-supplied probe endpoint.
- `flows/cliPiggyback.ts` — runs a configured command (`gh auth token`,
  `gcloud auth print-access-token`, etc.), parses stdout or a JSON path.
- `flows/composioBridge.ts` — v0-only bridge: delegates OAuth to
  Composio's verified provider apps, retrieves the resulting access
  token, stores it in our native credential store. Used by the Google
  manifest until our own Google verification completes; usable by any
  future provider where we can't ship our own verified client in time.
- `flows/serviceAccount.ts` — non-interactive: loads a provider
  service-account credential blob (Google service-account JSON,
  AWS IAM credentials, etc.), handles its own refresh. For headless
  deployments. See **Service accounts / non-interactive mode**.
- `flows/botToken.ts` — non-interactive: long-lived bot tokens (Slack
  `xoxb-`, Discord bot tokens, Telegram `@BotFather` tokens). Stored
  as-is; no refresh.
- `flows/githubAppInstallation.ts` — non-interactive: GitHub App
  installation tokens generated from a private key. Handles
  short-lived installation token minting and refresh.
- `flows/index.ts` — dispatcher keyed on `flow.type`.
- `capability.ts` — URL + method matcher. Given a request
  (worker + url + method) and the worker's granted consent records,
  decides: allow, deny, or warn. The enforcement point for
  capability-based security.
- `rateLimit.ts` — per-provider, per-connection token bucket honouring
  manifest-declared limits and `Retry-After` headers.
- `retry.ts` — exponential backoff, max-attempt caps, per-worker
  circuit breaker. Wraps outbound requests inside the proxy.
- `audit.ts` — structured append-only log at
  `~/.natstack/logs/credentials-audit-YYYY-MM-DD.jsonl`, rotated
  daily, size-capped. Exposes a query API consumed by a
  `credentials.audit` RPC.
- `reconsent.ts` — handles refresh failure. On a 401 after refresh
  attempt, triggers `notificationService` for re-consent,
  suspends the in-flight request, retries once re-consent
  completes. Transparent to the integration.
- `resolver.ts` — runs a manifest's `flows` list in order, returns the
  first success. Used on initial consent and on refresh failure.
- `refresh.ts` — scheduler; reads `expires_at`, refreshes ahead of
  expiry using the per-provider manifest `refreshBufferSeconds`
  (default 60s; overridable per provider because some providers'
  refresh endpoints are slow under load). Coalesces concurrent
  refresh requests. Falls back through the resolver chain on
  failure. **Synchronous-with-request refresh** is also
  unconditionally supported as a fallback: if a request reaches
  the proxy with an already-expired token (proactive refresh
  missed its window, clock skew, etc.), the proxy refreshes
  synchronously before forwarding. Proactive refresh is
  optimisation, not correctness.
- `registry.ts` — loads provider manifests. First-party manifests imported
  statically; third-party manifests loaded from a configured list in
  `natstack.yml` (`providers: ["@someone/natstack-provider-asana"]`).
- `consent.ts` — per-worker grant store (which worker has been granted
  which provider + scopes). Backed by a new SQLite table
  `credential_consent(worker_id, provider_id, scopes, granted_at,
  connection_id)`.

### First-party provider manifests

`packages/shared/src/credentials/providers/`

- `github.ts` — device-code primary, loopback-PKCE fallback, PAT fallback,
  `gh auth token` piggyback. `apiBase: ["https://api.github.com",
  "https://uploads.github.com"]`.
- `google.ts` — **composio-bridge primary for v0** (see Google
  section under Resolved decisions), with loopback-PKCE and
  device-code as switched-on-verification-completes alternates, and
  BYO `client_secret.json` as a final fallback for users who don't
  want the Composio dependency. `apiBase:
  ["https://gmail.googleapis.com", "https://www.googleapis.com",
  "https://oauth2.googleapis.com"]`. Scopes split by Google product
  (mail, calendar, drive) so consent stays minimal. When natstack's
  own Google verification completes, the primary flow becomes
  `loopback-pkce` via a single manifest edit; no integration code
  changes.
- `microsoft.ts` — device-code primary, loopback-PKCE fallback,
  `az account get-access-token` piggyback. Multi-tenant app.
- `notion.ts` — MCP+DCR primary (`resource:
  https://mcp.notion.com`), integration-token PAT fallback.
- `slack.ts` — loopback-PKCE primary against a distributed natstack Slack
  app, manifest-guided self-install fallback (user creates their own app
  from a shipped manifest JSON, pastes bot token). No device flow
  available.
- `index.ts` — exports the array; imported by `registry.ts`.

Each manifest is a constant. The natstack-owned `client_id`s live here in
source, checked into the repo. Self-hosters can override per-provider via
`natstack.yml` if they want their own branded consent screen.

### Host services

Additionally, a sibling package:

`packages/shared/src/webhooks/`

- `types.ts` — `WebhookSubscription`, `WebhookEvent`,
  `WebhookVerifier`.
- `receiver.ts` — long-lived WebSocket client that connects to the
  natstack webhook relay (see below) and accepts events forwarded
  from the public HTTPS endpoint.
- `verifier.ts` — per-provider HMAC / signature verification. GitHub
  `X-Hub-Signature-256`, Slack `v0=...`, Stripe `Stripe-Signature`,
  etc. Pluggable via provider manifest's `webhooks.verify` field.
- `router.ts` — dispatches verified events to the right worker /
  integration based on subscription records.
- `subscription.ts` — stores `{ workerId, providerId, eventType,
  secret }` records in SQLite; reconciles with provider-side
  registration (for providers where the subscription itself needs
  API calls, e.g. GitHub webhooks via the repos API).

A separate `apps/webhook-relay/` Cloudflare Worker provides the
public HTTPS endpoint. See **Webhooks** under Extended capabilities.

### Test utilities

`packages/shared/src/credentials/test-utils/`

- `mockOAuthServer.ts` — in-memory OAuth 2.1 + PKCE server,
  configurable to simulate device code, loopback PKCE, DCR, refresh
  rotation, refresh failure. Runs on a random port.
- `mockProvider.ts` — fake provider API accepting any Bearer token,
  with deterministic responses driven by fixtures.
- `fixtureRecorder.ts` — VCR-style HTTP recorder: record real
  interactions against a real provider once, replay deterministically
  in tests.
- `mockWebhookRelay.ts` — in-process webhook event injector for
  testing event-driven integrations without the real relay.

Published as `@natstack/credentials-test-utils` so third-party
provider authors can use the same harness we do.

`src/server/services/credentialService.ts` — replaces the old
`oauthService.ts`. RPC methods exposed to workers and UIs via the
existing `/rpc` endpoint:

- `credentials.beginConsent({ providerId, scopes, accountHint?,
  role?, redirect }) → { nonce, authorizeUrl }` — the **universal**
  browser-OAuth entry point. Server mints a PKCE challenge, holds
  the verifier, returns the authorize URL. `redirect` is one of:
  - `"server-loopback"` — optimisation for the local-Electron-on-
    same-host case. Server binds `127.0.0.1:<random>` and waits for
    the provider callback itself.
  - `"client-loopback"` — the initiating client binds its own local
    loopback port and captures the callback; used whenever the
    server is remote (VPS, LAN host, Tailscale) and the user's
    browser can't reach the server's `127.0.0.1`.
  - `"mobile-universal"` — universal/app link back to the mobile
    app (see Mobile).
- `credentials.completeConsent({ nonce, code }) → { connectionId,
  apiBase }` — the client relays the captured authorization code;
  server exchanges it using the held verifier and stores the
  resulting tokens. Returns the handle (see SDK contract).
- `credentials.requestConsent({ providerId, scopes, accountHint?,
  role? }) → CredentialHandle` — convenience for the
  `"server-loopback"` case: calls `beginConsent` with that redirect,
  opens the browser on the server, and waits for its own callback
  listener to complete. Equivalent to calling `beginConsent` +
  `completeConsent` for server-colocated flows. Blocks until the
  user approves, denies, or cancels. Does **not** return the token.
- `credentials.revokeConsent({ providerId }) → void`
- `credentials.listConsent({}) → ConsentGrant[]` — for UI/debug.
- `credentials.audit({ filter?, limit?, after? }) → AuditEntry[]` —
  queries the audit log. Honours per-caller scoping (a panel can
  only see its own worker's entries; shell callers see everything).
- `credentials.subscribeWebhook({ providerId, eventType, workerId })
  → { subscriptionId }` — registers a webhook subscription; handles
  both natstack-side routing and (where applicable) provider-side
  webhook registration via the provider's API.
- `credentials.unsubscribeWebhook({ subscriptionId }) → void`

No `getToken` RPC. Tokens never leave the host.

**Non-interactive mode.** When the server is started with
`--non-interactive` (or `credentials.nonInteractive: true` in
`natstack.yml`), `requestConsent` and `beginConsent` throw
`NonInteractiveConsentRequired` if no valid credential is already
present for the requested provider + scopes. Intended for CI,
scheduled jobs, and server-side deployments where there's no human
to answer a prompt. The interactive `service-account`, `bot-token`,
and `github-app-installation` flows are preferred in this mode.

The consent prompt is surfaced by delegating to
`notificationService.show({ type: "consent:credential", ... })`; a
new `ConsentDialog` component renders it. See **Consent UI:
purpose-built dialog** under Resolved decisions and **Consent UI
redesign** under Extended capabilities for layout and design
principles.

`src/server/services/egressProxy.ts` — the heart of the new system. See
next section.

### Egress proxy

A local HTTP forward proxy on `127.0.0.1:<random-port>`, started alongside
`workerdManager`. Per-worker authentication via a proxy-auth token minted
when the worker is spawned (parallel to the existing `RPC_AUTH_TOKEN`).

Responsibilities, executed as a layered middleware pipeline per
outbound request:

1. **Ingress**: receive outbound HTTP(S) requests from workers.
   **The transport mechanism is a critical open question that the
   Wave 1 spike resolves.** Workerd does not honour Node-style
   `HTTP_PROXY` / `HTTPS_PROXY` env vars; worker `fetch()` flows
   through its own HTTP stack. The likely-correct wiring is a
   Cap'n Proto `ExternalServer` service entry whose `address`
   points at the egress proxy's local `127.0.0.1:<port>`, bound
   as the worker's `globalOutbound` — so every worker `fetch(url)`
   is redirected to the proxy, passing the original target URL
   through a header or path convention the proxy unwraps. (Note:
   workerd's `Network` service type is an allow/deny policy with
   TLS options and no address field; `ExternalServer` is the
   service type that targets a specific host/port.) TLS
   termination (if the spike confirms it's viable) happens here
   via the local CA. See Wave 1 spike and Resolved decisions.
2. **Attribution**: identify the originating worker from the
   proxy-auth header; look up its consent grants and declared
   integration manifests.
3. **Capability enforcement** (`capability.ts`): match request URL +
   method against the worker's granted `endpoints` declarations.
   On miss: deny (configurable to `warn` in dev). Denied requests
   never leave the host; they return a structured 403 body to the
   worker with the violated capability. See **Capability-based
   security**.
4. **Provider routing**: match request URL host against the `apiBase`
   patterns of every granted provider manifest.
5. **Rate limiting** (`rateLimit.ts`): consume a token from the
   per-connection bucket defined by the manifest's
   `rateLimits`. If exhausted, either delay up to a configurable
   cap or fail fast with 429. Honours `Retry-After` headers from
   prior upstream 429s.
6. **Auth injection**: inject `Authorization: Bearer <token>` using
   the current access token from the store. Re-check expiry using
   the provider manifest's `refreshBufferSeconds` (default 60s) —
   refresh synchronously before forwarding if within the buffer or
   already expired. Synchronous refresh is unconditional; it runs
   even when proactive refresh was supposed to have handled it.
7. **Circuit breaker + retry** (`retry.ts`): forward the request.
   On 5xx/network errors, retry with exponential backoff up to a
   manifest-configured cap (conservative default: 2 retries;
   idempotent methods only). A trip of the circuit breaker requires
   sustained failure — not a 30-second blip — and its state is
   **observable and user-resettable** in the UI (a banner in the
   relevant panel showing "GitHub appears down, retrying" with a
   "Try now" action). Tuning defaults in the manifest lean heavily
   toward "keep trying" rather than "give up."
8. **401 handling** (`reconsent.ts`): on 401 after refresh attempt,
   trigger re-consent via `notificationService`, suspend the
   in-flight request, retry once consent is re-granted.
9. **Audit** (`audit.ts`): append a structured record to the audit
   log: `{ ts, workerId, callerId, providerId, connectionId, method,
   url, status, durationMs, bytesIn, bytesOut, scopesUsed,
   capabilityViolation?, retries, breakerState }`. Daily rotation,
   size cap.
10. **Egress**: stream the response back to the worker.
11. **No-match passthrough** (default-allow for unmatched
    destinations): if the request doesn't match any granted
    provider's `apiBase`, forward unchanged — no auth injection,
    no capability enforcement, still audited. Public
    unauthenticated endpoints continue to work from workers
    without any manifest declaration. This is an **explicit
    decision**: we prioritise integration ergonomics (third-party
    API calls, library CDN fetches, health checks to arbitrary
    hosts) over exfiltration protection. A stricter default-deny
    policy is noted in Out of scope as a potential hardening
    upgrade if operational data justifies it.

Implementation notes:

- Use Node `http` + `https` module with `CONNECT` tunneling for TLS.
  Don't terminate TLS (no MITM); match on the CONNECT host only. This
  means header injection happens *inside* the TLS tunnel, which won't
  work for HTTPS. See the decision below.
- Alternative: terminate TLS with a per-session local CA, inject
  headers, re-encrypt. More code but lets us match on full URL and
  inject reliably. Cost: the worker has to trust the local CA cert,
  which we control via workerd's cert store.
- **Decided in plan**: terminate TLS locally. It's the only way to
  stamp headers on HTTPS without cooperation from the worker SDK.
  `@peculiar/x509` or `node-forge` to mint the CA; inject into
  workerd's trust store at boot.

### Worker SDK additions

`workspace/packages/runtime/src/worker/credentials.ts`:

```ts
type CredentialHandle = {
  connectionId: string;
  apiBase: string[];
  // Authenticated fetch that stamps the X-Natstack-Connection
  // header for this specific connection. Use this when the worker
  // has multiple connections for the same provider (multi-role
  // integrations) or when you want explicit disambiguation.
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
};

export async function requestConsent(
  providerId: string,
  opts?: { scopes?: string[]; accountHint?: string; role?: string },
): Promise<CredentialHandle>;

export async function revokeConsent(
  providerId: string,
  connectionId?: string,
): Promise<void>;
```

**Uniform return shape.** Every `requestConsent` call returns a
`CredentialHandle`. Single-role callers get the same shape as
multi-role callers — no special cases, no branching based on
whether roles are declared. This was inconsistent in earlier
drafts (`{ connectionId, apiBase }` vs. `{ .fetch() }`); resolved
to the shape above.

**Plain `fetch()` still works** when the worker has a single
connection for a provider, because the manifest-autodiscovery pass
at worker startup declares a default connection per (provider,
role) tuple. The egress proxy uses the default when no
`X-Natstack-Connection` header is present. So:

```ts
// Single-role integration
const gh = await requestConsent("github");
await fetch("https://api.github.com/user");       // works; default connection
await gh.fetch("https://api.github.com/user");    // also works; explicit connection

// Multi-role integration
const source = await requestConsent("github", { role: "source" });
const target = await requestConsent("github", { role: "target" });
await source.fetch(".../issues");                  // stamps source connectionId
await target.fetch(".../issues", { method: "POST" });
// Plain fetch() is ambiguous here and returns 400 with a helpful error.
```

There is no `getToken`. There is no `authedFetch`. The only
difference between plain `fetch()` and `handle.fetch()` is that
the handle disambiguates when a worker has multiple connections
for the same provider.

Delete the old `workspace/packages/runtime/src/shared/oauth.ts` and
`panel/oauth.ts`.

### Integration manifest

Integrations declare required providers, scopes, the specific endpoints
they will call, and any webhook subscriptions they need.

```ts
export const manifest = {
  providers: ["github"],
  scopes: { github: ["repo", "read:user"] },
  endpoints: {
    github: [
      { url: "https://api.github.com/user",         methods: ["GET"] },
      { url: "https://api.github.com/repos/*",      methods: ["GET"] },
      { url: "https://api.github.com/repos/*/issues", methods: ["GET", "POST"] },
    ],
  },
  webhooks: {
    github: [
      { event: "issues",        deliver: "onIssue" },
      { event: "pull_request",  deliver: "onPullRequest" },
    ],
  },
};
```

The `endpoints` list is the capability declaration — it drives the
proxy's allowlist for this worker. URLs support `*` wildcards for path
segments (strict — `*` does not cross `/`). Methods are an explicit
array; no "all methods" shortcut. Integrations that genuinely need the
full provider surface declare a single `{ url: "https://api.github.com/**", methods: "*" }`
pattern but this is lint-warned in review.

At worker-startup, the runtime auto-discovers these exports (walk the
module graph from the entry point, collect `manifest` exports) and:

1. Unions the `providers`/`scopes` across all integrations and issues
   a single batched consent prompt per worker.
2. Unions the `endpoints` declarations into the capability matcher's
   allowlist for this worker.
3. Registers `webhooks` subscriptions via
   `credentials.subscribeWebhook` and wires incoming events to the
   named `deliver` exports.

If an integration forgets to declare a provider and tries to call its
API at runtime, the proxy will still work (provider manifests permit)
but capability enforcement will deny it — a useful production safety
net. Dev mode logs the violation and allows the request so authors can
iterate without constantly editing the manifest; set
`capabilityMode: "enforce"` in `natstack.yml` for production.

## Workerd integration

Changes to `src/server/workerdManager.ts`:

1. On instance creation, mint a `PROXY_AUTH_TOKEN` (new, parallel to
   `RPC_AUTH_TOKEN`) and store it in the egress proxy's worker
   registry keyed on `workerId`. Inject it into the worker as an
   env var so the proxy can identify the originating worker from an
   authorisation header.
2. Generate Cap'n Proto config declaring the egress proxy as an
   `ExternalServer` service (with `address` set to the proxy's
   local `127.0.0.1:<port>`) and binding it to this worker's
   `globalOutbound`. workerd does **not** honour Node-style
   `HTTP_PROXY` / `HTTPS_PROXY` env vars; `globalOutbound` is the
   only mechanism that reliably redirects outbound `fetch()` calls.
   The proxy unwraps the original target URL from a header or path
   convention chosen during the Wave 1 spike. workerd's `Network`
   service type is not appropriate here — it only describes
   allow/deny/TLS policy, not a destination address.
3. Inject the local CA cert (path or base64) into the worker's trust
   store via whatever workerd mechanism the spike validates — this
   is itself open, because workerd's BoringSSL trust store isn't
   configurable the same way Node's `NODE_EXTRA_CA_CERTS` is.
4. On instance destruction, revoke the `PROXY_AUTH_TOKEN` from the
   proxy registry and tear down the service binding.

## Execution — parallel waves

The plan is structured as **eight waves** of parallel tasks. Each
task is bounded enough to hand to one agent; tasks within a wave
run concurrently; the next wave starts when the previous one lands.
**Wave 0** (operational prerequisites) runs concurrently with every
engineering wave — it's non-blocking external work.

**Merge discipline.** Agents within a wave must own disjoint files.
Task IDs below include the file or directory each agent owns; no
two tasks in the same wave touch the same file. When a task needs
to modify a shared file (e.g. `natstack.yml`, `rpcServer.ts`), it
is scheduled into a wave where that file isn't otherwise touched,
or combined with the task that owns it.

**Critical path.** `W1.T10` (TLS interception spike) gates the
approach of `W4.T2` (egress proxy) and `W4.T5` (worker SDK). If
the spike comes back negative, Wave 4's proxy + worker SDK
redesign against `authedFetch(url)` and the consent/capability
UIs in Wave 5 adjust their payloads accordingly. A contingency
branch plan is part of the spike deliverable.

**Wave-exit condition.** Each wave's closing commit requires the
tree to compile, the existing test suite to pass, and every task's
individual acceptance criteria to be satisfied. Agents do not
merge their branches until the wave's integrator confirms.

### Wave 0 — Operational prerequisites

Non-engineering / external-track work. Starts immediately and runs
concurrently with all engineering waves. Outputs feed into specific
later waves; nothing else blocks on this wave as a whole.

- **W0.T1** GitHub: register natstack OAuth App under the natstack
  org. Output: `client_id`. Feeds Wave 3 GitHub manifest.
- **W0.T2** Microsoft: register multi-tenant Azure AD app. Output:
  `client_id`. Feeds Wave 3 Microsoft manifest.
- **W0.T3** Slack: register distributed natstack Slack app with
  Socket Mode. Output: `client_id` + app manifest JSON. Feeds
  Wave 3 Slack manifest.
- **W0.T4** Notion: register OAuth integration + verify MCP DCR
  path. Output: `client_id`. Feeds Wave 3 Notion manifest.
- **W0.T5** Composio: create tenant, obtain API key for Google
  bridge. Output: stored credential. Feeds Wave 3 Google manifest.
- **W0.T6** Google verification: kick off paperwork track —
  privacy policy, TOS, homepage, trust/security doc, CASA scoping,
  legal entity confirmation. Output: verification submitted.
  Completion is out of band; doesn't block v0 launch.
- **W0.T7** Universal-link domain: register, point DNS at
  Cloudflare. Output: domain string + DNS confirmation. Feeds
  Wave 5 and apps/well-known.
- **W0.T8** Cloudflare Pages project for `apps/well-known`
  (empty bound project). Feeds Wave 2 well-known build.
- **W0.T9** Cloudflare Worker project for `apps/webhook-relay`
  (empty scaffold + wrangler.toml). Feeds Wave 2 relay code.
- **W0.T10** OAuth client operational runbook:
  `docs/oauth-client-ops.md` — who holds dashboard credentials
  per provider, rotation procedure, suspension recovery.

### Wave 1 — Demolition + foundation types + risk spike

All parallel. Wave-exit: tree compiles with `NotImplemented` stubs,
`rg -i nango` returns zero hits, spike report committed.

- **W1.T1** Delete Nango OAuth core —
  `packages/shared/src/oauth/`, `src/server/services/oauthService.ts`,
  `workspace/packages/runtime/src/shared/oauth.ts`,
  `workspace/packages/runtime/src/panel/oauth.ts`.
- **W1.T2** Delete Nango-built integrations —
  `workspace/packages/integrations/src/{gmail,calendar,index}.ts`,
  `apps/mobile/src/services/oauthHandler.ts`.
- **W1.T3** Delete email panel —
  `workspace/panels/email/{index.tsx,DESIGN.md}`. Leave a
  `README.md` stub noting it's rebuilt in Wave 6.
- **W1.T4** Delete secrets service —
  `src/server/services/secretsService.ts`,
  `packages/shared/src/secrets/secretsStore.ts`. Migrate
  `authService.ts`'s fallback to env-vars-only.
- **W1.T5** Delete Nango config — `NANGO_URL` env handling in
  `src/server/index.ts`; `nango:` / `nangoUrl` keys and
  `.secrets.yml` support in `workspace/meta/natstack.yml`.
- **W1.T6** Drop SQLite tables `oauth_tokens`, `oauth_consent`
  via migration.
- **W1.T7** Rewrite Nango-referencing docs — `docs/remote-server.md`
  (strip Nango section), `workspace/skills/api-integrations/SKILL.md`
  (full rewrite stub — final rewrite in Wave 6),
  `workspace/skills/onboarding/{SKILL,GETTING_STARTED}.md`.
- **W1.T8** Stub `src/server/services/credentialService.ts` with
  `NotImplemented` method signatures registered on the RPC server.
- **W1.T9** Author `packages/shared/src/credentials/types.ts` and
  `packages/shared/src/webhooks/types.ts`. Single task because
  the type files reference each other.
- **W1.T10** **Workerd egress + TLS spike** (critical-path gate).
  **Scope broadened** from the original "CA trust-store" check to a
  full end-to-end transport validation. 2–3 days. Concrete
  milestones:
  1. A throwaway worker running in workerd calls
     `fetch("https://api.github.com/user")`.
  2. The request reaches a local Node HTTP server bound on a known
     port, via workerd's `globalOutbound` bound to an
     `ExternalServer` service pointing at `127.0.0.1:<port>`.
     Confirm the original target URL is recoverable on the proxy
     side. (If `ExternalServer` doesn't carry enough of the
     request context to recover the target, that's the first
     place the spike may fail and branch.)
  3. The proxy injects an `Authorization: Bearer <test-token>`
     header, terminates TLS (with a locally-minted CA), forwards to
     `api.github.com`, streams the response back to the worker.
  4. The worker sees the response body correctly; TLS verification
     passes from the worker's perspective.
  5. Repeat (3) with a client library known to pin certificates
     (e.g. `@octokit/rest` from inside the worker) to surface any
     pinning failures early.

  Deliverables: prototype code on a throwaway branch, one-page
  report with go / no-go and, if no-go, a concrete fallback plan
  (cooperative worker-side `authedFetch(url)` wrapper, no TLS
  interception, no CA, integrations lose the "plain fetch" property).
  The fallback plan branches Wave 4 and 5 designs; the branch must
  be documented before Wave 2 starts.

### Wave 2 — Foundation modules + infra scaffolds

All parallel. Every task depends only on Wave 1's types. Wave-exit:
all modules unit-tested standalone, `apps/webhook-relay` and
`apps/well-known` deployable.

- **W2.T1** `store.ts` — filesystem token store, atomic writes,
  mtime-watch.
- **W2.T2** `capability.ts` — URL + method matcher with wildcards.
- **W2.T3** `rateLimit.ts` — per-connection token bucket,
  `Retry-After` aware.
- **W2.T4** `retry.ts` — backoff + circuit breaker (with UI-state
  hooks for Wave 5).
- **W2.T5** `audit.ts` — JSONL writer + query API.
- **W2.T6** `consent.ts` — per-worker grant store (SQLite table
  `credential_consent`).
- **W2.T7** `registry.ts` — manifest loader (static + config-driven).
- **W2.T8** `resolver.ts` — flow chain runner.
- **W2.T9** `reconsent.ts` — refresh-failure handler.
- **W2.T10** `refresh.ts` — refresh scheduler (consumes `store` +
  `resolver` from this wave; slightly later start ok).
- **W2.T11** `test-utils/mockOAuthServer.ts` and `mockProvider.ts`.
- **W2.T12** `webhooks/subscription.ts` — subscription record store.
- **W2.T13** `webhooks/verifier.ts` — per-provider signature
  verifiers (GitHub, Slack, Stripe, Linear, Notion stubs; filled
  in by Wave 3 provider manifests).
- **W2.T14** `apps/webhook-relay/` Cloudflare Worker: public POST
  endpoint + per-instance WebSocket forwarding. Deployed to Wave
  0's project.
- **W2.T15** `apps/well-known/`: templates
  (`apple-app-site-association.template.json`,
  `assetlinks.template.json`), `config.json`, `build.ts`,
  `wrangler.toml`. Deployed to Wave 0's Pages project.

### Wave 3 — Flow runners + first-party provider manifests

All parallel. Flow runners + manifests are fully independent per
file. Wave-exit: smoke tests for every manifest pass against live
providers via CLI.

- **W3.T1** `flows/loopbackPkce.ts`.
- **W3.T2** `flows/deviceCode.ts`.
- **W3.T3** `flows/pat.ts`.
- **W3.T4** `flows/cliPiggyback.ts`.
- **W3.T5** `flows/mcpDcr.ts` (uses `@modelcontextprotocol/sdk`).
- **W3.T6** `flows/composioBridge.ts`.
- **W3.T7** `flows/serviceAccount.ts`.
- **W3.T8** `flows/botToken.ts`.
- **W3.T9** `flows/githubAppInstallation.ts`.
- **W3.T10** `flows/index.ts` dispatcher.
- **W3.T11** `providers/github.ts` (consumes W0.T1 `client_id`).
- **W3.T12** `providers/microsoft.ts` (consumes W0.T2).
- **W3.T13** `providers/slack.ts` (consumes W0.T3).
- **W3.T14** `providers/notion.ts` (consumes W0.T4).
- **W3.T15** `providers/google.ts` — composio-bridge primary
  (consumes W0.T5), BYO-`client_secret.json` fallback.
- **W3.T16** `natstack.yml` override support for
  `client_id`/`client_secret` per provider.
- **W3.T17** Smoke-test harness: per-manifest CLI tool that runs
  each flow against the live provider and reports success.

### Wave 4 — Service composition

Tasks overlap on `rpcServer.ts` and must be serialised there;
otherwise parallel. Wave-exit: service-level tests pass (worker
not yet wired).

- **W4.T1** `src/server/services/credentialService.ts` —
  implements all `credentials.*` RPC methods; registered on
  `rpcServer.ts`. This task owns `rpcServer.ts` edits.
- **W4.T2** `src/server/services/egressProxy.ts` — the layered
  middleware pipeline. Branches on W1.T10 spike outcome: TLS
  interception (preferred) vs. cooperative `authedFetch` fallback.
- **W4.T3** `src/server/services/auditService.ts`.
- **W4.T4** `src/server/services/webhookService.ts` — wires
  `credentialService.subscribeWebhook` to `webhooks/*`.
- **W4.T5** `workspace/packages/runtime/src/worker/credentials.ts`
  — worker SDK. Also branches on W1.T10 spike outcome.

### Wave 5 — Workerd wiring + consent UI + mobile

Parallel. Wave-exit: full desktop + mobile E2E passes from
`requestConsent` through authed `fetch` through audit log.

- **W5.T1** `src/renderer/components/ConsentDialog.tsx` and
  sub-components (`ProviderHeader`, `ScopeList`, `EndpointList`,
  `AccountPicker`).
- **W5.T2** Delete `src/renderer/components/NotificationBar.tsx`'s
  consent path (and the whole component if nothing non-consent
  uses it).
- **W5.T3** Extend `src/server/workerdManager.ts`: mint
  `PROXY_AUTH_TOKEN` per worker, declare the egress proxy as a
  Cap'n Proto `ExternalServer` service with `address` set to the
  proxy's local port, bind it as `globalOutbound`, and inject the
  local CA cert via the mechanism the Wave 1 spike validated. No
  `HTTP_PROXY` env vars — workerd doesn't honour them.
- **W5.T4** Manifest autodiscovery at worker startup:
  `endpoints` → capability matcher, `webhooks` → subscription
  registration, `providers` / `role` → default-connection
  bindings.
- **W5.T5** `apps/mobile/src/services/credentialConsent.ts` —
  ASWebAuthenticationSession / Chrome Custom Tabs launcher,
  universal-link handler, relay to server.
- **W5.T6** `apps/mobile/src/components/ConsentSheet.tsx` —
  native bottom-sheet version of ConsentDialog.
- **W5.T7** iOS entitlements + Android manifest templating from
  `apps/mobile/config.json`'s `universalLinkDomain` (consumes
  W0.T7).
- **W5.T8** Wire `credentials.mobileCallbackDomain` in
  `natstack.yml`.

### Wave 6 — Integrations + skills

Parallel. Wave-exit: email panel works end-to-end on real Gmail;
`SKILL.md` is the canonical integration-authoring guide.

- **W6.T1** Rewrite `workspace/packages/integrations/src/gmail.ts`
  — plain `fetch`, manifest with scopes + endpoints. **Polling-primary
  design**: a background loop on the natstack server calls
  `users.history.list` at a configurable interval (default 30s per
  connection) and dispatches deltas to the worker's `onNewMessage`
  handler. Architect the handler entry point to be agnostic of
  delivery shape — the W8 push wave will wire Pub/Sub events into
  the same handler without integration-code changes. Reserve the
  `webhooks.gmail` manifest field but don't register the
  subscription yet.
- **W6.T2** Rewrite `workspace/packages/integrations/src/calendar.ts`.
  Same polling-primary design with `events.list?syncToken=...` as
  the delta mechanism; push wiring deferred to W8.
- **W6.T3** Write `workspace/packages/integrations/src/github.ts`
  — the **reference webhook integration**, including an `issues`
  subscription that exercises the generic HTTPS-POST relay
  end-to-end (HMAC signature + routing to a named handler).
- **W6.T4** Multi-role example: github-to-github issue mirror
  integration demonstrating role-based consent.
- **W6.T5** Rewrite `workspace/panels/email/index.tsx` from
  scratch against the new Gmail integration.
- **W6.T6** Rewrite `workspace/skills/api-integrations/SKILL.md`.
- **W6.T7** Test-utils polish — `fixtureRecorder.ts`,
  `mockWebhookRelay.ts`, usage docs.
- **W6.T8** `docs/non-interactive-deployments.md` — how to
  bootstrap `credentials.seeds` in CI / systemd / containers.

### Wave 7 — End-to-end tests + publication

Parallel. Wave-exit: every E2E passes in CI; published packages
tagged and available.

- **W7.T1** E2E: desktop OAuth → token stored → authed fetch →
  audit recorded → capability enforcement active.
- **W7.T2** E2E: refresh-failure re-consent loop.
- **W7.T3** E2E: mobile native OAuth flow end-to-end.
- **W7.T4** E2E: rate limit + retry + circuit breaker trip +
  user-visible state + manual reset.
- **W7.T5** E2E: webhook delivery via relay with signature
  verification + delivery to worker handler.
- **W7.T6** E2E: non-interactive mode with seeded service-account
  credentials; `NonInteractiveConsentRequired` thrown when no
  seed present.
- **W7.T7** Publish `@natstack/credentials-test-utils` to npm.
- **W7.T8** Publish example `@natstack/provider-linear` at
  `workspace/examples/provider-linear/`.
- **W7.T9** `docs/writing-a-provider-manifest.md`.

### Wave 8 — Gmail / Calendar push (v0.1)

Ships after v0 launch as an additive enhancement. Polling from
Wave 6 continues to work unmodified; push wires into the same
worker-side handler signatures. Parallel within the wave.

Prerequisite (operational, can run during earlier waves):

- **W8.T0** GCP project + shared Pub/Sub topic + push subscription
  pointed at the relay's `/pubsub/:providerId` endpoint. Grant
  `gmail-api-push@system.gserviceaccount.com` the `pubsub.publisher`
  role on the topic. Owned by the same infra owner as the
  well-known domain.

Engineering tasks:

- **W8.T1** Extend `apps/webhook-relay/`:
  `POST /pubsub/:providerId` endpoint that verifies Google's JWT
  (`aud` = configured endpoint, `email` = provider-specific sender
  like `gmail-api-push@system.gserviceaccount.com`), unwraps the
  Pub/Sub envelope, reads the identity key from the payload, looks
  up the owning natstack instance in Workers KV, forwards over WS.
- **W8.T2** Cloudflare Workers KV binding + routing layer:
  `(providerId, identityKey) → instanceId` with 24h TTL. natstack
  server registers mappings on connection grant and re-registers
  on a daily refresh.
- **W8.T3** `packages/shared/src/webhooks/watchLifecycle.ts` —
  scheduler that calls the provider's `watch()` (Gmail
  `users.watch`, Calendar `events.watch`) on consent grant, on
  server startup for existing connections, and every
  `renewEveryHours` thereafter. Records `historyId` / `syncToken`
  per connection for delta fetches.
- **W8.T4** Extend `packages/shared/src/webhooks/verifier.ts` with
  `google-jwt` verifier. Pluggable via manifest `verify` field,
  same dispatch mechanism as HMAC verifiers.
- **W8.T5** Extend `packages/shared/src/webhooks/types.ts` +
  `router.ts` to handle the `pubsub-push` delivery shape.
  Worker-side handler signature unchanged.
- **W8.T6** Update `providers/google.ts` manifest to declare
  `pubsub-push` subscriptions for Gmail `message.new` and
  Calendar `events.changed` (previously a reserved field with no
  implementation).
- **W8.T7** In `workspace/packages/integrations/src/gmail.ts` and
  `calendar.ts`: add the hybrid polling / push override logic.
  Polling loop stands down to a slow heartbeat when push has
  delivered in the last N minutes; re-engages when push is silent
  past the heartbeat window. Worker-side `onNewMessage` /
  `onEventsChanged` handlers unchanged.
- **W8.T8** E2E test: grant Gmail consent → confirm `users.watch`
  is called → send a test email → confirm push event arrives at
  worker handler within ~10s → verify polling heartbeat stays
  quiet while push is active → kill push path → verify polling
  re-engages automatically.
- **W8.T9** Commit: `feat(webhooks): Pub/Sub push delivery for
  Gmail and Calendar`.

### Sequencing summary

```
Wave 0 ─────────────────────────────────────────────── (parallel to all)
       │
Wave 1 ┴── demolition + types + TLS spike
       │
Wave 2 ┴── foundation modules + infra scaffolds
       │
Wave 3 ┴── flow runners + first-party manifests
       │
Wave 4 ┴── service composition
       │
Wave 5 ┴── workerd wiring + consent UI + mobile
       │
Wave 6 ┴── integrations + skills
       │
Wave 7 ┴── E2E + publication (v0 launch)
       │
Wave 8 ┴── Gmail/Calendar Pub/Sub push (v0.1)
```

Approximate parallel-agent count per wave, assuming one agent per
task: **W0: 10, W1: 10, W2: 15, W3: 17, W4: 5, W5: 8, W6: 8,
W7: 9, W8: 9**. With 10–15 agents actively working, most waves
complete in one agent-day; Wave 1's TLS spike, Wave 2's webhook
relay, and Wave 8's push-integration testing are the longest
individual tasks.

## Resolved decisions

These were open during the design discussion and are now committed.

### OAuth redirect topology: local, remote, and mobile

The server never acts as the OAuth client from the provider's
perspective in any remote or mobile deployment — it holds the PKCE
verifier but the **client surface captures the callback**. The
server-binds-loopback path only works when the user's browser and
the server are on the same machine.

Three topologies, one RPC shape (`beginConsent` / `completeConsent`):

| Topology | `redirect` | Who captures the callback |
|---|---|---|
| Local Electron on same host as server | `server-loopback` | Server (`127.0.0.1:<random>`) |
| Remote server (VPS / LAN / Tailscale), any client | `client-loopback` | Client binds its own loopback port |
| Mobile (iOS / Android) | `mobile-universal` | Mobile app via universal link |

**Client-loopback flow** (the general case for any remote server,
including a remote Electron client connecting over network):

1. Client calls `credentials.beginConsent({ providerId, scopes,
   redirect: "client-loopback" })`. Server mints PKCE challenge,
   stores a `{ nonce → providerId, scopes, verifier }` record,
   returns the authorize URL with a `redirect_uri` the client
   intends to bind.
2. Client binds `127.0.0.1:<random>` locally (its own loopback,
   reachable by its own browser) and opens the authorize URL.
3. Provider redirects to the client's loopback; client captures
   `{ nonce, code }`.
4. Client calls `credentials.completeConsent({ nonce, code })`.
5. Server exchanges the code using the held verifier, stores the
   token. Client's loopback listener closes.

**Mobile flow** (the `"mobile-universal"` variant):

1. Mobile UI calls `credentials.beginConsent({ ..., redirect:
   "mobile-universal" })`. Server returns authorize URL with the
   universal-link callback.
2. Mobile opens the URL in `ASWebAuthenticationSession` / Chrome
   Custom Tabs.
3. User approves; provider redirects to the universal link.
4. Mobile relays `{ nonce, code }` via `completeConsent`.
5. Server exchanges and stores.

**Local-same-host flow** (the `"server-loopback"` variant — kept as
an optimisation, surfaced via the convenience `requestConsent`):

1. Server binds its own `127.0.0.1:<random>`.
2. Opens the browser from the server process (which is on the same
   machine as the user's browser).
3. Captures the callback directly; no client relay needed.

The `{ nonce → verifier }` record is held for the lifetime of the
associated consent dialog on the server — no time-based expiry.
LRU-evict at 100 outstanding records as a memory safety net (see
**Timeouts** for cleanup details on renderer crash, disconnect,
abandoned flows).

Implications:

- **Tokens live exclusively on the server, shared by desktop and
  mobile.** The credential store is authoritative. Both surfaces ask
  the same server for consent and both surfaces' egress requests flow
  through the same egress proxy. This directly solves "can desktop and
  mobile share auth state" — they share it by construction.
- **Mobile has no local token store**, no CA, no egress proxy. When
  mobile needs to call a provider API it either (a) invokes a worker
  on the server and lets the server's workerd run the request, or (b)
  calls a thin server RPC that proxies the outbound request on its
  behalf. For v0, everything goes through (a) — mobile is a UI shell,
  all integration work happens in workers on the server.
- **Requires the server to be reachable** from mobile (LAN, Tailscale,
  or a natstack-managed tunnel). There is no offline-mobile mode in
  v0. This is acceptable because natstack is a local-first tool where
  the server is the user's own machine.
- The universal-link callback requires one tiny piece of hosted infra:
  an `apple-app-site-association` file and an Android Asset Links
  file served from a natstack-owned domain. Hosted on **Cloudflare
  Pages** from `apps/well-known/` in this repo. See **Universal-link
  domain infra** below.

New pieces this adds to the plan:

- `credentials.beginConsent` and `credentials.completeConsent` RPCs
  (mobile does not run flow runners itself; the server mints the URL
  and consumes the code).
- `apps/mobile/src/services/credentialConsent.ts` — launches the
  system OAuth session, handles the universal-link return, relays
  to server. ~150 LOC per platform.
- Host static files for universal-link association (deploy once,
  separate repo/infra task).

### Universal-link domain infra

Hosted on **Cloudflare Pages**. The domain is chosen today and treated
as **a configuration parameter**, not a hardcoded string — both in
source code and in build config — so we can rotate or self-hoster-override
without code changes.

**What gets hosted**

Two static files at the domain root:

- `/.well-known/apple-app-site-association`
- `/.well-known/assetlinks.json`

Both templated from source at build time so Team ID, bundle ID,
package name, and cert fingerprints come from config rather than being
hand-edited.

**Repo layout**

New top-level folder `apps/well-known/` containing:

- `src/apple-app-site-association.template.json`
- `src/assetlinks.template.json`
- `build.ts` — reads `apps/well-known/config.json` (the current values
  of Team ID, bundle ID, package name, signing-cert SHA-256s), renders
  the templates to `dist/.well-known/*`.
- `wrangler.toml` — Cloudflare Pages project config.
- `README.md` — how to update cert fingerprints, domain, etc.

Cloudflare Pages deploys `dist/` on every push to main. The files are
~300 bytes total; deploy is instant.

**Parameterising the domain**

The domain appears in four places. Each reads from a single source of
truth.

| Place | How the domain is injected |
|---|---|
| Server-side OAuth redirect URL construction | `natstack.yml` field `credentials.mobileCallbackDomain` → read by `credentialService` when building authorize URLs |
| iOS entitlements (`applinks:<domain>`) | Build-time constant in `apps/mobile/ios/` generated from `apps/mobile/config.json` field `universalLinkDomain` |
| Android manifest (`android:host="<domain>"`) | Same build-time constant, consumed by Android manifest template |
| Each provider's OAuth client redirect URI allowlist | Operational — set once per provider when the OAuth client is registered, documented in `apps/well-known/README.md` |

The mobile app supports **multiple domains** in its entitlements list
so natstack-cloud builds and self-hoster-custom builds can coexist
without rebuilds. Default entitlement includes:

- The natstack-owned production domain (set today)
- A `*.natstack.dev` wildcard pattern for dev/preview builds

Self-hosters who want a fully custom domain rebuild the mobile app —
they're self-hosting anyway, so a rebuild is already in their workflow.

**Choosing the domain today**

Requirements:
- Must be a domain we own (Apple/Google verify via the `.well-known`
  files).
- Stable — changing it later means re-registering redirect URIs with
  every provider. Pick once.
- HTTPS with a valid cert (Cloudflare Pages provides this automatically).

Candidate forms (to be finalised by whoever picks the domain today):
- `links.natstack.io` — subdomain of the main domain, clean
- `natstack.link` / `natstack.app` / `natstack.dev` — dedicated domain
- A path on the main domain, e.g. `natstack.io/app/` — works but
  pollutes the main site's URL space

Recommendation: subdomain on whatever primary domain natstack already
owns. If none exists yet, registering a new `.app` or `.link` domain
is fine; they're cheap.

**Operational ownership**

- DNS: one CNAME record pointing the chosen domain at Cloudflare Pages.
- Monitoring: a simple healthcheck hitting
  `GET /.well-known/apple-app-site-association` and expecting 200 +
  `application/json`. Any uptime monitor (UptimeRobot, Cloudflare
  Health Checks) is enough. Failure impact: new mobile installs can't
  complete OAuth until it's back. Existing installs are unaffected
  because iOS caches the AASA.
- Updates: when signing cert fingerprints rotate or a new mobile
  platform is added, PR to `apps/well-known/config.json`, merge,
  Cloudflare auto-deploys.

### Credentials stored server-side, shared across surfaces

Already implied by the mobile decision but worth making explicit: the
credential store at `~/.natstack/credentials/` on the server is the
sole source of truth. Desktop UI, mobile UI, workers, and panels all
consult the same store via server RPCs. There is no desktop-local or
mobile-local token cache; no sync protocol is required because there
is only one store.

This is not a problem for our topology: natstack is local-first, so
"server-side" means "on the user's desktop machine." It's a problem
only for users who want full-offline mobile access, which is out of
scope for v0.

### Egress proxy: TLS interception, plain `fetch()` for authors

Committed. The egress proxy terminates TLS with a per-install local
CA, matches outbound request URLs against manifest `apiBase` patterns,
and injects `Authorization` headers. Integration authors call plain
`fetch("https://api.github.com/...")` and get authenticated requests
automatically.

Trade-off accepted: ~300–500 LOC of certificate machinery in exchange
for zero-ceremony integration authoring. This is the right call —
cleaner DX on a surface that third parties will touch, at the cost of
complexity in one central component maintained by us.

This is gated by the Wave 1 spike (W1.T10). The spike is broader
than CA trust alone — it validates the full end-to-end workerd →
egress-proxy transport (see Execution waves, Wave 1) — and its
go/no-go determines whether Wave 4 implements TLS interception or
falls back to a cooperative `authedFetch` wrapper.

### Google: bundle a Composio bridge for v0, start verification in parallel

Google access is a product requirement and we can't wait 2+ months on
verification. Strategy:

- **Start Google verification now**, as a parallel non-engineering
  track. Register the natstack Google OAuth client, complete the OAuth
  consent screen configuration, fill out the verification form, queue
  the security assessment for restricted scopes (Gmail/Drive). Treat
  this as a blocker for the "final" state, not for v0 launch.
- **Bundle Composio as the interim Google backend.** Composio has
  verified Google OAuth apps for Gmail, Calendar, and Drive, a
  JS/TS SDK (`composio-core`), and a connector-bridge model that hands
  us real Google access tokens. We add one new flow type —
  `composio-bridge` — to `packages/shared/src/credentials/flows/`. The
  Google manifest's primary flow becomes `composio-bridge`; when
  verification completes, we swap it to `loopback-pkce` with
  natstack's own `client_id` in a single manifest edit. No integration
  code changes.
- **BYO `client_secret.json`** stays as a fallback for users who don't
  want the Composio dependency.

The `composio-bridge` flow runner is ~150 LOC — call Composio's
`createConnection(userId, "google")`, open the returned URL for user
consent, call `getConnection` to retrieve the access token, store it
in our credential store as if we'd run the OAuth ourselves. From that
point the egress proxy handles the token like any other.

Alternatives considered and rejected:

- **Arcade AI** — similar model, Apache-2.0, but JS SDK less mature
  than Composio's.
- **Ship the unverified-app scary-warning flow with our own Google
  client** — 100-user hard cap until verification, plus every user
  sees a "this app isn't verified" screen. Too hostile for v0.
- **Run our own OAuth relay** for Google specifically — essentially
  rebuilding Nango for one provider. Defeats the point.

Composio's free tier covers early access; we're not committing to
them as a permanent dependency, only as a ~2-month bridge.

### Consent UI: purpose-built dialog, reusing the pending-actions queue

Previously we planned to mirror the secrets service's
`NotificationBar` strip. That's been revised: the secrets service
is dead code (see Demolition), and the `NotificationBar` layout is
inadequate for credential consent — cramped, no room for an
account picker, wrong visual weight for a security decision.

The new plan builds a **purpose-built `ConsentDialog` component**
and keeps only the infrastructure worth salvaging:

**Kept from `notificationService`:**

- The `pendingActions` map. The queue shape is correct. But **the
  120s auto-deny is dropped** for credential-consent entries —
  user decisions don't expire on a timer. Non-consent entry types
  may retain their own timeouts if appropriate.
- The `reportAction(id, actionId, payload)` RPC for user response.

**Replaced:**

- `NotificationBar` consent render path → new `ConsentDialog`
  component (desktop modal) and `ConsentSheet` (mobile bottom sheet).
- Notification type `"consent"` (generic) → two specific types
  `"consent:credential"` and `"consent:reconnect"` with distinct
  copy and payloads.

**Flow:**

1. Worker/panel calls `credentials.requestConsent({ providerId,
   scopes, accountHint?, role? })` via RPC. Blocking; returns only
   on the user's explicit approve / deny / cancel. No automatic
   timeout (see **Timeouts**).
2. `credentialService` asks `notificationService.show(...)` with
   type `"consent:credential"`, caller attribution, the scope list
   with human-readable descriptions, the capability endpoints, and
   the list of existing connections for the provider.
3. `ConsentDialog` renders and awaits the user's choice.
4. User picks an existing account or "Connect new", or clicks
   Deny. `reportAction` fires; `credentialService` completes the
   flow runner (for "Connect new"), reuses the existing
   connection, or throws on deny.
5. Shell-initiated callers bypass the dialog (same pattern we had
   for secrets).

See **Consent UI redesign** under Extended capabilities for full
layout, design principles, and component decomposition.

## Extended capabilities

Seven capabilities beyond "replace Nango" that turn this into a
production-robust system. All folded into the phases above; this
section summarises their architecture and motivation in one place.

### Capability-based security

The proxy sees every outbound request to a matched provider.
Integrations declare an `endpoints` list in their manifest (URL +
method allowlist); the proxy enforces it. Tokens can be broad while
each integration is limited to the specific provider operations its
manifest declares — if the Gmail integration declared `GET messages`
only, a compromised worker can't use the token to call
`messages/send` even though the scope technically permits it.

Lives in `capability.ts`; enforced as middleware step 3 in the
proxy pipeline. Dev mode warns + allows; production mode denies.
Denied requests return a structured 403 to the worker naming the
violated capability. All violations audited.

**What this protects against.** Containment of provider-side
misuse: a worker with a legitimate Gmail `gmail.modify` token
can't escalate from reading messages to sending them without
updating its manifest, which is a code change reviewers see. If
one of natstack's own integrations is compromised, the blast
radius on each provider is bounded by what that integration
declared it would do.

**What this does not protect against.** Exfiltration. Pipeline
step 11 (no-match passthrough) forwards requests to unmatched
domains unchanged, so a compromised worker can legitimately fetch
Gmail data and then POST it to any domain not in any provider's
`apiBase`. Default-allow egress is a deliberate ergonomics
choice (integrations can call CDNs, health checks, third-party
APIs without any declaration) and **capability security does not
close the exfiltration channel**. A stricter default-deny policy
remains available as a later hardening upgrade if threat-model
priorities shift.

This feature exists because we own the egress boundary — it would
not be possible with a hosted broker like Nango. Within the
"provider-side misuse" threat surface it's high-leverage; within
the broader "compromised worker" threat surface, it's one layer
among several (with others like integration code review, third-
party provider package signing, and at-rest token encryption all
explicitly deferred).

### Refresh-failure re-consent

When a refresh token is revoked (user disconnected from the
provider's side), the next request would normally fail with a
stale-token 401. Instead: the proxy detects the failed refresh,
suspends the in-flight request, triggers a `"consent:credential"`
notification via `notificationService` ("GitHub access has been
revoked; reconnect?"), and transparently retries the original
request once the user re-authorises. Integration code sees no
disruption beyond latency.

Lives in `reconsent.ts`, wired at step 8 of the proxy pipeline.
Reuses the same notification queue as initial consent — one UX
surface, two triggers.

### Audit + observability

Every authed outbound request appends a structured record to
`~/.natstack/logs/credentials-audit-YYYY-MM-DD.jsonl`:

```
{ ts, workerId, callerId, providerId, connectionId, method, url,
  status, durationMs, bytesIn, bytesOut, scopesUsed,
  capabilityViolation?, retries, breakerState }
```

Daily rotation, size cap. Queryable via `credentials.audit` RPC with
per-caller scoping (a panel sees its own worker's entries; shell
sees everything). Enables a future UI ("what did natstack do with my
GitHub access today"), anomaly alerts, and debugging. High
user-trust value for a system holding broad tokens.

### Rate limiting, retry, circuit breaking

Three concerns, one layered middleware. Each provider manifest
declares `rateLimits` and `retry` policies; the proxy enforces them:

- **Rate limit**: per-connection token bucket; honours `Retry-After`
  headers from 429 responses; configurable to delay-up-to-cap vs
  fail-fast.
- **Retry**: exponential backoff on 5xx, bounded attempts.
- **Circuit breaker**: N consecutive failures in a rolling window →
  trip breaker for cooldown period → fail fast instead of piling on
  a downed provider.

Lives in `rateLimit.ts` and `retry.ts`, proxy steps 5 and 7.
Integration authors get provider-appropriate resilience without
writing any of it themselves.

### Service accounts / non-interactive mode

Required for production: CI, scheduled jobs, server-side deployments.

Three new non-interactive flow types:

- `service-account` — Google service account JSON, AWS IAM creds,
  similar. Self-refreshing.
- `bot-token` — Slack `xoxb-`, Discord bot tokens, Telegram tokens.
  Long-lived, no refresh.
- `github-app-installation` — GitHub App installation tokens minted
  from a private key. Short-lived, auto-refreshed.

Paired with a `--non-interactive` server mode where `requestConsent`
throws rather than prompts if no valid credential exists. A
`credentials.seeds` config lets headless deployments load bot
tokens and service-account JSONs at server start. Enables running
natstack unattended without compromising the interactive UX for
desktop users.

### Webhooks as first-class

Provider manifests declare supported webhook events, their
**delivery shape**, and a verification recipe. Integration manifests
subscribe to specific events and name a handler export. The runtime
normalises all delivery shapes into a single event payload for
worker-side handlers — integration authors don't see the transport
differences.

**Two delivery shapes in v0.1+ scope:**

| Delivery | Transport | Verification | Providers |
|---|---|---|---|
| `https-post` | Provider POSTs to relay's `/webhook/:instanceId/:providerId`; relay forwards over WS tunnel | HMAC (per-provider scheme — `X-Hub-Signature-256`, `v0=...`, `Stripe-Signature`, etc.) | GitHub, Slack, Stripe, Linear, Notion, most SaaS |
| `pubsub-push` | Provider publishes to natstack's Google Cloud Pub/Sub topic; push subscription hits relay's `/pubsub/:providerId`; relay routes by payload identity | Google-signed JWT in `Authorization` header; `aud` matches endpoint, `email` matches `gmail-api-push@system.gserviceaccount.com` | Gmail, Google Calendar |

Each subscription carries a `delivery` field:

```ts
// provider manifest
webhooks: {
  subscriptions: [
    { event: "issues",        delivery: "https-post",  verify: "github-hmac-sha256" },
    { event: "message.new",   delivery: "pubsub-push", verify: "google-jwt",
      watch: { type: "gmail.users.watch", renewEveryHours: 72 } },
  ],
}

// integration manifest
webhooks: {
  github: [{ event: "issues",       deliver: "onIssue" }],
  gmail:  [{ event: "message.new",  deliver: "onNewMessage" }],
}
```

**Worker-side handlers** see a unified event shape regardless of
delivery:

```ts
export async function onNewMessage(event: WebhookEvent) {
  // event.provider, event.connectionId, event.payload (decoded)
  // Gmail-specific payload: { emailAddress, historyId }
  // For push-delivered events the integration is responsible for
  // calling users.history.list to get the actual delta.
}
```

**HTTPS-POST flow** (the existing v0 design):

1. Register a subscription on the natstack server.
2. For providers where subscription requires API calls (GitHub,
   Stripe, Linear), call the provider's API to create the webhook
   pointing at a stable per-instance URL on the relay.
3. Long-lived WebSocket from the natstack server to the relay,
   keyed on a per-instance registration token.
4. Relay receives `POST /webhook/:instanceId/:providerId`, verifies
   HMAC, forwards body + headers over WS.
5. `router.ts` dispatches to the worker's handler.

**Pub/Sub-push flow** (v0.1 addition — see dedicated wave):

1. On consent grant for a provider with `pubsub-push` subscriptions,
   the `watch` lifecycle manager calls the provider's `watch()` API
   using the granted token, pointing at natstack's shared Pub/Sub
   topic. Records the returned `historyId` and `expiration`.
2. Scheduler renews via `watch()` every `renewEveryHours` (default
   72h for Gmail's 168h-max window) for every active connection.
3. Provider change → provider publishes `{ emailAddress | resourceId,
   historyId }` to the topic.
4. Pub/Sub push subscription delivers the wrapped event to relay's
   `/pubsub/:providerId`. Relay verifies Google's JWT, reads the
   identity from the payload, looks up the owning natstack instance
   in Cloudflare Workers KV (24h-TTL mapping
   `(providerId, identityKey) → instanceId`), forwards over WS.
5. `router.ts` dispatches to the worker's handler; the handler
   calls the provider's delta API (`gmail.users.history.list`,
   `calendar.events.list?syncToken=...`) to fetch what actually
   changed.

The relay is a Cloudflare Worker with two pieces of state: the WS
connection registry (in-memory per-Worker) and the identity → instance
KV mapping (for Pub/Sub routing only; HTTPS-POST still uses the
URL path). No persistent event storage; at-most-once delivery for
both shapes. Upgrading to at-least-once via Cloudflare Queue is a
later concern.

Why the WebSocket tunnel: natstack is local-first; the user's
server doesn't have a public HTTPS endpoint. The relay provides the
public endpoint; the WS delivers events through NAT / firewalls
without any user setup. Same pattern as ngrok, Cloudflare Tunnel,
etc., but scoped to webhook delivery.

**Reconnect policy.** Natstack reconnects to the relay with
exponential backoff capped at 30s. It **never gives up**. If the
relay is down or the user's network is unreachable, reconnect
attempts continue until they succeed. The UI surfaces the
disconnected state ("webhook delivery paused — reconnecting") so
the user sees the state instead of silently missing events. The
whole point of the tunnel is delivery; a timer that terminates it
defeats the purpose.

**Push as enhancement, not replacement.** Gmail and Calendar
integrations always have a **polling fallback** running underneath.
When push is active (recent event seen within last N minutes), the
polling loop stands down to a slow heartbeat. When push is silent
past the heartbeat window (e.g. `watch()` expired and renewal
failed, or the Pub/Sub topic misrouted), polling automatically
re-engages. Users never notice push failure; latency goes up,
that's it.

### Multi-account per provider

A "connection" is a `(providerId, connectionId)` tuple with its own
token, refresh state, and account identity. A user can have zero,
one, or many connections per provider:

- Personal GitHub + work GitHub
- Multiple Slack workspaces (each workspace is a separate OAuth
  install even for the same human)
- Personal Gmail + work Workspace Google account
- Multiple Notion workspaces

**Data model**

Token store path: `~/.natstack/credentials/<providerId>/<connectionId>.json`
where `connectionId` is a short stable ULID. Each record carries:

```ts
type Credential = {
  providerId: string;
  connectionId: string;
  connectionLabel: string;         // user-editable: "work", "personal"
  accountIdentity: {                // populated from provider's whoami
    email?: string;
    username?: string;
    workspaceName?: string;
    providerUserId: string;         // provider's stable id for dedup
  };
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt?: number;
};
```

Every provider manifest declares a `whoami` config — an endpoint
URL + a JSON path to extract identity fields — so `accountIdentity`
is populated automatically on first auth. `providerUserId` is used
to detect "user is reconnecting an account they already have"; the
system reuses the existing `connectionId` rather than creating a
duplicate.

**RPC surface**

- `requestConsent({ providerId, scopes, accountHint?, role? }) →
  CredentialHandle` — if `accountHint` matches exactly one existing
  connection's `email` / `username` / `workspaceName` /
  `connectionId`, reuses it. If multiple matches or no match,
  prompts with the picker UI described below. Return shape matches
  the Worker SDK section (`{ connectionId, apiBase, fetch }`);
  both single- and multi-role callers get the same handle.
- `listConnections({ providerId? }) → Connection[]` — for settings
  panels.
- `renameConnection({ connectionId, label }) → void`.
- `revokeConsent({ providerId, connectionId? }) → void` —
  `connectionId` optional; omitted = revoke all connections for
  that provider.

**Integration manifest: roles**

Integrations that need multiple connections to the same provider
(a "mirror issues from personal to work GitHub" panel, say)
declare roles:

```ts
export const manifest = {
  providers: [
    { id: "github", role: "source" },
    { id: "github", role: "target" },
  ],
  scopes: {
    "github:source": ["repo"],
    "github:target": ["repo"],
  },
  endpoints: {
    "github:source": [{ url: "https://api.github.com/repos/*/issues", methods: ["GET"] }],
    "github:target": [{ url: "https://api.github.com/repos/*/issues", methods: ["POST"] }],
  },
};
```

Single-role integrations keep the compact form
(`providers: ["github"]`); the runtime treats "no role" as the
implicit `"default"` role.

**Worker SDK (see earlier Worker SDK section for the full type).**
Every `requestConsent` call returns a `CredentialHandle` — single-
and multi-role callers use the same API:

```ts
// single-role — plain fetch works because there's one default connection
const gh = await requestConsent("github");
await fetch("https://api.github.com/user");

// multi-role — plain fetch is ambiguous; use the handle's .fetch
const source = await requestConsent("github", { role: "source" });
const target = await requestConsent("github", { role: "target" });
await source.fetch("https://api.github.com/repos/.../issues");
await target.fetch("https://api.github.com/repos/.../issues", { method: "POST" });
```

`handle.fetch` stamps an `X-Natstack-Connection: <connectionId>`
header that the proxy strips and uses for token routing.

**Egress proxy: connection routing**

Pipeline step 4 becomes provider + connection routing:

1. Match URL against granted providers' `apiBase`.
2. If the worker has one connection for that provider → use it.
3. If multiple → check `X-Natstack-Connection`; if present and
   valid, use it.
4. Else → use the worker's declared default for that provider.
5. Else → 400 with a helpful error naming the available
   connections.

**Capability keying**

Allowlists are keyed `(workerId, providerId, connectionId, role)` —
a worker can have read-only on the source account and write on the
target account independently. Same worker, same provider, different
capability surface.

**Execution-order impact**

No new wave; threads through existing waves:

- Wave 1: `Credential` type includes `connectionId`,
  `accountIdentity`, `connectionLabel`; store path uses
  `<providerId>/<connectionId>.json` from day 1.
- Wave 3: every first-party manifest declares `whoami`.
- Wave 4: proxy step 4 implemented as provider + connection
  routing; capability keying includes `connectionId`.
- Wave 5: consent dialog renders the account picker; RPC
  methods above exposed.
- Wave 6: at least one example integration demonstrates roles
  (GitHub → GitHub issue mirror is a natural fit).

### Consent UI redesign

The current `NotificationBar` (a fixed-height strip at the top of
the shell, violet background, one-line message, two buttons) is
wrong for consent. It's cramped, doesn't scale to account pickers,
doesn't convey the weight of a security decision, and the layout
falls apart as soon as there's more than a short title plus a
single action. It was built for the secrets-approval flow, which is
itself about to be removed as dead code (see Demolition).

The replacement is a proper **consent dialog** — modal overlay,
centered on desktop, bottom sheet on mobile. Layout and content:

```
╔═════════════════════════════════════════════╗
║                                             ║
║   ┌─── [Provider logo / gradient] ───┐      ║
║                                             ║
║   Connect to GitHub                         ║
║                                             ║
║   "Email Panel" wants access to:            ║
║     • Read your repositories                ║
║     • Create and comment on issues          ║
║                                             ║
║   It will only call these endpoints:        ║
║     GET  api.github.com/repos/*             ║
║     POST api.github.com/repos/*/issues      ║
║                                             ║
║   Account                                   ║
║   ○  work      alice@acme.com               ║
║   ○  personal  @alice                       ║
║   ●  Connect a new account                  ║
║                                             ║
║                    [ Deny ]    [ Connect ]  ║
║                                             ║
╚═════════════════════════════════════════════╝
```

Design principles:

- **Modal, not inline.** Security decisions deserve attention.
  Dimmed backdrop on desktop; full-screen bottom sheet on mobile.
  Matches browser permission dialogs and native OS patterns.
- **Caller attribution in plain language** — "Email Panel wants
  access to", not an opaque worker id. Uses the panel/worker
  `displayName` from its manifest.
- **Scopes shown as human-readable strings**, not OAuth strings.
  Each provider manifest declares a `scopeDescriptions` table
  mapping `"repo"` → `"Read your repositories"`. Falls back to the
  raw scope if not mapped.
- **Endpoints shown explicitly.** Capability security is visible
  to the user — they can see the integration isn't asking for full
  provider access even when the OAuth scope is broad. Collapsible
  if long ("+ 12 more endpoints").
- **Account picker prominent, not buried.** Existing connections
  listed with their labels and identity; "Connect a new account" is
  always an option. Omitted entirely when the user has zero
  connections for this provider.
- **Equal visual weight for Deny and Connect.** No pre-selected
  button; no tiny-grey "Deny" next to a big-green "Connect". The
  user must actively choose. Deny is first (reading order:
  safest-option first on desktop, bottom-first on mobile).
- **No auto-dismiss, no auto-deny, no timer.** Consent is an
  explicit decision; the dialog stays until the user chooses.
  OAuth flows routinely take minutes — password managers, 2FA
  apps, account pickers, re-logins. A user who walks away for
  coffee must come back to the same dialog, not to a silently
  failed integration. The server-side loopback PKCE listener and
  the mobile `beginConsent` nonce are tied to the dialog's
  lifecycle, not to a wall clock.

Secondary consent surfaces:

- **Re-consent prompt** (refresh failure, token revoked): same
  dialog shape, with a clear reconnect-prompt banner at the top
  ("GitHub access was revoked. Reconnect to continue.") and
  caller attribution showing which panel/worker triggered it.
- **Scope escalation** (integration declared new scopes since last
  approval): same dialog with a diff — "Previously granted: Read
  repos. Additionally requested: Write issues." Allows accepting
  the new scopes or denying (which keeps the existing grant
  intact).
- **Toast-style confirmation** (non-blocking, low-stakes) for
  things like "connection renamed" or "audit log exported" — the
  `NotificationBar` surface could be salvaged for this if we
  want, but it's optional.

Component layout:

- New component: `src/renderer/components/ConsentDialog.tsx`.
  Self-contained modal, bound to `notificationService` via the
  same `pendingActions` queue but consuming entries of type
  `"consent:credential"` and `"consent:reconnect"`. Calls
  `notification.reportAction(id, actionId, payload)` with the
  chosen connection / "new" / deny.
- Kill `NotificationBar.tsx` outright unless something else on the
  roadmap needs a persistent notification strip. (The audit system
  would use a dedicated panel or settings view, not the bar.)
- Shared primitives: `ProviderHeader`, `ScopeList`, `EndpointList`,
  `AccountPicker` — reusable in the future connection-management
  settings view.
- Mobile: `apps/mobile/src/components/ConsentSheet.tsx` — native
  bottom sheet wrapping the same primitives, consuming the same
  notification payloads.

Infrastructure kept from the old pattern:

- `notificationService.pendingActions` queue — the routing shape
  is right. But **the 120s default timeout is dropped for
  `consent:credential` and `consent:reconnect` types**: user
  decisions have no clock. Non-consent notification types that
  used the queue can keep their own timeouts if they want.
- `reportAction` RPC — unchanged API.

Infrastructure removed:

- `secretsService.ts`, `secretsStore.ts`, and the
  `~/.config/natstack/.secrets.yml` file — see Demolition. The
  whole secrets-approval flow is dead code now that Nango is
  going; nothing else uses it.
- `NotificationBar.tsx`'s `type: "consent"` code path — replaced
  by `ConsentDialog.tsx`.

**Execution-order impact**

- Wave 5 covers the new `ConsentDialog` component and the RPC
  payload shape for `consent:credential` / `consent:reconnect`.
- Wave 5 also removes `NotificationBar`'s consent code path (or
  the whole component if nothing else needs it).
- Wave 5 (mobile tasks) extends `ConsentSheet` to mobile.

### Timeouts

Timeouts are a recurring source of user-visible failures when
applied over-eagerly. The plan deliberately **has no user-facing
timeouts**; every timer in the system is an internal tuning knob,
and every one of them is listed in one place so nothing sneaks in
later.

**Principle.** If a timer expiry could surface to the user as "it
broke and I don't know why", the timer is wrong. User actions
(consent, re-consent, mobile OAuth return) have no clock. Machine
actions have timers only where a timer is strictly better than the
alternative, and always with a user-facing status indication when
the timer matters.

**Complete list of timers in the system:**

| Timer | Default | Source of truth | Rationale |
|---|---|---|---|
| Token refresh buffer | 60s | per-provider manifest `refreshBufferSeconds` | Proactive refresh; synchronous-with-request refresh is always supported as fallback. |
| Device-code polling interval | Provider-specified | Provider's token-endpoint response | Standard OAuth device-flow. |
| Egress proxy retry backoff | 2 retries, exponential | per-provider manifest `retry` | Conservative; idempotent methods only. Caller may retry. |
| Egress proxy rate-limit delay | per-provider manifest `rateLimits` | Manifest | Per-request choice of delay-up-to-cap vs fail-fast. |
| Circuit breaker trip window | 20 failures in 60s | per-provider manifest | Tuned so brief provider blips don't trip it. UI-visible, user-resettable. |
| Circuit breaker cooldown | 30s, exponentially growing per re-trip | Manifest | Surfaced in UI; "Try now" action always available. |
| Webhook tunnel reconnect backoff | exp, cap 30s | Core | No give-up; reconnects forever; UI shows state. |

**Explicitly no timeout on:**

- The consent dialog (`consent:credential`, `consent:reconnect`).
- The loopback / client-loopback / mobile-universal callback
  listeners (lifecycles tied to the dialog, not a timer).
- The server-held `{ nonce → verifier }` record.
- The `notificationService.pendingActions` entries of type
  `consent:credential` or `consent:reconnect`.

**Cleanup semantics for abandoned state.** No user-facing timer
does not mean no cleanup. Every resource listed above is cleaned up
through explicit lifecycle events, not clocks:

1. **Connection-bound.** Each pending consent is associated with the
   RPC connection of its initiating caller (worker, panel, CLI,
   mobile, remote Electron). When that connection drops — worker
   exits, panel unmounts, renderer crashes, mobile app is killed,
   network disconnects — the server cancels the pending consent,
   rejects the awaiting promise with a clear error, closes any
   bound loopback listener, releases the verifier, and dismisses
   the dialog on any other surface currently showing it.
2. **Explicit dismissal.** Any surface (desktop shell, mobile
   sheet, CLI) can call `notification.dismiss(id)` to cancel a
   pending consent unilaterally; same cleanup path as (1).
3. **Server restart.** All in-memory pending consents are dropped
   on shutdown. Listeners are closed as the process exits; verifiers
   are lost; the next worker request starts a fresh consent. No
   persistence across restarts — consents are ephemeral by design.
4. **Safety-net reaper.** A background sweep runs every hour and
   GCs any pending consent, loopback listener, or verifier older
   than **24 hours** regardless of connection state. This exists
   to catch pathological leaks (a client that neither closes
   cleanly nor reconnects); it is **not** the primary cleanup
   path and 24 hours is long enough that legitimate slow users
   are never affected. The reaper logs every reap to the audit log
   so leaks are visible.

Connection-bound cleanup uses the existing RPC transport's
connection-close hooks (the HTTP RPC bridge already fires on
disconnect for request cancellation) — the credential system
subscribes to those events for its own pending-state GC.

**Configuration.** All timers above are expressible in
`natstack.yml` under a `credentials.timers` section with the same
names, for self-hosters who need to tune for their specific
provider load or network conditions. The 24-hour safety-net reaper
is also configurable (`credentials.timers.consentReaperHours`,
default 24); set to 0 to disable entirely.

### Test utilities

Shipped as `@natstack/credentials-test-utils`:

- Mock OAuth 2.1 server (in-memory, configurable to simulate any
  flow including failures, rotation, revocation).
- Mock provider API accepting any token with fixture-driven
  responses.
- VCR-style HTTP fixture recorder for real-provider test setup.
- Mock webhook relay for in-process event injection.

Used by our own tests and published so third-party provider authors
can write credible integration tests without hitting live
providers.

## Remaining open items

Implementation reminders:

1. **Self-hoster `client_id` override.** Yes, via `natstack.yml`.
   Documented in the provider manifest section. Implement in
   Wave 3 (step W3.T16).

The universal-link domain is decided in principle (Cloudflare Pages,
a parameter in both server and mobile config). The actual string is
chosen today; once it lands in `apps/well-known/config.json` and
`natstack.yml`'s `credentials.mobileCallbackDomain`, this item is
fully closed.

## Scheduled for v0.1 (post-launch enhancements)

Work that has a defined architecture in this plan but ships after
v0 launch:

- **Gmail + Calendar Pub/Sub push** — Wave 8. GCP project, shared
  Pub/Sub topic, push-subscription endpoint on the relay, `watch()`
  lifecycle manager, Google-JWT verifier, hybrid polling / push
  override in the integrations. Landing as an additive enhancement;
  the v0 polling path continues working unchanged.

## Out of scope for this plan

- Migrating existing users off Nango (no existing users).
- **Per-tool / per-call consent within a provider.** Capability
  security at the manifest level is coarse (worker X can call these
  endpoints). Per-call confirmation ("confirm sending 47 emails")
  is a product feature that builds on top of this, not part of it.
- **Token at-rest encryption via OS keychain.** `0o600` JSON files
  only. Acceptable given the local-first threat model; worth
  revisiting if we add backup/sync.
- **Multi-device credential sync.** Tailscale federation,
  encrypted-relay sync, and natstack-cloud are all explicit
  non-goals for v0. Mobile shares via the server; anything else is
  out.
- **Bidirectional MCP integration.** `flows/mcpDcr.ts` handles MCP
  as an auth pattern. Consuming arbitrary MCP servers' tools and
  exposing natstack as an MCP server are both later work.
- **OpenAPI auto-import for provider capabilities.** Hand-written
  manifests for v0. OpenAPI generation is a DX win for later.
- **Federation / IdP integration.** Enterprise feature; not v0.
- **Offline mobile access.** Mobile requires network reachability
  to the server.
- **Secrets rotation automation.** Manual rotation only.
- **Long-term dependency on Composio.** Once natstack's Google
  verification completes, the `composio-bridge` flow stays in core
  for potential reuse but is no longer on the critical path.

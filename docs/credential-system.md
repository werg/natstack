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
  uses it. (Check during Phase 1; the replacement `ConsentDialog`
  will be added in Phase 5.)

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
  captures code, exchanges for token.
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
- `refresh.ts` — scheduler; reads `expires_at`, refreshes N seconds before
  expiry, coalesces concurrent refresh requests, falls back through the
  resolver chain on failure.
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

- `credentials.requestConsent({ providerId, scopes }) → { connectionId,
  apiBase }` — idempotent per caller; if already granted, returns
  existing connection. If not, runs the manifest's flow chain
  synchronously, blocking until the user completes consent (with a
  timeout). Does **not** return the token. Used by desktop flows and
  by workers.
- `credentials.beginConsent({ providerId, scopes, redirect: "mobile" }) →
  { nonce, authorizeUrl }` — used by mobile; server mints a PKCE
  challenge and holds the verifier, returns the authorize URL with a
  universal-link callback.
- `credentials.completeConsent({ nonce, code }) → { connectionId }` —
  mobile relays the authorization code back; server exchanges it for
  tokens and stores them.
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

1. **Ingress**: receive outbound HTTP(S) requests from workers via
   `HTTP_PROXY` / `HTTPS_PROXY`-style routing (workerd supports
   outbound proxy config). Terminate TLS using the local CA (see
   Resolved decisions).
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
   the current access token from the store. Re-check expiry; if
   within 60s of expiry, refresh synchronously before forwarding.
7. **Circuit breaker + retry** (`retry.ts`): forward the request; on
   5xx, retry with exponential backoff up to a manifest-configured
   cap. N consecutive failures within a rolling window trip the
   breaker for a cooldown period; further requests fail fast.
8. **401 handling** (`reconsent.ts`): on 401 after refresh attempt,
   trigger re-consent via `notificationService`, suspend the
   in-flight request, retry once consent is re-granted.
9. **Audit** (`audit.ts`): append a structured record to the audit
   log: `{ ts, workerId, callerId, providerId, connectionId, method,
   url, status, durationMs, bytesIn, bytesOut, scopesUsed,
   capabilityViolation?, retries, breakerState }`. Daily rotation,
   size cap.
10. **Egress**: stream the response back to the worker.
11. **No-match passthrough**: if the request doesn't match any
    granted provider's `apiBase`, forward unchanged (no auth
    injection, no capability enforcement). Public unauthenticated
    endpoints still work. Still audited.

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
export async function requestConsent(
  providerId: string,
  scopes?: string[],
): Promise<{ connectionId: string; apiBase: string[] }>;

export async function revokeConsent(providerId: string): Promise<void>;
```

That is the entire public surface. There is no `getToken`, no
`authedFetch`, no provider-specific client. Integrations use plain
`fetch("https://api.github.com/...")` and the proxy handles auth.

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
   registry keyed on `workerId`.
2. Inject four new env vars into every worker:
   - `HTTP_PROXY=http://127.0.0.1:<proxyPort>`
   - `HTTPS_PROXY=http://127.0.0.1:<proxyPort>`
   - `NATSTACK_PROXY_AUTH=<token>`
   - `NATSTACK_CA_CERT=<path or base64>` — the local CA cert the proxy
     signs with, installed into the worker's trust store.
3. Generate Cap'n Proto config with `globalOutbound` pointing at the
   proxy service binding, so all fetch egress from the worker routes
   through it even if user code ignores the env vars. This is the
   workerd-native way; env vars are belt-and-braces.
4. On instance destruction, revoke the `PROXY_AUTH_TOKEN` from the
   proxy registry.

## Execution order

Land in this order. Each step keeps the tree in a working state.

### Phase 1 — demolition

1. Delete all files/docs/tables/env listed in **Demolition**.
2. Leave a single stub `src/server/services/credentialService.ts` with
   method signatures that throw `NotImplemented`, registered on the RPC
   server, so the tree compiles.
3. Verify `rg -i nango` returns zero hits.
4. Commit: `chore: remove unused nango prototype`.

### Phase 2 — core engine, no workers yet

5. Implement `packages/shared/src/credentials/{types,store,resolver,
   refresh,registry,consent}.ts`.
6. Implement `flows/loopbackPkce.ts` and `flows/pat.ts` first — simplest.
7. Implement `flows/deviceCode.ts`.
8. Implement `flows/cliPiggyback.ts`.
9. Implement `flows/composioBridge.ts` — the v0 Google backstop.
10. Implement `flows/mcpDcr.ts` — most code, depends on the MCP
    TS SDK (`@modelcontextprotocol/sdk`).
11. Implement `capability.ts`, `rateLimit.ts`, `retry.ts`,
    `audit.ts`, `reconsent.ts` as standalone modules with unit
    tests. They're consumed by the proxy in Phase 4 but self-contained
    here.
12. Scaffold `packages/shared/src/credentials/test-utils/` with
    `mockOAuthServer.ts` and `mockProvider.ts` — used by the unit
    tests in this phase and published from Phase 10.
13. Unit tests for each flow against the mock auth server (and a mock
    Composio endpoint for the bridge).
14. Commit: `feat(credentials): core engine, flow runners, proxy
    middlewares`.

### Phase 3 — first-party provider manifests

15. Write `providers/{github,google,microsoft,notion,slack}.ts` with
    real natstack-registered `client_id`s, including `apiBase`
    patterns, `rateLimits`, and `retry` configs per provider. Get the
    `client_id`s by:
    - GitHub: create an OAuth App under the natstack org.
    - Microsoft: register a multi-tenant Azure AD app.
    - Notion: register an OAuth integration (for the fallback) + MCP
      DCR (primary).
    - Slack: register a distributed Slack app with Socket Mode.
    - Google: **composio-bridge primary**, BYO `client_secret.json`
      fallback. Concurrently, start natstack's own Google
      verification (non-engineering track).
16. Implement `natstack.yml` override support so self-hosters can
    supply their own `client_id`/`client_secret` per provider.
17. Smoke test each manifest via `credentialService.requestConsent`
    against real providers, CLI only (no workerd yet).
18. Commit: `feat(credentials): first-party provider manifests`.

### Phase 4 — egress proxy

19. **Spike**: 1–2 day prototype verifying the CA + workerd
    trust-store interaction works cleanly. Kill switch for the whole
    phase if it doesn't — fall back to a worker-side `authedFetch`
    wrapper in that case.
20. Implement `src/server/services/egressProxy.ts` as the middleware
    pipeline described in **Egress proxy** — local CA, per-worker
    auth, attribution, capability enforcement, provider routing,
    rate limiting, auth injection, circuit breaker + retry, 401
    re-consent, audit, egress.
21. Wire each middleware into the pipeline; each is already
    implemented as a standalone module in Phase 2.
22. Tests: fake upstream + fake worker covering every pipeline
    stage — capability deny, rate-limit throttling, circuit breaker
    trip, 401 → refresh → retry, 401 → re-consent → retry, audit
    log entries, no-match passthrough.
23. Commit: `feat(credentials): host-side egress proxy with
    capability enforcement, rate limiting, audit`.

### Phase 5 — workerd wiring + consent UI

24. Extend `workerdManager.ts` per the workerd section above.
25. Extend `rpcServer.ts` to expose the new `credentials.*` methods
    (`requestConsent`, `beginConsent`, `completeConsent`,
    `listConnections`, `renameConnection`, `revokeConsent`,
    `listConsent`, `audit`, `subscribeWebhook`,
    `unsubscribeWebhook`).
26. Build `src/renderer/components/ConsentDialog.tsx` and its
    sub-components (`ProviderHeader`, `ScopeList`, `EndpointList`,
    `AccountPicker`). Wire `credentialService` →
    `notificationService.show({ type: "consent:credential" | "consent:reconnect", ... })`
    → `ConsentDialog`. Delete `NotificationBar.tsx`'s consent path
    (and the whole component if nothing non-consent uses it).
27. Implement `workspace/packages/runtime/src/worker/credentials.ts`
    SDK — thin wrapper over the HTTP RPC bridge. Supports the
    role-based API (`requestConsent("github", { role: "source" })`)
    and the `X-Natstack-Connection` header.
28. Add the manifest-autodiscovery pass at worker startup, including
    `endpoints` → capability matcher, `webhooks` → subscription
    registration, and `providers`/`role` → default-connection
    bindings.
29. End-to-end test: spawn a worker that calls
    `requestConsent("github")`, then `fetch("https://api.github.com/user")`.
    Verify the response contains the authed user, the
    `ConsentDialog` displayed the scope list + endpoint list +
    account picker, and the audit log recorded the call.
30. Test refresh-failure re-consent: force-expire a refresh token,
    verify the worker's next call suspends, triggers the re-consent
    prompt, and transparently retries on approval.
31. Commit: `feat(credentials): workerd integration + worker SDK`.

### Phase 5b — mobile native OAuth

32. **Domain + Cloudflare Pages setup** (infra, can parallel the code
    steps below):
    - Register / choose the chosen domain, point its DNS at
      Cloudflare.
    - Create `apps/well-known/` in this repo with
      `apple-app-site-association.template.json`,
      `assetlinks.template.json`, `config.json`, `build.ts`,
      `wrangler.toml`.
    - Create Cloudflare Pages project bound to `apps/well-known/`;
      verify production URL serves both files with HTTP 200 and
      `application/json`.
33. Add `credentials.mobileCallbackDomain` to `natstack.yml` (default:
    the natstack-owned domain chosen above) and
    `universalLinkDomain` to `apps/mobile/config.json` (with the
    wildcard dev pattern alongside the production domain).
34. Implement `apps/mobile/src/services/credentialConsent.ts` —
    launches `ASWebAuthenticationSession` / Chrome Custom Tabs,
    handles universal-link return, relays `{ nonce, code }` to server.
35. Add mobile-side rendering of the `"consent:credential"`
    notification (native sheet with Allow / Deny), calling the same
    `notification.reportAction` RPC as desktop.
36. End-to-end test: mobile → server RPC → provider consent → code
    relay → token stored → subsequent mobile-triggered worker call
    succeeds with auth.
37. Commit: `feat(credentials): mobile native OAuth`.

### Phase 6 — rebuild example integrations

38. Rewrite `workspace/packages/integrations/src/gmail.ts` against the
    new system — pure `fetch` calls, manifest declares Google scopes,
    `endpoints` capability list, and at least one webhook subscription
    (Gmail push notifications) to exercise the full surface.
39. Same for `calendar.ts`. Add a `github.ts` as a second reference,
    including an `issues` webhook subscription.
40. Rewrite `workspace/panels/email/index.tsx` from scratch against the
    new Gmail integration. Keep it minimal.
41. Rewrite `workspace/skills/api-integrations/SKILL.md` as the
    canonical guide for adding new integrations.
42. Commit: `feat(integrations): rebuild gmail/calendar on new system`.

### Phase 7 — service accounts + non-interactive mode

43. Implement `flows/serviceAccount.ts`, `flows/botToken.ts`,
    `flows/githubAppInstallation.ts`.
44. Add `--non-interactive` server flag and
    `credentials.nonInteractive` config. `credentialService` throws
    `NonInteractiveConsentRequired` when a prompt would be needed.
45. Add a config-driven "seed credentials" path: on server start,
    read `credentials.seeds: [{ providerId, flow, value }]` from
    `natstack.yml` or env, load into the store. This is how
    headless deployments inject bot tokens and service-account
    JSONs without a prompt.
46. End-to-end test: start server with `--non-interactive`, seed a
    GitHub bot token via env, run a worker that calls GitHub,
    verify it succeeds without any prompt and the audit log
    attributes the call to the bot.
47. Document the pattern in `docs/non-interactive-deployments.md`.
48. Commit: `feat(credentials): service accounts and
    non-interactive mode`.

### Phase 8 — webhooks

49. Build `apps/webhook-relay/` — Cloudflare Worker that accepts
    `POST /webhook/:instanceId/:providerId` and forwards to a
    long-lived WebSocket connected from the natstack server.
    Per-instance routing via a short-lived registration token
    minted when the server starts. No persistent storage in the
    Worker; events are dropped if no subscriber is connected
    (at-most-once delivery).
50. Implement `packages/shared/src/webhooks/{receiver,verifier,router,
    subscription}.ts`.
51. Implement `src/server/services/webhookService.ts` and wire to
    `credentialService.subscribeWebhook`.
52. Add per-provider signature verifiers to the GitHub, Slack,
    Stripe, Linear, Notion manifests.
53. End-to-end test: subscribe a worker to GitHub `issues` events,
    push a test webhook via GitHub API, verify it's verified,
    routed, and delivered to the worker's named handler.
54. Commit: `feat(webhooks): inbound event subsystem`.

### Phase 9 — test utilities and third-party provider story

55. Polish `packages/shared/src/credentials/test-utils/` — add
    `fixtureRecorder.ts`, `mockWebhookRelay.ts`, usage docs.
56. Publish as `@natstack/credentials-test-utils`.
57. Publish an example `@natstack/provider-linear` package on the repo
    as `workspace/examples/provider-linear/` demonstrating the
    third-party provider manifest shape — including capability
    declarations, rate limits, and a webhook subscription.
58. Document the manifest format in
    `docs/writing-a-provider-manifest.md`.
59. Commit: `docs: third-party provider authoring guide and test
    utilities`.

## Resolved decisions

These were open during the design discussion and are now committed.

### Mobile: native OAuth, server-held tokens

Mobile uses **native OAuth**: `ASWebAuthenticationSession` on iOS and
Chrome Custom Tabs on Android. The callback is a universal link / app
link back to the natstack mobile app.

Crucially, the mobile app is not the OAuth client from the provider's
perspective — the **server is**, mobile is just the user-interaction
surface. Flow:

1. Mobile UI (settings or at-first-use) calls server RPC
   `credentials.beginConsent({ providerId, scopes, redirect: "mobile" })`.
   Server stores a `{ nonce → providerId, scopes }` record, returns the
   authorize URL with the universal-link callback and the PKCE
   `code_challenge`. Server keeps the `code_verifier`.
2. Mobile opens the URL in the system OAuth session.
3. User approves; provider redirects to the universal link with `code`
   and `state=nonce`.
4. Mobile relays `{ nonce, code }` to server via RPC
   `credentials.completeConsent({ nonce, code })`.
5. Server exchanges the code for tokens using its held verifier, stores
   the token in the shared credential store. Mobile never sees it.

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

A prototype spike on the CA + workerd trust-store interaction should
happen at the start of Phase 4 before committing the full proxy
implementation.

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

- The `pendingActions` map + 120s timeout. The queue shape is
  correct.
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
   on user decision or timeout.
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

The proxy sees every outbound request. Integrations declare an
`endpoints` list in their manifest (URL + method allowlist); the
proxy enforces it. Tokens can be broad while workers get
principle-of-least-authority — if the Gmail integration only
declared `GET messages`, a compromised worker can't use the token to
send email, even though the token has `gmail.modify` scope.

Lives in `capability.ts`; enforced as middleware step 3 in the proxy
pipeline. Dev mode warns + allows; production mode denies. Denied
requests return a structured 403 to the worker naming the violated
capability. All violations audited.

This is the highest-leverage feature in the system. It only exists
because we own the egress boundary — it would not be possible with a
hosted broker like Nango.

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

Provider manifests declare supported webhook events and
signature-verification recipes. Integration manifests subscribe to
specific events and name a handler export. The runtime:

1. Registers a natstack-server-side subscription record.
2. For providers where webhook registration requires API calls
   (GitHub, Stripe, Linear), calls the provider's API to create the
   webhook pointing at a stable per-instance URL on
   `apps/webhook-relay/` (Cloudflare Worker).
3. Opens a long-lived WebSocket from the natstack server to the
   relay, keyed on a per-instance registration token.
4. When the relay receives a POST at
   `/webhook/:instanceId/:providerId`, forwards the body + headers
   over the WS.
5. `webhooks/verifier.ts` verifies the signature using the stored
   secret; `router.ts` dispatches to the worker's handler.

The relay is a tiny Cloudflare Worker with no persistent storage.
Events are dropped if no subscriber is connected (at-most-once
delivery). Upgrading to at-least-once via a Cloudflare Queue is a
later concern.

Why the WebSocket tunnel: natstack is local-first; the user's
server doesn't have a public HTTPS endpoint. The relay provides
the public endpoint; the WS delivers events through NAT / firewalls
without any user setup. Same pattern as ngrok, Cloudflare Tunnel,
etc., but scoped to webhook delivery.

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
  { connectionId, apiBase }` — if `accountHint` matches exactly one
  existing connection's `email` / `username` / `workspaceName` /
  `connectionId`, reuses it. If multiple matches or no match,
  prompts with the picker UI described below.
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

**Worker SDK**

```ts
// single-role
const gh = await requestConsent("github");
await fetch("https://api.github.com/user");  // proxy uses the granted connection

// multi-role
const source = await requestConsent("github", { role: "source" });
const target = await requestConsent("github", { role: "target" });
await source.fetch("https://api.github.com/repos/.../issues");
await target.fetch("https://api.github.com/repos/.../issues", { method: "POST" });
```

`source.fetch` and `target.fetch` are thin wrappers over plain
`fetch` that stamp an `X-Natstack-Connection: <connectionId>`
header. The proxy strips the header and uses it to pick the right
token. Workers can set a default-connection-per-provider at init
and then use plain `fetch()` for everything.

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

No new phase; threads through existing phases:

- Phase 2: `Credential` type includes `connectionId`,
  `accountIdentity`, `connectionLabel`; store path uses
  `<providerId>/<connectionId>.json` from day 1.
- Phase 3: every first-party manifest declares `whoami`.
- Phase 4: proxy step 4 implemented as provider + connection
  routing; capability keying includes `connectionId`.
- Phase 5: consent dialog renders the account picker; RPC
  methods above exposed.
- Phase 6: at least one example integration demonstrates roles
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
- **No auto-dismiss, no toast behaviour.** Consent is an explicit
  decision; the dialog stays until the user chooses.
- **120-second timeout** before auto-deny, matching the notification
  queue's timeout. After 60 seconds, a subtle "Request will expire
  in 60s" indicator appears.

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

- `notificationService.pendingActions` queue and 120-second
  timeout — it's a clean pattern and works.
- `reportAction` RPC — unchanged API.

Infrastructure removed:

- `secretsService.ts`, `secretsStore.ts`, and the
  `~/.config/natstack/.secrets.yml` file — see Demolition. The
  whole secrets-approval flow is dead code now that Nango is
  going; nothing else uses it.
- `NotificationBar.tsx`'s `type: "consent"` code path — replaced
  by `ConsentDialog.tsx`.

**Execution-order impact**

- Phase 5 covers the new `ConsentDialog` component and the RPC
  payload shape for `consent:credential` / `consent:reconnect`.
- Phase 5 also removes `NotificationBar`'s consent code path (or
  the whole component if nothing else needs it).
- Phase 5b extends `ConsentSheet` to mobile.

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

Just one implementation reminder:

1. **Self-hoster `client_id` override.** Yes, via `natstack.yml`.
   Documented in the provider manifest section. Implement in Phase 3
   step 16.

The universal-link domain is decided in principle (Cloudflare Pages,
a parameter in both server and mobile config). The actual string is
chosen today; once it lands in `apps/well-known/config.json` and
`natstack.yml`'s `credentials.mobileCallbackDomain`, this item is
fully closed.

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

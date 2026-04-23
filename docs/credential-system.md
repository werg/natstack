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

### Database

- Drop `oauth_tokens` table
- Drop `oauth_consent` table
- No data migration — nothing is in production use

### Config / secrets

- Remove `NANGO_SECRET_KEY` handling from
  `packages/shared/src/secrets/secretsStore.ts`
- Remove `nango:` YAML key and any `nangoUrl` config support from
  `workspace/meta/natstack.yml`
- Remove `NANGO_URL` env var handling from `src/server/index.ts`

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
- `flows/index.ts` — dispatcher keyed on `flow.type`.
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

No `getToken` RPC. Tokens never leave the host.

The consent prompt is surfaced by delegating to
`notificationService.show({ type: "consent:credential", ... })` —
mirrors how `secretsService` handles approval today. See **Consent UI**
under Resolved decisions.

`src/server/services/egressProxy.ts` — the heart of the new system. See
next section.

### Egress proxy

A local HTTP forward proxy on `127.0.0.1:<random-port>`, started alongside
`workerdManager`. Per-worker authentication via a proxy-auth token minted
when the worker is spawned (parallel to the existing `RPC_AUTH_TOKEN`).

Responsibilities:

1. Receive outbound HTTP(S) requests from workers via `HTTP_PROXY` /
   `HTTPS_PROXY`-style routing (workerd supports outbound proxy config).
2. Identify the originating worker from the proxy-auth header.
3. Look up the worker's consent grants.
4. Match the request URL host against the `apiBase` patterns of every
   granted provider manifest.
5. On match: inject `Authorization: Bearer <token>`, forward the request,
   stream the response back.
6. On 401 from upstream: trigger refresh via `refresh.ts`, retry the
   request once, stream result.
7. On no match: forward unchanged. The proxy is permissive by default —
   unauthenticated public endpoints still work.
8. Log every request with the injected provider, for audit.

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

Add a convention (not a new runtime system) for integrations to declare
required providers. Integration modules export a `manifest` const:

```ts
export const manifest = {
  providers: ["github"],
  scopes: { github: ["repo", "read:user"] },
};
```

At worker-startup, the runtime auto-discovers these exports (walk the
module graph from the entry point, collect `manifest` exports) and calls
`requestConsent` for each before the integration code runs. This gives
users one batched consent prompt per worker, not one per API call.

If an integration forgets to declare a provider and tries to call its
API at runtime, the proxy will still work but consent won't have been
granted ahead of time — first fetch triggers a late consent prompt.
Warn in logs; don't block.

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
10. Implement `flows/mcpDcr.ts` last — most code, depends on the MCP
    TS SDK (`@modelcontextprotocol/sdk`).
11. Unit tests for each flow against a mock auth server (and a mock
    Composio endpoint for the bridge).
12. Commit: `feat(credentials): core engine and flow runners`.

### Phase 3 — first-party provider manifests

13. Write `providers/{github,google,microsoft,notion,slack}.ts` with
    real natstack-registered `client_id`s. Get the `client_id`s by:
    - GitHub: create an OAuth App under the natstack org.
    - Microsoft: register a multi-tenant Azure AD app.
    - Notion: register an OAuth integration (for the fallback) + MCP
      DCR (primary).
    - Slack: register a distributed Slack app with Socket Mode.
    - Google: **composio-bridge primary**, BYO `client_secret.json`
      fallback. Concurrently, start natstack's own Google
      verification (non-engineering track).
14. Implement `natstack.yml` override support so self-hosters can
    supply their own `client_id`/`client_secret` per provider.
15. Smoke test each manifest via `credentialService.requestConsent`
    against real providers, CLI only (no workerd yet).
16. Commit: `feat(credentials): first-party provider manifests`.

### Phase 4 — egress proxy

17. **Spike**: 1–2 day prototype verifying the CA + workerd
    trust-store interaction works cleanly. Kill switch for the whole
    phase if it doesn't — fall back to a worker-side `authedFetch`
    wrapper in that case.
18. Implement `src/server/services/egressProxy.ts` with a local CA
    (`@peculiar/x509`), per-worker auth, URL pattern matching, and
    header injection.
19. Implement 401 → refresh → retry path.
20. Add proxy-side audit logging.
21. Tests: fake upstream + fake worker, verify headers injected,
    401 retries, no-match passthrough.
22. Commit: `feat(credentials): host-side egress proxy`.

### Phase 5 — workerd wiring + consent UI

23. Extend `workerdManager.ts` per the workerd section above.
24. Extend `rpcServer.ts` to expose the new `credentials.*` methods.
25. Wire `credentialService` → `notificationService` for the consent
    prompt, matching the secrets flow exactly (new `"consent:credential"`
    type or similar, same `pendingActions` queue, same `NotificationBar`
    render path).
26. Implement `workspace/packages/runtime/src/worker/credentials.ts`
    SDK — thin wrapper over the HTTP RPC bridge.
27. Add the manifest-autodiscovery pass at worker startup.
28. End-to-end test: spawn a worker that calls
    `requestConsent("github")`, then `fetch("https://api.github.com/user")`.
    Verify the response contains the authed user and that the
    NotificationBar displayed an Allow/Deny prompt.
29. Commit: `feat(credentials): workerd integration + worker SDK`.

### Phase 5b — mobile native OAuth

30. **Domain + Cloudflare Pages setup** (infra, can parallel the code
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
31. Add `credentials.mobileCallbackDomain` to `natstack.yml` (default:
    the natstack-owned domain chosen above) and
    `universalLinkDomain` to `apps/mobile/config.json` (with the
    wildcard dev pattern alongside the production domain).
32. Implement `apps/mobile/src/services/credentialConsent.ts` —
    launches `ASWebAuthenticationSession` / Chrome Custom Tabs,
    handles universal-link return, relays `{ nonce, code }` to server.
33. Add mobile-side rendering of the `"consent:credential"`
    notification (native sheet with Allow / Deny), calling the same
    `notification.reportAction` RPC as desktop.
34. End-to-end test: mobile → server RPC → provider consent → code
    relay → token stored → subsequent mobile-triggered worker call
    succeeds with auth.
35. Commit: `feat(credentials): mobile native OAuth`.

### Phase 6 — rebuild example integrations

36. Rewrite `workspace/packages/integrations/src/gmail.ts` against the
    new system — pure `fetch` calls, manifest declares Google scopes.
37. Same for `calendar.ts`. Add a `github.ts` as a second reference.
38. Rewrite `workspace/panels/email/index.tsx` from scratch against the
    new Gmail integration. Keep it minimal.
39. Rewrite `workspace/skills/api-integrations/SKILL.md` as the
    canonical guide for adding new integrations.
40. Commit: `feat(integrations): rebuild gmail/calendar on new system`.

### Phase 7 — third-party provider story

41. Publish an example `@natstack/provider-linear` package on the repo
    as `workspace/examples/provider-linear/` demonstrating the
    third-party provider manifest shape.
42. Document the manifest format in
    `docs/writing-a-provider-manifest.md`.
43. Commit: `docs: third-party provider authoring guide`.

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

### Consent UI: follow the secrets service pattern

The existing secrets service is the canonical pattern and the
credential consent UI mirrors it exactly.

Reference: `src/server/services/secretsService.ts` and
`src/server/services/notificationService.ts`.

The pattern:

1. Worker/panel calls `credentials.requestConsent({ providerId, scopes })`
   via RPC. It's a **blocking async call** that doesn't return until
   the user approves or denies, or the 120s timeout expires.
2. `credentialService` forwards to `notificationService.show(...)`
   with type `"consent"`, caller attribution (`callerId`, `callerKind`),
   and a human-readable message ("Panel X wants to connect to
   GitHub to access ...").
3. `notificationService` stores `{ resolve, reject, timer }` in its
   existing `pendingActions` map and broadcasts to the
   `NotificationBar` in the renderer
   (`src/renderer/components/NotificationBar.tsx`). Reuses the same
   violet "consent" styling secrets use.
4. User clicks **Allow** or **Deny**. UI calls
   `notification.reportAction(id, actionId)`; `notificationService`
   resolves the matching promise; `credentialService` proceeds with the
   flow runner (or throws).
5. Shell-initiated callers bypass the prompt (same as secrets).

Concretely this means `credentialService` depends on
`notificationService` and does not need its own UI surface. We don't
add a new component; we add a new notification `type` value ("consent"
is already used by secrets — may need a subtype like
`"consent:credential"` to disambiguate button copy).

For mobile, the same `notificationService.pendingActions` queue
broadcasts to mobile via the existing notification channel; mobile
renders a native sheet with Allow/Deny that calls `reportAction`.
Single queue, two UI surfaces, identical semantics.

## Remaining open items

Just one implementation reminder:

1. **Self-hoster `client_id` override.** Yes, via `natstack.yml`.
   Documented in the provider manifest section. Implement in Phase 3
   step 14.

The universal-link domain is decided in principle (Cloudflare Pages,
a parameter in both server and mobile config). The actual string is
chosen today; once it lands in `apps/well-known/config.json` and
`natstack.yml`'s `credentials.mobileCallbackDomain`, this item is
fully closed.

## Out of scope for this plan

- Migrating existing users off Nango (no existing users).
- Fine-grained per-tool consent within a provider (e.g. "this tool
  can only read email, not send"). The manifest's `scopes` split
  gives us coarse control; per-tool attenuation is a later pass.
- Token sharing across multiple natstack hosts on the same machine
  (single-user assumption; mtime-watch handles concurrent refreshes
  within one machine).
- **Offline mobile access to provider APIs.** Mobile requires
  network reachability to the server because tokens live exclusively
  server-side. Acceptable for v0.
- Secrets rotation automation.
- Long-term dependency on Composio. Once natstack's Google
  verification completes, the `composio-bridge` flow type stays in
  core for potential reuse with other providers but is no longer on
  the critical path.

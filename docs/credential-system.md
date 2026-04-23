# Credential System — Replacing Nango

Status: Plan. Nothing in this doc is implemented yet.

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
- `google.ts` — loopback-PKCE primary, device-code fallback, BYO
  `client_secret.json` fallback (Hermes pattern — for v0 before Google
  verification completes). `apiBase: ["https://gmail.googleapis.com",
  "https://www.googleapis.com", "https://oauth2.googleapis.com"]`. Scopes
  split by Google product (mail, calendar, drive) so consent stays
  minimal.
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
`oauthService.ts`. RPC methods exposed to workers via the existing
`/rpc` endpoint:

- `credentials.requestConsent({ providerId, scopes }) → { connectionId,
  apiBase }` — idempotent per worker; if already granted, returns
  existing connection. If not, runs the manifest's flow chain
  synchronously, blocking until the user completes consent (with a
  timeout). Does **not** return the token.
- `credentials.revokeConsent({ providerId }) → void`
- `credentials.listConsent({}) → ConsentGrant[]` — for UI/debug.

No `getToken` RPC. Tokens never leave the host.

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
9. Implement `flows/mcpDcr.ts` last — most code, depends on the MCP
   TS SDK (`@modelcontextprotocol/sdk`).
10. Unit tests for each flow against a mock auth server.
11. Commit: `feat(credentials): core engine and flow runners`.

### Phase 3 — first-party provider manifests

12. Write `providers/{github,google,microsoft,notion,slack}.ts` with
    real natstack-registered `client_id`s. Get the `client_id`s by:
    - GitHub: create an OAuth App under the natstack org.
    - Microsoft: register a multi-tenant Azure AD app.
    - Notion: register an OAuth integration (for the fallback) + MCP
      DCR (primary).
    - Slack: register a distributed Slack app with Socket Mode.
    - Google: defer — ship with `byoClientSecret` only for v0.
13. Smoke test each manifest via `credentialService.requestConsent`
    against real providers, CLI only (no workerd yet).
14. Commit: `feat(credentials): first-party provider manifests`.

### Phase 4 — egress proxy

15. Implement `src/server/services/egressProxy.ts` with a local CA
    (`@peculiar/x509`), per-worker auth, URL pattern matching, and
    header injection.
16. Implement 401 → refresh → retry path.
17. Add proxy-side audit logging.
18. Tests: fake upstream + fake worker, verify headers injected,
    401 retries, no-match passthrough.
19. Commit: `feat(credentials): host-side egress proxy`.

### Phase 5 — workerd wiring

20. Extend `workerdManager.ts` per the workerd section above.
21. Extend `rpcServer.ts` to expose the new `credentials.*` methods.
22. Implement `workspace/packages/runtime/src/worker/credentials.ts`
    SDK — thin wrapper over the HTTP RPC bridge.
23. Add the manifest-autodiscovery pass at worker startup.
24. End-to-end test: spawn a worker that calls
    `requestConsent("github")`, then `fetch("https://api.github.com/user")`.
    Verify the response contains the authed user.
25. Commit: `feat(credentials): workerd integration + worker SDK`.

### Phase 6 — rebuild example integrations

26. Rewrite `workspace/packages/integrations/src/gmail.ts` against the
    new system — pure `fetch` calls, manifest declares Google scopes.
27. Same for `calendar.ts`. Add a `github.ts` as a second reference.
28. Rewrite `workspace/panels/email/index.tsx` from scratch against the
    new Gmail integration. Keep it minimal.
29. Rewrite `workspace/skills/api-integrations/SKILL.md` as the
    canonical guide for adding new integrations.
30. Commit: `feat(integrations): rebuild gmail/calendar on new system`.

### Phase 7 — third-party provider story

31. Publish an example `@natstack/provider-linear` package on the repo
    as `workspace/examples/provider-linear/` demonstrating the
    third-party provider manifest shape.
32. Document the manifest format in
    `docs/writing-a-provider-manifest.md`.
33. Commit: `docs: third-party provider authoring guide`.

## Open decisions

1. **Mobile auth** (`apps/mobile/src/services/oauthHandler.ts` is gone
   after Phase 1). Three options:
   - (a) Mobile is a thin client to a desktop natstack host; no
     standalone mobile auth. Simplest. Works for dev.
   - (b) Native OAuth via ASWebAuthenticationSession (iOS) / Chrome
     Custom Tabs (Android) with a custom URL scheme or universal
     link callback. Real production path.
   - (c) Punt — mobile gets PAT-only for v0.
   Recommendation: (c) for v0, (b) when mobile ships to real users.

2. **Self-hoster OAuth client override**. Do we let a self-hoster
   override the natstack `client_id` with their own per provider?
   Recommendation: yes, via `natstack.yml` — cheap to support,
   gives the escape hatch to self-hosters who don't want their
   OAuth activity tied to the natstack org.

3. **TLS interception in the egress proxy**. Plan commits to it.
   Alternative: require integrations to call
   `authedFetch(providerId, url)` instead of plain `fetch`, and put
   auth injection in user-space. Cleaner, no CA dance; costs the
   "integrations just use fetch" property. Recommendation: stick
   with TLS interception — the zero-ceremony `fetch` story is worth
   it and the CA is fully local.

4. **Google verification**. Phase 3 defers this. Someone needs to
   actually start the verification process now so we're not blocked
   on it for 2+ months later.

5. **Credential consent UI**. Where does the "approve github access"
   prompt render? Desktop app shell chrome? A browser tab the proxy
   opens? The panel that triggered it? Recommendation: a dedicated
   consent overlay in the shell, matching how other native apps do
   it. Not blocking — can use CLI prompt for dev until UI lands.

## Out of scope for this plan

- Migrating existing users off Nango (no existing users).
- Fine-grained per-tool consent within a provider (e.g. "this tool
  can only read email, not send"). The manifest's `scopes` split
  gives us coarse control; per-tool attenuation is a later pass.
- Token sharing across multiple natstack hosts on the same machine
  (single-user assumption; mtime-watch handles concurrent refreshes
  within one machine).
- Secrets rotation automation.

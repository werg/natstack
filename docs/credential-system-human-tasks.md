# Credential System Human Tasks

This is the current human-facing plan for the URL-bound credential work. It
intentionally does not revive provider manifests, default credentials, legacy
consent, or non-interactive deployment flows.

## Target Domains

- `snugenv.com`: public product/apex domain and optional well-known fallback.
- `auth.snugenv.com`: OAuth universal-link callback host.
- `hooks.snugenv.com`: public webhook ingress relay host.

OAuth callback paths should be:

- `https://auth.snugenv.com/oauth/callback/:providerId`
- transitional fallback only: `natstack://oauth/callback/:providerId`

Webhook public ingress paths should be:

- `https://hooks.snugenv.com/i/:subscriptionId`

The NatStack server should continue to receive relay traffic on private service
routes, not on provider-facing URLs directly.

## Operating Principles

1. Userland declares intent; the host owns credentials and ingress trust.
2. OAuth code exchange happens in server-supported credential APIs. Userland
   never receives access tokens or refresh tokens.
3. Webhook verification happens before userland code sees an event.
4. Session credential grants remain process/session scoped. No repo-wide
   defaults are reintroduced.
5. Public infrastructure must fail closed when domain, signing, or relay secrets
   are missing.

## Current Implementation Status

Implemented in the repo:

- Mobile OAuth helpers default to
  `https://auth.snugenv.com/oauth/callback/:providerId` and complete through the
  server-supported PKCE credential APIs.
- `beginCreateWithOAuthPkce` returns an explicit `state` alias so mobile can
  register the pending callback without deriving host internals.
- The webhook relay accepts `POST /i/:subscriptionId`, preserves the raw body,
  signs the relay envelope, and forwards to the private server ingress route.
- The server verifies the relay envelope before provider verification, applies
  replay protection, stores subscriptions durably in workspace SQLite, and
  dispatches verified events to the configured worker target.
- Worker and panel runtimes expose generic webhook subscription APIs:
  create, list, revoke, and rotate secret.
- Userland subscriptions are constrained to the caller's own source before they
  can target a worker method.

Still blocked on real deployment details or broader product decisions:

- Real DNS, Cloudflare bindings, relay secrets, Apple Team ID, Android signing
  fingerprints, and provider redirect registrations.
- A mobile OAuth continuation token if OAuth must survive full app termination
  or a shell reconnect during the pending flow.
- A dedicated approval-bar shape for public ingress creation; the current
  credential approval queue is credential-shaped and should not be reused
  blindly for webhook targets.
- Delivery audit entries and end-to-end provider tests.
- Deleting legacy relay `/calendar/:leaseId` and `/pubsub/:providerId` routes
  after existing integrations have moved to `/i/:subscriptionId`.

## Human Tasks

### Domain and Cloudflare

- Add DNS records for:
  - `snugenv.com`
  - `auth.snugenv.com`
  - `hooks.snugenv.com`
- Bind `snugenv.com` and `auth.snugenv.com` to the well-known static site.
- Bind `hooks.snugenv.com` to the webhook relay Worker.
- Decide the production NatStack relay-to-server target for hosted/dev
  deployments. For local-only development, expose the local gateway through an
  explicit tunnel and set the relay's upstream to that tunnel URL.
- Configure Cloudflare secrets for the relay:
  - `NATSTACK_SERVER_BASE_URL`
  - `NATSTACK_RELAY_SIGNING_SECRET`
  - optional temporary `NATSTACK_SERVER_BEARER_TOKEN` only if a deployment still
    needs legacy bearer forwarding during migration.

### Mobile App Links

- Fill `apps/well-known/config.json` with the real Apple Developer Team ID.
- Fill `apps/well-known/config.json` with Android release signing SHA256
  fingerprints:
  - upload key
  - Play App Signing key, if Play signing is enabled
- Build and deploy the well-known site.
- Verify:
  - `https://auth.snugenv.com/.well-known/apple-app-site-association`
  - `https://auth.snugenv.com/.well-known/assetlinks.json`
  - same payloads from `https://snugenv.com/.well-known/...` if apex deep links
    are kept.
- Confirm iOS associated domains include `applinks:auth.snugenv.com`.
- Confirm Android intent filters include `https://auth.snugenv.com/oauth/callback`.
- Keep `natstack://` only as a debug/transitional fallback until app-link
  verification is proven on production builds.

### OAuth Provider Registrations

For each OAuth-backed credential provider we ship or document:

- Register `https://auth.snugenv.com/oauth/callback/:providerId`.
- Register loopback redirects only for desktop flows that need them.
- Prefer public PKCE clients. Do not require a mobile client secret.
- Record whether the provider supports:
  - absent `token_type`
  - absent `expires_in`
  - refresh tokens
  - custom scopes
  - strict redirect URI matching

The OpenAI/Codex default must continue to use URL-bound credentials and the
server-supported OAuth PKCE path. The default model is
`openai-codex:gpt-5.5`.

### Webhook Provider Setup

For each provider integration that needs webhooks:

- Create the provider-side webhook URL with
  `https://hooks.snugenv.com/i/:subscriptionId`.
- Generate a provider webhook secret where the provider supports one.
- Select a verifier primitive:
  - HMAC SHA-256 header
  - timestamped HMAC
  - bearer token header
  - provider-specific built-in verifier only when needed
- Document expected event headers and replay identifiers.

No provider webhook should point at the old `/calendar/:leaseId` or
`/pubsub/:providerId` relay paths after the migration.

## Programming Work

### Phase 1: Mobile OAuth on `auth.snugenv.com`

1. Add a mobile OAuth helper to `workspace/packages/runtime` that wraps:
   - `credentials.beginCreateWithOAuthPkce`
   - system-browser open
   - mobile deep-link pending-flow registration
   - `credentials.completeCreateWithOAuthPkce`
2. Make the helper use
   `https://auth.snugenv.com/oauth/callback/:providerId` by default on mobile.
3. Return enough data from `beginCreateWithOAuthPkce` for mobile to register the
   pending flow. Today `nonce` is also the OAuth state; keep that contract
   explicit in types/tests or add a `state` field that aliases it.
4. Ensure the mobile completion call uses the same shell/server caller identity
   that began the flow. If mobile reconnects during OAuth, add a short-lived
   mobile OAuth continuation token instead of weakening the caller check.
5. Add mobile tests for:
   - universal-link callback parsing
   - custom-scheme fallback warning
   - duplicate callback dedupe
   - begin/complete happy path
   - state mismatch rejection
   - app restart/reconnect behavior
6. Keep desktop loopback unchanged. Panels and workers should continue using the
   existing server-supported PKCE APIs and should not receive raw tokens.

### Phase 2: Well-Known Deployment Hardening

1. Extend `apps/well-known` build output with an explicit
   `auth.snugenv.com`/`snugenv.com` deployment checklist.
2. Add tests that fail production builds if placeholder Team ID or Android
   fingerprints remain.
3. Add a small verification script that fetches both well-known URLs and checks:
   - content type
   - cache headers
   - Apple app ID
   - Android package/fingerprints
4. Wire that script into CI as a manual or environment-gated check.

### Phase 3: Generic Public Webhook Ingress

1. Replace provider-shaped relay routes with one public route:
   - `POST /i/:subscriptionId`
2. Preserve the raw request body and original provider headers at the relay.
3. Sign a relay envelope before forwarding to the NatStack server:
   - method
   - path
   - query
   - timestamp
   - raw body SHA-256
   - selected original headers
4. Forward to a private server route such as:
   - `POST /_r/s/webhookIngress/:subscriptionId`
5. On the server, verify the relay envelope first, then look up the webhook
   subscription, then verify the provider signature.
6. Add replay protection:
   - relay timestamp tolerance
   - provider delivery ID dedupe when available
   - payload hash dedupe fallback with a short TTL
7. Deliver verified events to userland through a worker method or event queue.
   The delivery payload should include verified metadata and parsed JSON when
   safe, but also keep the raw body available for integrations that need it.
8. Add audit entries for:
   - accepted delivery
   - verifier failure
   - replay rejection
   - target delivery failure

### Phase 4: Webhook Subscription API

1. Replace legacy provider/lease subscription storage with a generic model:
   - `subscriptionId`
   - `owner`
   - `targetWorker`
   - `targetMethod`
   - `verifier`
   - `secretRef` or encrypted secret
   - `publicUrl`
   - `createdAt`
   - `revokedAt`
2. Add runtime APIs for workers/panels:
   - create subscription
   - list own subscriptions
   - revoke subscription
   - rotate secret
3. Require shell/server approval to create public ingress for sensitive targets.
4. Ensure userland cannot create a subscription that targets another source's
   worker/method.
5. Add migration tests proving old calendar/pubsub relay paths are no longer
   advertised.

### Phase 5: Verification and Cutover

1. Add end-to-end tests with a local fake OAuth provider and a local fake
   webhook sender.
2. Add Cloudflare Worker unit tests for relay signing and raw-body preservation.
3. Add server integration tests for:
   - valid signed relay + valid provider signature
   - valid relay + invalid provider signature
   - invalid relay signature
   - replayed delivery
   - revoked subscription
4. Update `docs/credential-system.md`, `docs/routes.md`, and the sandbox skills
   once the APIs are stable.
5. Delete all old `/calendar/:leaseId`, `/pubsub/:providerId`, provider-lease,
   and webhook-watch terminology from code/docs after the generic ingress path
   is live.

## Open Decisions

- Whether `hooks.snugenv.com` points directly at a Cloudflare Worker in all
  environments or only production.
- Whether local development should require an explicit tunnel or use a hosted
  relay queue.
- Which verifier primitives are required for the first integrations beyond
  HMAC/timestamped HMAC/bearer.
- Whether mobile OAuth continuations need to survive full app termination or
  only foreground/background reconnects during the pending OAuth TTL.

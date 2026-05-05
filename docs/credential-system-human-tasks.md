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

- Mobile credential OAuth now starts through `credentials.connect`; the
  host owns redirect creation, browser handoff, callback validation, and token
  exchange.
- The webhook relay accepts `POST /i/:subscriptionId`, preserves the raw body,
  signs the relay envelope, and forwards to the private server ingress route.
- The server verifies the relay envelope before provider verification, applies
  replay protection, stores subscriptions durably in workspace SQLite, and
  dispatches verified events to the configured worker target.
- Worker and panel runtimes expose generic webhook subscription APIs:
  create, list, revoke, and rotate secret.
- Userland subscriptions are constrained to the caller's own source before they
  can target a worker method.
- Legacy webhook relay routes, provider/lease subscription storage, and
  manifest-webhook runtime stubs have been deleted.

Follow-up TODOs:

- TODO: Configure real DNS, Cloudflare bindings, relay secrets, Apple Team ID,
  Android signing fingerprints, and provider redirect registrations.
- TODO: Add a mobile OAuth continuation token if OAuth must survive full app
  termination or a shell reconnect during the pending flow.
- TODO: Add a dedicated approval-bar shape for public ingress creation; the
  current credential approval queue is credential-shaped and should not be
  reused blindly for webhook targets.
- TODO: Add delivery audit entries and end-to-end provider tests.
- TODO: Verify no deployed provider still points at deleted legacy
  `/calendar/:leaseId` or `/pubsub/:providerId` URLs.

## Human Tasks

### TODO: Domain and Cloudflare

- TODO: Add DNS records for:
  - `snugenv.com`
  - `auth.snugenv.com`
  - `hooks.snugenv.com`
- TODO: Bind `snugenv.com` and `auth.snugenv.com` to the well-known static site.
- TODO: Bind `hooks.snugenv.com` to the webhook relay Worker.
- TODO: Decide the production NatStack relay-to-server target for hosted/dev
  deployments. For local-only development, expose the local gateway through an
  explicit tunnel and set the relay's upstream to that tunnel URL.
- TODO: Configure Cloudflare secrets for the relay:
  - `NATSTACK_SERVER_BASE_URL`
  - `NATSTACK_RELAY_SIGNING_SECRET`

### TODO: Mobile App Links

- TODO: Fill `apps/well-known/config.json` with the real Apple Developer Team ID.
- TODO: Fill `apps/well-known/config.json` with Android release signing SHA256
  fingerprints:
  - upload key
  - Play App Signing key, if Play signing is enabled
- TODO: Build and deploy the well-known site.
- TODO: Verify:
  - `https://auth.snugenv.com/.well-known/apple-app-site-association`
  - `https://auth.snugenv.com/.well-known/assetlinks.json`
  - same payloads from `https://snugenv.com/.well-known/...` if apex deep links
    are kept.
- TODO: Confirm iOS associated domains include `applinks:auth.snugenv.com`.
- TODO: Confirm Android intent filters include `https://auth.snugenv.com/oauth/callback`.
- TODO: Keep `natstack://` only as a debug/transitional fallback until app-link
  verification is proven on production builds.

### TODO: OAuth Provider Registrations

For each OAuth-backed credential provider we ship or document:

- TODO: Register `https://auth.snugenv.com/oauth/callback/:providerId`.
- TODO: Register loopback redirects only for desktop flows that need them.
- TODO: Prefer public PKCE clients. Do not require a mobile client secret.
- TODO: Record whether the provider supports:
  - absent `token_type`
  - absent `expires_in`
  - refresh tokens
  - custom scopes
  - strict redirect URI matching

The OpenAI/Codex default must continue to use URL-bound credentials and the
server-supported OAuth PKCE path. The default model is
`openai-codex:gpt-5.5`.

### TODO: Webhook Provider Setup

For each provider integration that needs webhooks:

- TODO: Create the provider-side webhook URL with
  `https://hooks.snugenv.com/i/:subscriptionId`.
- TODO: Generate a provider webhook secret where the provider supports one.
- TODO: Select a verifier primitive:
  - HMAC SHA-256 header
  - timestamped HMAC
  - bearer token header
  - provider-specific built-in verifier only when needed
- TODO: Document expected event headers and replay identifiers.

Provider webhooks must use `https://hooks.snugenv.com/i/:subscriptionId`.

## Programming Work

### Completed: Mobile OAuth on `auth.snugenv.com`

Done:

1. Mobile credential OAuth helper delegates to `credentials.connect`.
2. The helper uses
   `https://auth.snugenv.com/oauth/callback/:providerId` by default on mobile.
3. Desktop loopback is host-owned. Panels and workers use `connect` and do
   not receive raw tokens or compose redirects.

Follow-up:

- TODO: Add a short-lived mobile OAuth continuation token if mobile reconnects
  during OAuth or the app must survive full termination while an OAuth flow is
  pending.
- TODO: Add app restart/reconnect mobile OAuth tests once continuation tokens
  exist.

### TODO: Well-Known Deployment Hardening

1. TODO: Extend `apps/well-known` build output with an explicit
   `auth.snugenv.com`/`snugenv.com` deployment checklist.
2. Done: production builds fail if placeholder Team ID or Android fingerprints
   remain.
3. TODO: Add a small verification script that fetches both well-known URLs and checks:
   - content type
   - cache headers
   - Apple app ID
   - Android package/fingerprints
4. TODO: Wire that script into CI as a manual or environment-gated check.

### Completed: Generic Public Webhook Ingress

Done:

1. Provider-shaped relay routes were replaced with one public route:
   - `POST /i/:subscriptionId`
2. The relay preserves the raw request body and original provider headers.
3. The relay signs an envelope before forwarding to the NatStack server:
   - method
   - path
   - query
   - timestamp
   - raw body SHA-256
4. The relay forwards to:
   - `POST /_r/s/webhookIngress/:subscriptionId`
5. The server verifies the relay envelope first, then looks up the webhook
   subscription, then verifies the provider signature.
6. Replay protection exists:
   - relay timestamp tolerance
   - provider delivery ID dedupe when available
   - payload hash dedupe fallback with a short TTL
7. Verified events are delivered to userland through a worker method.
8. Tests prove old calendar/pubsub relay paths are no longer exposed.

Follow-up:

- TODO: Add audit entries for:
  - accepted delivery
  - verifier failure
  - replay rejection
  - target delivery failure

### Completed: Webhook Subscription API

Done:

1. Legacy provider/lease subscription storage was deleted.
2. Generic webhook ingress subscriptions are stored durably with:
   - `subscriptionId`
   - owner caller
   - target worker source/class/object/method
   - verifier
   - public URL
   - creation/update/revocation timestamps
3. Runtime APIs exist for workers/panels:
   - create subscription
   - list own subscriptions
   - revoke subscription
   - rotate secret
4. Userland cannot create a subscription that targets another source's
   worker/method.

Follow-up:

- TODO: Require shell/server approval to create public ingress for sensitive
  targets.
- TODO: Move webhook verifier secrets behind encrypted secret references if the
  current encrypted workspace database storage is not enough for the deployment
  threat model.

### TODO: Verification and Deployment Cutover

1. TODO: Add end-to-end tests with a local fake OAuth provider and a local fake
   webhook sender.
2. Done: Cloudflare Worker unit tests cover relay signing, raw-body
   preservation, fail-closed signing-secret behavior, and legacy route removal.
3. Done: Server integration tests cover:
   - valid signed relay + valid provider signature
   - invalid relay signature
   - replayed delivery
   - revoked subscription
   - durable subscription persistence
   - secret rotation
   - cross-source target rejection
4. TODO: Add a server integration test for valid relay + invalid provider
   signature.
5. TODO: Update `docs/credential-system.md`, `docs/routes.md`, and the sandbox
   skills once the APIs are stable.

## Open Decisions

- TODO: Decide whether `hooks.snugenv.com` points directly at a Cloudflare
  Worker in all environments or only production.
- TODO: Decide whether local development should require an explicit tunnel or
  use a hosted relay queue.
- TODO: Decide which verifier primitives are required for the first integrations
  beyond HMAC/timestamped HMAC/bearer.
- TODO: Decide whether mobile OAuth continuations need to survive full app
  termination or only foreground/background reconnects during the pending OAuth
  TTL.

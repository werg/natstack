# Credential System — Human Tasks

Everything in `docs/credential-system.md` that can't be done by an
implementing agent. These are the operational / account /
paperwork items that unblock the engineering work.

Rough priority:

- **Immediate** — unblocks Wave 3 engineering (first-party provider
  manifests). Start this week.
- **Long-lead** — takes weeks or months; start now so it's done
  when it's needed.
- **Before Wave 5b** — blocks mobile.
- **Before Wave 8 (v0.1)** — blocks Gmail / Calendar push.
- **Ongoing** — operational hygiene that never ends.

---

## Immediate (unblocks Wave 3)

### 1. Pick the universal-link domain

Blocks: **W0.T7, W5.T3, W5.T7, all OAuth redirect-URI registration**.

- Choose a domain natstack owns.
  - Preferred form: subdomain of the main natstack domain, e.g.
    `links.natstack.io`. Or a dedicated `.app` / `.link` /
    `.dev` domain if there's no main domain yet.
  - It's load-bearing: every provider OAuth client and every iOS
    entitlement + Android manifest will reference it. Changing it
    later means re-configuring each provider's OAuth app.
- Register it, point DNS at Cloudflare (a CNAME is enough once the
  Cloudflare Pages project exists).
- Record the final string in two places:
  - `natstack.yml` → `credentials.mobileCallbackDomain`
  - `apps/mobile/config.json` → `universalLinkDomain`

Estimated time: under a day once the domain is picked.

### 2. Create Cloudflare projects

Blocks: **W0.T8 (well-known), W0.T9 (webhook-relay), W2.T14, W2.T15**.

You need a Cloudflare account with Workers + Pages enabled.

- **Pages project**: bind to `apps/well-known/` in this repo (once
  the directory exists; the agent in Wave 2 creates the content).
  Point the chosen domain (or its subpath) at this project. Verify
  production URL returns HTTP 200 + `application/json` for both
  `.well-known/apple-app-site-association` and
  `.well-known/assetlinks.json`.
- **Workers project** for `apps/webhook-relay/`: empty scaffold is
  fine; agent in Wave 2 fills it in. You need the `wrangler` CLI
  authenticated against the natstack Cloudflare account.

Hand the account-ID, zone-ID, and API token (scoped to Pages +
Workers) to the implementing team so CI can deploy without
opening a dashboard.

Estimated time: half a day.

### 3. Register OAuth apps with each first-party provider

Blocks: **W3.T11–T15** (provider manifests).

One per provider. Each returns a `client_id` (and for some, a
`client_secret` you keep on the server for the natstack-hosted
case). Every one should use the chosen universal-link domain for
its redirect URI.

#### GitHub

- Dashboard: <https://github.com/organizations/<natstack-org>/settings/applications/new>
- App type: **OAuth App** (simpler than GitHub App for user-auth).
- Redirect URIs: `https://<universal-link-domain>/oauth/callback/github`
  and `http://127.0.0.1:*` (GitHub accepts loopback for public
  clients; include explicitly).
- Device flow: enable in the app settings.
- Output: `client_id`. No `client_secret` needed for PKCE + device
  flow public-client use.

#### Microsoft

- Dashboard: <https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade>
- App type: **Multi-tenant**, account types "Accounts in any
  organizational directory and personal Microsoft accounts".
- Platform: **Mobile and desktop applications**.
- Redirect URIs:
  `https://<universal-link-domain>/oauth/callback/microsoft`,
  `http://localhost` (Azure AD accepts loopback with random port).
- Enable device code flow in Authentication → Advanced settings.
- Output: `Application (client) ID`.

#### Slack

- Dashboard: <https://api.slack.com/apps>
- Create from manifest (ship the manifest JSON from this repo in
  Wave 3).
- Distribution: **Public distribution** enabled.
- Socket Mode: enabled (so we don't need a public event-delivery
  endpoint for workspace events — only the install-flow callback).
- Redirect URLs:
  `https://<universal-link-domain>/oauth/callback/slack`.
- Output: `client_id`, `client_secret` (Slack requires confidential
  client; store server-side).

#### Notion

- Dashboard: <https://www.notion.so/profile/integrations>
- Type: **Public integration**.
- Redirect URI:
  `https://<universal-link-domain>/oauth/callback/notion`.
- Output: `client_id`, `client_secret`.
- Also: confirm MCP DCR path works at Notion's MCP endpoint (no
  action, just a check the Wave 3 agent will do).

#### Google (for later, not v0 — see Long-lead)

Don't register until the verification paperwork is ready (§5).
Composio is the v0 bridge.

Estimated time: half a day total across all four providers,
mostly waiting for confirmation emails.

### 4. Create a Composio tenant

Blocks: **W3.T15** (Google manifest via Composio bridge).

- Sign up at <https://composio.dev> for a tenant.
- Pick a plan: free tier covers v0 development; paid tiers if we
  hit scale before natstack's own Google verification completes.
- Enable the Google connector in the Composio dashboard; note
  which scopes they expose.
- Generate an API key for natstack. Store in `natstack.yml` under
  `credentials.providers.google.composio.apiKey` (or env var per
  the secrets story the Wave 1 agent implements).

Estimated time: under an hour.

### 5. Document operational access

Blocks: nothing immediately, but prevents lockout later.

Write `docs/oauth-client-ops.md` capturing:

- Which humans can log into each provider's OAuth dashboard
  (GitHub, Microsoft, Slack, Notion, Composio, Cloudflare, the
  chosen domain registrar, and eventually Google).
- How to rotate `client_secret`s per provider.
- What to do if a provider suspends / flags the natstack app
  (Google does this; Slack occasionally does).
- Where each `client_id` and `client_secret` is stored.

Estimated time: an hour once the credentials exist. Make this a
living document; re-read it before any rotation.

---

## Long-lead (start now, completes weeks+ later)

### 6. Google OAuth verification

Blocks: **eventually replaces the Composio bridge** for Google.
Does not block v0 launch (Composio bridge ships v0).

This is the longest track in the whole plan. Start now; expect
6–12 weeks minimum, longer if restricted scopes are involved.

Prerequisites before Google even accepts a verification request:

- [ ] **Legal entity exists.** Google requires an identifiable
      org, ideally with a public website, for OAuth app ownership.
      If natstack doesn't have a legal entity yet, that's a
      blocker to start — not a blocker to continue planning.
- [ ] **Public homepage** at a natstack-owned domain, showing
      the natstack brand, product description, and contact info.
- [ ] **Privacy policy** live on the homepage domain, specifically
      describing what data you handle and how. Generic privacy
      generators are not enough — Google reviewers check it.
- [ ] **Terms of service** live on the homepage.
- [ ] **Trust / security documentation** describing how user data
      (Gmail messages, Drive files, Calendar events) is handled,
      encrypted, retained, deleted.
- [ ] **YouTube demo video** showing the OAuth consent flow in the
      context of the actual app (Google requires this literally).
- [ ] **Domain verification** in Google Search Console for every
      domain used in the OAuth consent screen, privacy URL, TOS
      URL, redirect URIs.

Process:

- Create the Google Cloud project that will own the OAuth client.
- Configure the OAuth consent screen with branding, scopes,
  authorized domains.
- Submit for verification (for sensitive scopes —
  gmail.modify / drive.readonly / calendar.events).
- **If you need restricted scopes** (gmail.readonly, drive.file,
  etc.): an independent **CASA security assessment** is required,
  costs **$15,000–$75,000 per year**, typically renewed annually.
  Decide before submitting whether restricted scopes are
  worth that.
- Respond to reviewer feedback. Expect 2–3 rounds.

Interim (during verification): up to 100 test users can use the
app if added to the test-users list. Everyone else sees an
"unverified app" warning. Composio bridge avoids this entirely
for v0.

Action this week: pick an owner for the verification track and
give them this checklist.

### 7. Apple Developer + Google Play accounts

Blocks: **W5.T7** (iOS entitlements + Android manifest).

If natstack doesn't have these yet:

- **Apple Developer Program**: $99/year, <https://developer.apple.com/programs/>.
  Needed for a Team ID + app signing. Individual or Organization;
  Organization requires D-U-N-S number (free but 1–2 weeks to
  issue). Start now if mobile is on the roadmap.
- **Google Play Console**: $25 one-time, <https://play.google.com/console/>.
  Needed for package name registration and app signing.

Not urgent for Wave 5b planning, but lead times are real.

---

## Before Wave 5b (mobile OAuth)

### 8. Mobile identifiers + signing certs

Blocks: **W0.T7 well-known file content, W5.T7 entitlements**.

Produce and share with the implementing team:

- **iOS**:
  - Apple Developer Team ID (e.g. `ABCD1234`).
  - Bundle ID (e.g. `com.natstack.app`).
- **Android**:
  - Package name (e.g. `com.natstack.app`).
  - SHA-256 fingerprint of the **production** release signing cert.
  - SHA-256 fingerprint of the **debug** keystore (optional, makes
    dev builds work with universal links).

Goes into `apps/well-known/config.json`. The `build.ts` there
templates them into the JSON files Cloudflare Pages serves.

### 9. Add universal-link domain to each provider's OAuth config

Blocks: **W5.T5, W5.T6**.

Once the domain is registered and Cloudflare Pages is serving the
well-known files, go back to each provider's OAuth dashboard (§3)
and add:

- `https://<universal-link-domain>/oauth/callback/<provider>`
  as an allowed redirect URI if not already there.

This can be done concurrently with §3 if the domain is already
known, or as a follow-up.

---

## Before Wave 8 (v0.1 Gmail / Calendar push)

### 10. GCP project + Pub/Sub for Gmail push

Blocks: **W8.T0, W8.T1, W8.T3**.

Only needed once v0 is shipping and Gmail push work starts.

- Create a GCP project (can be the same one as the OAuth
  verification project, or separate).
- Enable the Pub/Sub API.
- Create a **single shared Pub/Sub topic** (name:
  `natstack-gmail-push` or similar).
- Create a **push subscription** on that topic. Delivery endpoint:
  `https://<relay-domain>/pubsub/gmail` (the Cloudflare Worker
  relay from Wave 2).
- Grant `gmail-api-push@system.gserviceaccount.com` the
  `roles/pubsub.publisher` role on the topic.
- Grant the push-subscription's service account publish permission
  (same grant).
- Same again for Calendar if the Calendar push wave ships in v0.1
  (`calendar-api-push@system.gserviceaccount.com` — verify
  current address in Google docs before granting).

Hand the topic name + subscription name + service-account email to
the implementing team. Budget: Pub/Sub free tier (10 GB/mo) covers
anything short of enormous scale; this is a negligible line item.

Estimated time: half a day.

---

## Ongoing operational

### 11. Monitor the well-known domain + webhook relay

Blocks: nothing, but failures are silent and user-visible.

- **Uptime check** on
  `GET https://<universal-link-domain>/.well-known/apple-app-site-association`
  expecting 200 + `application/json`. Any monitor works
  (UptimeRobot, Cloudflare Health Checks, Pingdom).
- **Uptime check** on the webhook relay's health endpoint. If the
  relay goes down, new webhooks are dropped (at-most-once
  delivery).
- **Alert on Pub/Sub quota approaching** once v0.1 ships. 10 GB/mo
  free tier; natstack Gmail push volume at 1M users sending
  100 notifications/day each is ~600 MB/mo — well under — but
  worth watching at scale.

### 12. OAuth client hygiene

- **Rotate `client_secret`s** for Slack and Notion every 12 months
  (no strict requirement, just hygiene). Document the rotation in
  `docs/oauth-client-ops.md`.
- **Recertify** Google verification annually (required by Google).
- **Watch for provider deprecations** — Slack's OAuth v2 vs v2.1,
  GitHub's OAuth App vs GitHub App, Google API version bumps.
  Subscribe to each provider's developer changelog.

### 13. Access review every 6 months

- Confirm who has dashboard access to each provider.
- Revoke access for people no longer working on natstack.
- Confirm each OAuth dashboard has at least 2 humans who can log
  in (avoid bus-factor-1 on critical infrastructure).

---

## Artifacts to hand to the implementing team

Consolidated list. Once you have these, agents are unblocked:

| Artifact | Source task | Consumed by |
|---|---|---|
| `universalLinkDomain` string | §1 | W0.T7, W5.T7, all §3 redirect URIs |
| Cloudflare account-ID + Pages/Workers API token | §2 | W0.T8, W0.T9, W2.T14, W2.T15 |
| GitHub `client_id` | §3 GitHub | W3.T11 |
| Microsoft `client_id` | §3 Microsoft | W3.T12 |
| Slack `client_id` + `client_secret` | §3 Slack | W3.T13 |
| Notion `client_id` + `client_secret` | §3 Notion | W3.T14 |
| Composio API key | §4 | W3.T15 |
| `docs/oauth-client-ops.md` | §5 | everyone |
| iOS Team ID + bundle ID | §8 | W5.T7, `apps/well-known/config.json` |
| Android package name + cert SHA-256s | §8 | W5.T7, `apps/well-known/config.json` |
| Google `client_id` + verification status | §6 | Eventual swap-out of Composio bridge |
| GCP project ID + Pub/Sub topic name + subscription name | §10 | W8.T0, W8.T1 |

Put the non-secret strings (domain, client IDs, project IDs) in
`natstack.yml`. Put secrets (`client_secret`s, Composio API key,
GCP service account JSONs) in the deployment's secrets manager —
**never** in the repo. Env-var injection via the deployment
pipeline, loaded once at server start.

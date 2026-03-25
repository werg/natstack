# Email Panel — Design & Gap Analysis

## Overview

This panel is an example app that tests NatStack's panel system against a
real-world use case: integrating with Gmail and Google Calendar APIs. It
deliberately pushes against the current system boundaries to identify what
runtime services need to be added.

## Architecture

```
panels/email/
├── package.json      # Panel manifest
├── contract.ts       # RPC contract (agents/parent panels can search mail, compose, etc.)
├── oauth.ts          # Token provider abstraction (Nango vs cookie-based)
├── gmail.ts          # Gmail & Calendar REST API clients
├── index.tsx         # UI — inbox, thread view, compose, calendar
└── DESIGN.md         # This file
```

### Key design decision: OAuth abstraction layer

The panel doesn't embed any specific auth strategy. Instead, `oauth.ts` defines
an `OAuthTokenProvider` interface:

```ts
interface OAuthTokenProvider {
  getToken(): Promise<OAuthToken>;
  getConnection(): Promise<OAuthConnection>;
  connect(): Promise<OAuthConnection>;
  disconnect(): Promise<void>;
}
```

Two strategies implement this:
- **`createNangoProvider()`** — delegates to a (not-yet-built) `oauth` runtime service
- **`createCookieProvider()`** — attempts to use imported browser cookies

This means the Gmail/Calendar API layer (`gmail.ts`) is auth-agnostic — it just
calls `tokenProvider.getToken()` and adds the Bearer header.

## What works today

- **Panel structure** — standard panel, auto-mounts, themes, state args all work
- **RPC contract** — parent panels and agents can call `search()`, `compose()`,
  `getThread()`, `getCalendarEvents()` on the email panel
- **UI** — full inbox/thread/compose/calendar UI using Radix
- **Database** — connection persistence via `db.open("email-panel")`
- **Cookie detection** — can check if Google cookies exist via `browser-data` service

## What's missing (gaps identified)

### 1. OAuth Runtime Service (critical)

**The biggest gap.** Panels currently have no way to obtain OAuth access tokens
for third-party APIs. This is the single most important addition needed.

Recommended API surface:

```ts
// New addition to @workspace/runtime
import { oauth } from "@workspace/runtime";

// List configured integrations
const integrations = await oauth.listIntegrations();

// Get a valid access token (auto-refreshes)
const token = await oauth.getToken("google-mail");

// Initiate OAuth flow (opens browser panel with auth URL)
const connection = await oauth.connect("google-mail");

// Check connection status
const status = await oauth.getConnectionStatus("google-mail");

// Disconnect
await oauth.disconnect("google-mail");
```

**Server-side implementation options:**

| Approach | Pros | Cons |
|----------|------|------|
| **Nango** | Handles 250+ providers, token refresh, re-auth | External dependency |
| **Built-in OAuth** | No external deps, full control | Must implement refresh logic per provider |
| **Hybrid** | Nango for production, built-in for dev/testing | More code paths |

**Recommendation: Nango-first with a pluggable backend.** The server-side
`oauth` service should:
1. Accept a Nango server URL + secret key in `natstack.yml`
2. Proxy token requests through the Nango API
3. Cache tokens server-side with automatic refresh
4. Support a `connect()` flow that opens the Nango auth URL in a browser panel
5. Store connection metadata per context

### 2. OAuth Permissions — RESOLVED

OAuth consent is fully dynamic per-panel ID. When a panel calls
`oauth.requestConsent()`, a consent notification appears in the shell chrome.
The user approves/denies per panel, with an "Always Allow" option for
workspace-wide approval. No static manifest declarations needed.

### 3. Fetch from Panel Context — RESOLVED

CORS is stripped for app panels (defaultSession). Panels can call external APIs
directly via `fetch()`. Browser panels (persist:browser partition) retain
normal CORS behavior.

### 4. Background Sync / Push Notifications (nice-to-have)

For a real email client, you'd want:
- Background polling or push notifications for new mail
- This could be a worker (like `workers/hello`) that polls and publishes
  to a PubSub channel
- The panel subscribes to the channel for real-time updates

This actually fits NatStack's existing worker + PubSub architecture well.

## How an agent would use this panel

```ts
// From an agentic chat, the AI could:

// 1. Open the email panel
await openPanel("panels/email", {
  stateArgs: { provider: "google-mail" }
});

// 2. Search for messages (via RPC contract)
const results = await emailPanel.call.search("from:alice subject:meeting");

// 3. Read a thread
const thread = await emailPanel.call.getThread(results[0].threadId);

// 4. Compose a reply
await emailPanel.call.compose({
  to: "alice@example.com",
  subject: "Re: Meeting",
  body: "Sounds good, see you then!"
});

// 5. Check calendar
const events = await emailPanel.call.getCalendarEvents();
```

## Implementation Priority

1. **OAuth service** — unblocks all API-based panels, not just email
2. **Permissions for OAuth** — security boundary for untrusted panels
3. **HTTP proxy service** — enables browser-mode panels to call external APIs
4. **Background worker pattern** — document the worker + PubSub polling pattern

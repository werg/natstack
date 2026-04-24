# API Integrations

## Overview

natstack integrations use a **credential system** that handles OAuth flows, token refresh, and capability-based security. Integrations are plain TypeScript modules that call APIs with `fetch()` — the egress proxy injects credentials automatically.

## Writing an Integration

### 1. Declare a Manifest

Every integration exports a `manifest` constant:

```typescript
export const manifest = {
  providers: ["github"],
  scopes: {
    github: ["repo", "read_user"],
  },
  endpoints: {
    github: [
      { url: "https://api.github.com/user", methods: ["GET"] },
      { url: "https://api.github.com/repos/*", methods: ["GET"] },
      { url: "https://api.github.com/repos/*/issues", methods: ["GET", "POST"] },
    ],
  },
  webhooks: {
    github: [
      { event: "issues", deliver: "onIssue" },
    ],
  },
};
```

- **`providers`** — which providers the integration needs. Use `{ id: "github", role: "source" }` for multi-account scenarios.
- **`scopes`** — OAuth scopes per provider.
- **`endpoints`** — API URLs the integration will call. `*` matches one path segment, `**` matches any depth.
- **`webhooks`** — webhook events to subscribe to, with the handler function name.

### 2. Request Consent

```typescript
import { connect } from "@workspace/runtime/worker/credentials";

const github = await connect("github");
```

This triggers a consent dialog. The returned `CredentialHandle` provides:
- `connectionId` — identifies this connection
- `providerId` — the provider backing this handle
- `fetch()` — authenticated fetch that stamps the connection header

### 3. Call APIs

```typescript
// Simple: plain fetch() works when you have one connection per provider
const res = await fetch("https://api.github.com/user");

// Explicit: use the handle's fetch for multi-connection scenarios
const res = await github.fetch("https://api.github.com/user");
```

The egress proxy handles:
- Bearer token injection
- Token refresh
- Rate limiting
- Retry with backoff
- Capability enforcement

### 4. Handle Webhooks

Export named handler functions matching your manifest's `deliver` values:

```typescript
export function onIssue(event: WebhookEvent) {
  console.log("Issue event:", event.action, event.issue.title);
}
```

At worker startup, expose and subscribe those handlers in one step:

```typescript
import { createWorkerRuntime, handleWorkerRpc, registerManifestWebhooks } from "@workspace/runtime/worker";
import * as github from "@workspace/integrations/github";

const runtime = createWorkerRuntime(env);
await registerManifestWebhooks(runtime, { github });
```

### Multi-Role Example

For integrations that need multiple accounts of the same provider:

```typescript
export const manifest = {
  providers: [
    { id: "github", role: "source" },
    { id: "github", role: "target" },
  ],
  // ...
};

const source = await connect("github", { connectionId: "source" });
const target = await connect("github", { connectionId: "target" });

// Each handle authenticates as a different GitHub account
const issues = await source.fetch("https://api.github.com/repos/org/repo/issues");
await target.fetch("https://api.github.com/repos/other/repo/issues", {
  method: "POST",
  body: JSON.stringify({ title: "Mirrored issue" }),
});
```

## Available Providers

| Provider | Flows | Notes |
|----------|-------|-------|
| GitHub | Device code, loopback PKCE, PAT, `gh` CLI | Device code is primary |
| Google | Composio bridge (v0), loopback PKCE, service account | Composio bridge until verification completes |
| Microsoft | Device code, loopback PKCE, `az` CLI | Multi-tenant app |
| Slack | Loopback PKCE, bot token | No device flow available |
| Notion | MCP+DCR, PAT | Zero registration via DCR |

## Reference

- Full system design: `docs/credential-system.md`
- Provider manifests: `packages/shared/src/credentials/providers/`
- Flow runners: `packages/shared/src/credentials/flows/`
- Test utilities: `packages/shared/src/credentials/test-utils/`

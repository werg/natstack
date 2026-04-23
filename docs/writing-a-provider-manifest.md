# Writing a Provider Manifest

How to add a new OAuth provider to natstack's credential system.

## Quick Start

A provider manifest is a plain TypeScript object that describes how to authenticate with an external API. Create a file in `packages/shared/src/credentials/providers/` and register it in the index.

```typescript
import type { ProviderManifest } from "../types.js";

export const acme: ProviderManifest = {
  id: "acme",
  displayName: "Acme",
  apiBase: ["https://api.acme.com"],
  flows: [
    {
      type: "loopback-pkce",
      clientId: "YOUR_OAUTH_CLIENT_ID",
      authorizeUrl: "https://acme.com/oauth/authorize",
      tokenUrl: "https://api.acme.com/oauth/token",
    },
    {
      type: "pat",
      probeUrl: "https://api.acme.com/v1/me",
    },
  ],
  scopes: {
    read: "Read access",
    write: "Write access",
  },
};
```

Then add it to `packages/shared/src/credentials/providers/index.ts`:

```typescript
export { acme } from "./acme.js";
// and add to the builtinProviders array
```

## Manifest Fields

### Required

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique provider identifier. Used as the directory name in the credential store. |
| `displayName` | `string` | Human-readable name shown in consent dialogs. |
| `apiBase` | `string[]` | Base URLs for the provider's API. The egress proxy uses these for capability matching and auth injection. |
| `flows` | `FlowConfig[]` | Ordered list of authentication flows to try. The resolver tries each in order until one succeeds. |

### Optional

| Field | Type | Description |
|-------|------|-------------|
| `clientId` | `string` | Default OAuth client ID (flows can override). |
| `scopes` | `Record<string, string>` | Map of scope keys to their OAuth scope strings. |
| `scopeDescriptions` | `Record<string, string>` | Human-readable descriptions for consent UI. |
| `whoami` | `object` | Endpoint + JSON paths for identifying the authenticated user. |
| `rateLimits` | `RateLimitConfig` | Per-provider rate limiting configuration. |
| `retry` | `RetryConfig` | Retry policy for transient failures. |
| `refreshBufferSeconds` | `number` | How far before expiry to trigger a proactive refresh. |
| `webhooks` | `object` | Webhook subscription configuration (for push delivery). |

## Authentication Flows

Flows are tried in order. Put the most seamless flow first and fallbacks after.

### `loopback-pkce`

OAuth 2.0 Authorization Code with PKCE. Opens a browser, listens on `127.0.0.1` for the callback. Best for desktop/interactive use.

```typescript
{
  type: "loopback-pkce",
  clientId: "...",
  authorizeUrl: "https://provider.com/oauth/authorize",
  tokenUrl: "https://provider.com/oauth/token",
}
```

### `device-code`

OAuth 2.0 Device Authorization Grant (RFC 8628). Shows a URL and code for the user to enter in a browser. Works when the agent can't open a browser.

```typescript
{
  type: "device-code",
  clientId: "...",
  deviceAuthUrl: "https://provider.com/login/device/code",
  tokenUrl: "https://provider.com/login/oauth/access_token",
}
```

### `pat`

Prompts the user to paste a Personal Access Token. Optional `probeUrl` verifies the token works.

```typescript
{
  type: "pat",
  probeUrl: "https://api.provider.com/v1/me",
}
```

### `cli-piggyback`

Reuses a token from an existing CLI tool (e.g., `gh`, `gcloud`, `az`).

```typescript
{
  type: "cli-piggyback",
  command: "gh auth token",
}
```

For JSON output, use `jsonPath`:

```typescript
{
  type: "cli-piggyback",
  command: "gcloud auth print-access-token --format=json",
  jsonPath: "access_token",
}
```

### `composio-bridge`

Delegates to [Composio](https://composio.dev/) for OAuth. Requires `composio-core` to be installed and `COMPOSIO_API_KEY` set.

```typescript
{
  type: "composio-bridge",
}
```

### `service-account`

For non-interactive/CI environments. Google service accounts with JWT signing, or generic token files.

```typescript
{
  type: "service-account",
}
```

### `bot-token`

Prompts for a bot token (Slack, Discord, Telegram). Optional `probeUrl` for verification.

```typescript
{
  type: "bot-token",
  probeUrl: "https://slack.com/api/auth.test",
}
```

### `github-app-installation`

GitHub App installation token via JWT + REST API.

```typescript
{
  type: "github-app-installation",
}
```

### `mcp-dcr`

MCP Dynamic Client Registration. No pre-registered OAuth app needed.

```typescript
{
  type: "mcp-dcr",
  resource: "https://mcp-server.example.com",
}
```

## Identity Discovery (`whoami`)

The `whoami` field tells natstack how to identify the authenticated user after a flow completes.

```typescript
whoami: {
  url: "https://api.provider.com/v1/me",
  identityPath: {
    providerUserId: "id",       // required: unique user ID
    email: "email",              // optional
    username: "login",           // optional
  },
}
```

The `identityPath` values are dot-separated JSON paths into the response body.

## Rate Limiting

```typescript
rateLimits: {
  requestsPerSecond: 10,  // sustained rate
  burstSize: 20,          // token bucket burst
  strategy: "delay",      // "delay" (queue) or "fail-fast" (429 immediately)
}
```

## Writing an Integration

After creating a provider manifest, write an integration module in `workspace/packages/integrations/src/`. An integration declares which providers, scopes, and endpoints it needs:

```typescript
export const manifest = {
  providers: ["acme"],
  scopes: {
    acme: ["read", "write"],
  },
  endpoints: {
    acme: [
      { url: "https://api.acme.com/v1/items", methods: ["GET", "POST"] },
      { url: "https://api.acme.com/v1/items/*", methods: ["GET", "PATCH", "DELETE"] },
    ],
  },
} as const;
```

Integration functions use plain `fetch()`. The egress proxy intercepts requests to `apiBase` URLs and injects the stored credential:

```typescript
export async function listItems(): Promise<Item[]> {
  const response = await fetch("https://api.acme.com/v1/items");
  if (!response.ok) throw new Error(`Acme API: ${response.status}`);
  const data = await response.json();
  return data.items;
}
```

## Multi-Role Integrations

Some integrations need multiple accounts from the same or different providers:

```typescript
export const manifest = {
  providers: [
    { id: "github", role: "source" },
    { id: "github", role: "target" },
  ],
  scopes: {
    github: ["repo"],
  },
  // ...
} as const;
```

See `workspace/packages/integrations/src/github-issue-mirror.ts` for a complete example.

## Testing

Use the test utilities in `packages/shared/src/credentials/test-utils/`:

- `MockOAuthServer` — fake OAuth authorization + token server
- `MockProvider` — fake API server with fixture responses
- `FixtureRecorder` — VCR-style HTTP recording/replay
- `MockWebhookRelay` — in-process webhook event injection

Example:

```typescript
import { MockOAuthServer, MockProvider } from "../test-utils/index.js";

const oauthServer = await MockOAuthServer.start({
  accessToken: "test-token",
  refreshToken: "test-refresh",
});

const provider = await MockProvider.start({
  fixtures: {
    "/v1/me": { status: 200, body: { id: "user-1" } },
  },
});

// ... run your test ...

await provider.stop();
await oauthServer.stop();
```

## Checklist

- [ ] Manifest has a unique `id`
- [ ] At least one flow is configured
- [ ] `apiBase` covers all URLs the integration will call
- [ ] `scopes` includes all OAuth scopes needed
- [ ] `whoami` is set (required for multi-account support)
- [ ] Added to `providers/index.ts` and `builtinProviders`
- [ ] Smoke test passes: `npx tsx packages/shared/src/credentials/smoke-test.ts`

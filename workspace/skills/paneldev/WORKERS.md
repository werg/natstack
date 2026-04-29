# Runtime Credential API

Credentials are URL-bound and may only be used through host-mediated egress.

## Worker Runtime Surface

<!-- BEGIN GENERATED: worker-runtime-surface -->
Generated from `runtimeSurface.worker.ts`. Use `await help()` at runtime for the live surface.

| Export | Kind | Members | Description |
|--------|------|---------|-------------|
| `id` | value |  |  |
| `rpc` | value |  |  |
| `db` | value |  |  |
| `fs` | value |  |  |
| `workers` | namespace | `create`, `destroy`, `update`, `list`, `status`, `listInstanceSources`, `getPort`, `restartAll`, `cloneDO`, `destroyDO` |  |
| `workspace` | namespace | `list`, `getActive`, `getActiveEntry`, `getConfig`, `create`, `setInitPanels`, `switchTo` |  |
| `credentials` | namespace | `store`, `beginCreateWithOAuthPkce`, `completeCreateWithOAuthPkce`, `listStoredCredentials`, `revokeCredential`, `grantCredential`, `resolveCredential`, `fetch`, `hookForUrl` |  |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
| `contextId` | value |  |  |
| `gitConfig` | value |  |  |
| `pubsubConfig` | value |  |  |
| `callMain` | value |  |  |
| `getWorkspaceTree` | value |  |  |
| `listBranches` | value |  |  |
| `listCommits` | value |  |  |
| `exposeMethod` | value |  |  |
| `getParent` | value |  |  |
| `handleRpcPost` | value |  |  |
| `destroy` | value |  |  |
<!-- END GENERATED: worker-runtime-surface -->

## Store

```ts
const stored = await credentials.store({
  label: "Example API",
  audience: [{ url: "https://api.example.com/", match: "origin" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  material: { type: "bearer-token", token },
});
```

## OAuth PKCE Without Returning Tokens

```ts
const begin = await credentials.beginCreateWithOAuthPkce({
  oauth: {
    authorizeUrl: "https://auth.example.com/oauth/authorize",
    tokenUrl: "https://auth.example.com/oauth/token",
    clientId: "public-client-id",
    scopes: ["read"],
  },
  credential: {
    label: "Example API",
    audience: [{ url: "https://api.example.com/", match: "origin" }],
    injection: {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
  },
  redirectUri,
});

const stored = await credentials.completeCreateWithOAuthPkce({
  nonce: begin.nonce,
  code,
  state,
});
```

## Use

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});
```

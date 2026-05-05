# Runtime Credential API

Credentials are URL-bound and may only be used through host-mediated egress.

## Panel Runtime Surface

<!-- BEGIN GENERATED: panel-runtime-surface -->
Generated from `runtimeSurface.panel.ts`. Use `await help()` at runtime for the live surface.

| Export | Kind | Members | Description |
|--------|------|---------|-------------|
| `Rpc` | value |  | RPC helpers namespace export. |
| `z` | value |  | Zod export. |
| `defineContract` | value |  |  |
| `noopParent` | value |  |  |
| `buildPanelLink` | value |  |  |
| `parseContextId` | value |  |  |
| `isValidContextId` | value |  |  |
| `getInstanceId` | value |  |  |
| `id` | value |  |  |
| `rpc` | value |  |  |
| `db` | value |  |  |
| `parent` | value |  |  |
| `getParent` | value |  |  |
| `getParentWithContract` | value |  |  |
| `onConnectionError` | value |  |  |
| `getInfo` | value |  |  |
| `closeSelf` | value |  |  |
| `focusPanel` | value |  |  |
| `getWorkspaceTree` | value |  |  |
| `listBranches` | value |  |  |
| `listCommits` | value |  |  |
| `getTheme` | value |  |  |
| `onThemeChange` | value |  |  |
| `onFocus` | value |  |  |
| `exposeMethod` | value |  |  |
| `contextId` | value |  |  |
| `parentId` | value |  |  |
| `fs` | value |  |  |
| `gitConfig` | value |  |  |
| `pubsubConfig` | value |  |  |
| `env` | value |  |  |
| `workers` | namespace | `create`, `destroy`, `update`, `list`, `status`, `listInstanceSources`, `getPort`, `restartAll`, `cloneDO`, `destroyDO` |  |
| `normalizePath` | value |  |  |
| `getFileName` | value |  |  |
| `resolvePath` | value |  |  |
| `getStateArgs` | value |  |  |
| `useStateArgs` | value |  |  |
| `setStateArgs` | value |  |  |
| `createBrowserPanel` | value |  |  |
| `openExternal` | value |  |  |
| `onChildCreated` | value |  |  |
| `getBrowserHandle` | value |  |  |
| `openPanel` | value |  |  |
| `adblock` | namespace | `getStats`, `isActive`, `getStatsForPanel`, `isEnabledForPanel`, `setEnabledForPanel`, `resetStatsForPanel`, `getPanelUrl`, `addToWhitelist`, `removeFromWhitelist` |  |
| `workspace` | namespace | `list`, `getActive`, `getActiveEntry`, `getConfig`, `create`, `setInitPanels`, `switchTo`, `openPanel` |  |
| `credentials` | namespace | `store`, `connectOAuth`, `configureOAuthClient`, `requestCredentialInput`, `getOAuthClientConfigStatus`, `deleteOAuthClientConfig`, `listStoredCredentials`, `revokeCredential`, `grantCredential`, `resolveCredential`, `fetch`, `hookForUrl`, `gitHttp` |  |
| `git` | namespace | `http`, `importProject`, `completeWorkspaceDependencies`, `setSharedRemote`, `removeSharedRemote`, `client` |  |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
<!-- END GENERATED: panel-runtime-surface -->

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

## OAuth Without Returning Tokens

Use `credentials.connectOAuth()` for OAuth. The host owns the redirect,
browser handoff, callback validation, token exchange, encrypted storage, and
initial use grant. If the provider has client secrets or other setup material,
collect it with `credentials.configureOAuthClient()` and pass `clientConfigId`
to `connectOAuth`.

```ts
const stored = await credentials.connectOAuth({
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
  browser: "external", // or "internal" for an app browser panel
});
```

## Use

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});
```

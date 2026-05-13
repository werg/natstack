# Runtime API

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
| `createGatewayFetch` | value |  | Create a gateway-authenticated fetch helper from an explicit config. |
| `gatewayConfig` | value |  | Gateway base URL and bearer token for NatStack service routes. |
| `gatewayFetch` | value |  | Fetch helper that prefixes gateway-relative paths and adds Authorization: Bearer. |
| `gitConfig` | value |  | Git HTTP endpoint and token derived from the gateway config. |
| `pubsubConfig` | value |  | PubSub WebSocket endpoint and token derived from the gateway config. |
| `env` | value |  |  |
| `workers` | namespace | `create`, `destroy`, `update`, `list`, `status`, `listInstanceSources`, `listServices`, `resolveService`, `getPort`, `restartAll`, `cloneDO`, `destroyDO` |  |
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
| `credentials` | namespace | `store`, `connect`, `configureClient`, `requestCredentialInput`, `getClientConfigStatus`, `deleteClientConfig`, `listStoredCredentials`, `revokeCredential`, `grantCredential`, `resolveCredential`, `fetch`, `hookForUrl`, `gitHttp` |  |
| `git` | namespace | `http`, `importProject`, `completeWorkspaceDependencies`, `setSharedRemote`, `removeSharedRemote`, `client` |  |
| `gad` | namespace | `rawSql`, `query`, `status`, `ensureBlob`, `ensureGadBranch`, `getGadBranchHead`, `appendGadHistoryBatch`, `materializePiMessages`, `listGadBranchTrajectory`, `listGadBranchHistory`, `listGadBranchToolCalls`, `forkGadBranch`, `listGadBranches`, `listGadBranchFiles`, `diffGadStates`, `readGadFileAtState`, `getGadToolProvenance`, `getGadStateProducer`, `blameGadFileSnippet`, `enqueueGadIndexJob`, `processGadIndexJobs`, `rebuildGadReadModels`, `validateGadHashes`, `clearDirtyAfterValidation`, `revokeRawSqlWriteApproval` |  |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` |  |
| `requestApproval` | value |  |  |
| `revokeApproval` | value |  |  |
| `listApprovals` | value |  |  |
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

Use `credentials.connect()` for OAuth. The host owns the redirect,
browser handoff, callback validation, token exchange, encrypted storage, and
initial use grant. If the provider has client secrets or other setup material,
collect it with `credentials.configureClient()` and pass `clientConfigId`
to `connect`.

```ts
const stored = await credentials.connect({
  flow: {
    type: "oauth2-auth-code-pkce",
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

## Userland Approval Prompts

Use `requestApproval()` when panel code needs a human decision for a
provider-defined action that NatStack does not understand as a built-in
credential or capability grant. The shell verifies the issuer identity
(`callerId`/`callerKind`) and shows the user a trusted consent prompt.

```ts
import { requestApproval, revokeApproval, listApprovals } from "@workspace/runtime";

const result = await requestApproval({
  subject: {
    id: "team-x:calendar-write",
    label: "Team X calendar write access",
  },
  title: "Allow calendar writes?",
  summary: "Team X wants this worker to create events on its behalf.",
  warning: "Only allow this for teams you administer.",
  details: [
    { label: "Team", value: "Team X" },
    { label: "Operation", value: "Create calendar events" },
  ],
  options: [
    { value: "allow", label: "Allow", tone: "primary" },
    { value: "deny", label: "Deny", tone: "danger" },
  ],
});

if (result.kind === "choice" && result.choice === "allow") {
  // Continue with the gated action.
}
```

Decision caching is server-managed. Every non-dismiss choice is remembered for
the verified issuer and `subject.id`; the next identical request resolves
immediately with the stored choice and no prompt. Dismissal is not remembered.

```ts
const grants = await listApprovals();
await revokeApproval("team-x:calendar-write");
```

Use stable, provider-owned `subject.id` values such as
`team-x:calendar-write`. IDs must be 1-128 chars, use only
letters/numbers/`._:/-`, and cannot start with `shell:`, `server:`,
`system:`, or `@`. Option values must be unique, 1-40 chars, and use only
letters/numbers/`_-`; `dismiss` is reserved.

Do not use `requestApproval()` for host capabilities that already have a
NatStack permission flow: use `openExternal()`, `credentials.*`, `git.*`, or
other runtime APIs so the host can apply the right trust scope and audit model.

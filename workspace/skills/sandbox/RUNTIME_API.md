# Runtime API

Credentials are URL-bound and may only be used through host-mediated egress.

## Panel Runtime Surface

Panel identity has two layers: `slotId` is the stable visible panel slot and is
the correct identity for panel-tree operations and PubSub/channel clients;
`id`/`entityId`/`rpc.selfId` identify the current live runtime entity and can
change when the panel navigates or reopens.

<!-- BEGIN GENERATED: panel-runtime-surface -->
Generated from `runtimeSurface.panel.ts`. Use `await help()` at runtime for the live surface.

| Export | Kind | Members | Description |
|--------|------|---------|-------------|
| `Rpc` | value |  | RPC helpers namespace export. |
| `z` | value |  | Zod export. |
| `defineContract` | value |  |  |
| `buildPanelLink` | value |  |  |
| `parseContextId` | value |  |  |
| `isValidContextId` | value |  |  |
| `getInstanceId` | value |  |  |
| `id` | value |  |  |
| `entityId` | value |  | Panel entity id (panel:<historyEntryKey>) - same as `id`. |
| `slotId` | value |  | Stable panel slot id for panel tree operations and panel channel/client identity. |
| `rpc` | value |  |  |
| `parent` | value |  |  |
| `getParent` | value |  |  |
| `getParentWithContract` | value |  |  |
| `onConnectionError` | value |  |  |
| `getInfo` | value |  |  |
| `focusPanel` | value |  |  |
| `getTheme` | value |  |  |
| `onThemeChange` | value |  |  |
| `onFocus` | value |  |  |
| `expose` | value |  |  |
| `contextId` | value |  |  |
| `recoveryCoordinator` | value |  | Panel transport recovery phase coordinator. |
| `parentId` | value |  |  |
| `fs` | value |  |  |
| `createGatewayFetch` | value |  | Create a gateway-authenticated fetch helper from an explicit config. |
| `gatewayConfig` | value |  | Gateway base URL and bearer token for NatStack service routes. |
| `gatewayFetch` | value |  | Fetch helper that prefixes gateway-relative paths and adds Authorization: Bearer. |
| `env` | value |  |  |
| `doTargetId` | value |  | Build a unified RPC target ID for a Durable Object reference. |
| `createDurableObjectServiceClient` | value |  | Resolve a Durable Object-backed service and call it through unified RPC. |
| `workers` | namespace | `create`, `destroy`, `update`, `list`, `status`, `listInstanceSources`, `listServices`, `resolveService`, `resolveDurableObject`, `durableObjectService`, `getPort`, `restartAll`, `cloneDO`, `destroyDO` |  |
| `normalizePath` | value |  |  |
| `getFileName` | value |  |  |
| `resolvePath` | value |  |  |
| `getStateArgs` | value |  |  |
| `useStateArgs` | value |  |  |
| `setStateArgs` | value |  |  |
| `setStateArgsForPanel` | value |  |  |
| `reopen` | value |  | Replace the current panel slot with a source/context/stateArgs using panelTree.navigate. |
| `openExternal` | value |  |  |
| `onChildCreated` | value |  |  |
| `openPanel` | value |  |  |
| `listPanels` | value |  |  |
| `getPanelHandle` | value |  |  |
| `panelTree` | namespace | `self`, `get`, `list`, `roots`, `children`, `parent`, `navigate`, `open` | Top-level export, not workspace.panelTree. Signatures: self(): PanelHandle; get(id): PanelHandle; list(): Promise<PanelHandle[]>; roots(): Promise<PanelHandle[]>; children(id): Promise<PanelHandle[]>; parent(id): PanelHandle \| null; navigate(id, source, opts?): Promise<{ id, title }>; open(source, opts?): Promise<PanelHandle>. Use list/roots/children/get for existing panels; navigate replaces an existing panel slot; open creates a new panel. self/get are sync; async methods refresh metadata as needed. |
| `buildPanelRenderErrorPrompt` | value |  |  |
| `installPanelErrorDiagnosticLauncher` | value |  |  |
| `openPanelErrorDiagnosticChat` | value |  |  |
| `agentApi` | value |  |  |
| `Journal` | value |  |  |
| `withJournal` | value |  |  |
| `currentJournal` | value |  |  |
| `adblock` | namespace | `getStats`, `isActive`, `getStatsForPanel`, `isEnabledForPanel`, `setEnabledForPanel`, `resetStatsForPanel`, `getPanelUrl`, `addToWhitelist`, `removeFromWhitelist` |  |
| `workspace` | namespace | `list`, `getActive`, `getActiveEntry`, `getConfig`, `create`, `delete`, `setInitPanels`, `setConfigField`, `switchTo`, `sourceTree`, `findUnitForPath`, `openPanel`, `units` | Workspace catalog, source tree, and unit helpers. Does not include panelTree; import top-level panelTree for panel-tree handles. |
| `credentials` | namespace | `store`, `connect`, `configureClient`, `requestCredentialInput`, `getClientConfigStatus`, `deleteClientConfig`, `listStoredCredentials`, `revokeCredential`, `grantCredential`, `resolveCredential`, `fetch`, `hookForUrl`, `gitHttp` |  |
| `git` | namespace | `http`, `importProject`, `completeWorkspaceDependencies`, `setSharedRemote`, `removeSharedRemote` |  |
| `vcs` | namespace | `applyEdits`, `readFile`, `listFiles`, `revert`, `status`, `unitStatus`, `log`, `diff`, `resolveHead`, `merge`, `abortMerge`, `pendingMerge`, `publishStatus`, `publish`, `recall` | Workspace GAD VCS (edit-first): applyEdits commits and projects edits atomically; status reports a head's unpublished changes vs main; diff compares state hashes. |
| `gad` | namespace | `rawSql`, `query`, `status`, `ensureBlob`, `getTrajectoryBranchHead`, `appendTrajectoryBatch`, `listTrajectoryEvents`, `appendChannelEnvelope`, `getChannelEnvelope`, `getTrajectoryForEnvelope`, `listPublishedEnvelopesForTrajectory`, `getEnvelopesForTrajectory`, `getPublishedArtifactsForTurn`, `getPrivateLineageForPublishedEnvelope`, `getDownstreamConsumers`, `getChannelReplayWindow`, `listChannelEnvelopesAfter`, `listChannelEnvelopesBefore`, `getInitialChannelWindow`, `listChannelEnvelopes`, `inspectChannelEnvelopes`, `listStoredValueRefs`, `inspectStorageDiagnostics`, `listGadBranchFiles`, `diffGadStates`, `readGadFileAtState`, `getGadStateProducer`, `blameGadFileSnippet`, `validateGadHashes`, `clearDirtyAfterValidation`, `checkGadIntegrity`, `rebuildTrajectoryProjections` |  |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` |  |
| `extensions` | namespace | `use`, `on`, `list`, `reload` |  |
| `approvals` | namespace | `request`, `revoke`, `list` |  |
| `requestApproval` | value |  |  |
| `revokeApproval` | value |  |  |
| `listApprovals` | value |  |  |
| `notifications` | namespace | `show`, `dismiss` |  |
<!-- END GENERATED: panel-runtime-surface -->

Workspace source edits commit immediately: the `edit`/`write` tools — and
`vcs.applyEdits` directly — apply each change as one atomic GAD transition on
your context head and project it to disk, so rebuilt panels, workers, packages,
or skills pick it up with no separate commit step. Use `git` only for external
project import, shared remotes, and build-event lookup. For external Git smart
HTTP, construct `GitClient` from `@natstack/git` with `credentials.gitHttp()`.

### Workspace VCS Call Shape

The `vcs` API is state-based, not cwd-based. Do not pass the workspace root,
`process.cwd()`, or a repo path to methods that ask for a head/ref or state hash.

| Task | Call shape |
| --- | --- |
| Current context status | `await vcs.status()` |
| Status for a materialized head | `await vcs.status("main")`, `await vcs.status("ctx:...")` |
| Log current context/head | `await vcs.log()` or `await vcs.log(20)` |
| Resolve a head to a state hash | `(await vcs.resolveHead("main")).stateHash` |
| Diff two states | `await vcs.diff(leftStateHash, rightStateHash)` |
| Read from current context/head | `await vcs.readFile("", "path/to/file.txt")` |
| Apply an edit (commits + projects atomically) | `await vcs.applyEdits({ baseStateHash, edits: [...] })` |
| Check unpublished context changes | `await vcs.publishStatus()` |

`vcs.status` reports a head's unpublished changes vs `main` — a GAD state-diff,
not filesystem dirtiness. Editing a file does not make `vcs.status` report
"dirty"; the edit is already committed to your context head. `dirty` means the
head is ahead of `main` (has unpublished changes); `main` is always clean. To
diff or pin states, use state hashes: `vcs.diff` accepts state hashes, not file
paths and not head names. If you have heads, resolve them first with
`vcs.resolveHead`; otherwise use the `stateHash` returned by `vcs.applyEdits`.

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

## Unified Panel Handles

Use `panelTree` and `PanelHandle` from panels, workers, and DOs. In panel
code, `panelTree` is imported directly from `@workspace/runtime`; it is not
`workspace.panelTree`:

```ts
import { panelTree, openPanel } from "@workspace/runtime";

const created = await openPanel("https://example.com", { focus: true });
const same = panelTree.get(created.id);
const parent = panelTree.self().parent();
const parentInfo = parent ? await parent.getInfo() : null;
const roots = await panelTree.roots();

const all = await panelTree.list();
const existing = all.find((handle) => handle.source === "panels/spectrolite");
const byKnownSlot = panelTree.get("panel-slot-id");
await byKnownSlot.refresh(); // hydrate title/source/parent/runtime entity metadata
await byKnownSlot.navigate("panels/spectrolite", { contextId: "ctx-vault" }); // replace slot
```

`openPanel()`/`panelTree.open()` creates a panel owned by the workflow. Handles
from `list`/`roots`/`children`/`get` are existing panels; do not call
`handle.navigate`, `handle.reload`, or `handle.close` unless requested. Inside
the current panel, prefer `reopen({ contextId, stateArgs })` for
self-replacement.

For web automation, use an owned browser panel from `openPanel("https://...")`.
Do not use the current chat panel, a parent chat panel, or another workspace
panel as a disposable browser target. `handle.cdp.navigate(url)` and
`page.goto(url)` replace/navigate the panel they target; use them only on the
browser panel you intentionally opened or on a panel the user explicitly asked
you to replace.

`PanelHandle` combines metadata, RPC, lifecycle, state, tree, and CDP:

```ts
await same.refresh();
await same.focus();
await same.stateArgs.set({ mode: "review" });
const state = await same.stateArgs.get();
await same.call.someExposedMethod();

const page = await same.cdp.lightweightPage();
await page.title();
await page.url();
await same.click("button");
```

Use `same.cdp.lightweightPage()` for the runtime-owned smaller wrapper. For
full Playwright, import `playwrightPage` from
`@workspace/playwright-automation` and call `await playwrightPage(handle)`.
Inline eval snippets that use full Playwright should pass
`imports: { "@workspace/playwright-automation": "latest" }`. There is no
generic `same.cdp.page()` alias and no compatibility
runtime-owned full Playwright method.

CDP and structural operations are approval-gated on first use per requester
runtime entity and target panel. Privileged shell/about targets use a severe
danger-tone approval. CDP transparently loads unloaded targets after approval;
RPC and `_agent` introspection do not auto-load; call `handle.ensureLoaded()`
first. It refreshes metadata for `handle.call.*` / `emit(...)`. A target held by
a mobile/non-CDP host rejects CDP access.

## Userland Approval Prompts

Use `requestApproval()` only when custom userland code exposes a shared resource
to other panels, workers, DOs, or extensions and needs a user decision that
NatStack cannot represent as a built-in permission. The shell verifies the
issuer identity (`callerId`/`callerKind`) and shows the user a trusted consent
prompt for that custom resource.

Do **not** call `requestApproval()` for ordinary actions the caller can already
perform: context filesystem reads/writes/removes, eval work, panel operations,
browser automation, git/runtime APIs, external opens, credential use, and other
host-mediated capabilities are already protected by NatStack's outer permission
systems where needed.

```ts
import { requestApproval, revokeApproval, listApprovals } from "@workspace/runtime";

const result = await requestApproval({
  subject: {
    id: "team-x:calendar-write",
    label: "Team X calendar write access",
  },
  title: "Allow calendar writes?",
  summary: "A custom calendar service wants to let this caller create Team X events.",
  warning: "Only allow this for teams you administer.",
  details: [
    { label: "Team", value: "Team X" },
    { label: "Operation", value: "Create calendar events" },
  ],
});

if (result.kind === "choice" && result.choice === "allow") {
  // Continue with the gated action.
}
```

By default the prompt shows **Allow once**, **Allow this session**, **Trust version**, and **Deny**. Positive choices return `choice: "allow"`; deny returns `choice: "deny"`.

For a custom prompt, opt into `promptOptions: "choices"` and supply options.
If you omit `options`, the host shows a simple allow/deny prompt.

```ts
const result = await requestApproval({
  subject: { id: "team-x:calendar-write", label: "Team X calendar write access" },
  title: "Allow calendar writes?",
  promptOptions: "choices",
  options: [
    { value: "allow", label: "Allow", tone: "primary" },
    { value: "deny", label: "Deny", tone: "danger" },
  ],
});

if (result.kind === "choice" && result.choice === "allow") {
  // Continue with the gated action.
}
```

Decision caching is server-managed. Scoped prompts remember session and version
choices according to the selected scope. Custom `choices` prompts remember every
non-dismiss choice for the verified issuer and `subject.id`; the next identical
request resolves immediately with the stored choice and no prompt. Dismissal is
not remembered.

```ts
const grants = await listApprovals();
await revokeApproval("team-x:calendar-write");
```

Use stable, provider-owned `subject.id` values such as
`team-x:calendar-write`. IDs must be 1-128 chars, use only
letters/numbers/`._:/-`, and cannot start with `shell:`, `server:`,
`system:`, or `@`. Option values must be unique, 1-40 chars, and use only
letters/numbers/`_-`; `dismiss` is reserved.

Do not use `requestApproval()` as a general confirmation dialog or a defensive
wrapper around actions the agent/runtime can already take. For host capabilities
that already have a NatStack permission flow, use `openExternal()`,
`credentials.*`, `git.*`, `vcs.*`, or the relevant runtime API so the host can apply the
right trust scope and audit model.

## Workspace VCS Edits

Workspace runtime source is activated from committed GAD states, and edits are
edit-first: the `edit`/`write` tools and `vcs.applyEdits` apply each change as
one atomic GAD transition on your context head and project it to disk. The edit
*is* the commit — there is no separate commit step. Each applied change advances
effective versions, triggers rebuilds, and is immediately visible to workspace
runtime units. Do not edit source through `fs.writeFile` and expect it to build:
the worktree is a disposable projection, and builds read GAD state, so source
edits must go through `edit`/`write`/`vcs.applyEdits` to land on the head. Use
the `stateHash` returned by `vcs.applyEdits` (or `vcs.resolveHead(head).stateHash`)
when you need a state hash for diffing or pinning.

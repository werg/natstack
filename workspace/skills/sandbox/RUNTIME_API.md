# Runtime API

Credentials are URL-bound and may only be used through host-mediated egress.

## Panel Runtime Surface

Panel identity has two layers: `panel.slotId` is the stable visible panel slot
and is the correct identity for panel-tree operations and PubSub/channel clients;
`id`/`panel.entityId`/`rpc.selfId` identify the current live runtime entity and
can change when the panel navigates or reopens.

<!-- BEGIN GENERATED: panel-runtime-surface -->
Generated from `runtimeSurface.panel.ts`. Use `await help()` at runtime for the live surface.

| Export | Kind | Members | Description |
|--------|------|---------|-------------|
| `id` | value |  |  |
| `contextId` | value |  |  |
| `rpc` | value |  | Portable RPC client (the full createRpcClient). |
| `fs` | value |  |  |
| `callMain` | value |  | Call a `main` (server) service method: callMain("fs.readFile", path). |
| `parent` | value |  | This runtime's parent panel handle (a no-panel handle when there is none). |
| `getParent` | value |  | Get the parent panel handle, or null when there is no parent. |
| `getParentWithContract` | value |  | Get the parent handle typed by a panel contract, or null. |
| `doTargetId` | value |  | Build a unified RPC target ID for a Durable Object reference. |
| `createDurableObjectServiceClient` | value |  | Resolve a Durable Object-backed service and call it through unified RPC. |
| `gatewayConfig` | value |  | Gateway base URL and bearer token for NatStack service routes. |
| `gatewayFetch` | value |  | Fetch helper that prefixes gateway-relative paths and adds Authorization: Bearer. |
| `openExternal` | value |  |  |
| `workers` | namespace | `listServices`, `resolveService`, `resolveDurableObject`, `durableObjectService`, `cloneDO`, `destroyDO` |  |
| `credentials` | namespace | `store`, `connect`, `configureClient`, `requestCredentialInput`, `getClientConfigStatus`, `deleteClientConfig`, `listStoredCredentials`, `inspectStoredCredentials`, `revokeCredential`, `resolveCredential`, `fetch`, `hookForUrl`, `gitHttp`, `forAudience` |  |
| `git` | namespace | `http`, `importProject`, `completeWorkspaceDependencies`, `setSharedRemote`, `removeSharedRemote` |  |
| `vcs` | namespace | `edit`, `commit`, `discardEdits`, `readFile`, `listFiles`, `revert`, `status`, `log`, `diff`, `resolveHead`, `workspaceViewWithRepoAt`, `merge`, `mergeGroup`, `abortMerge`, `pendingMerge`, `push`, `pushStatus`, `previewBuild`, `commitEdits`, `fileHistory`, `commitAncestors`, `editsByActor`, `editsByTurn`, `editsByInvocation`, `forkRepo`, `contextStatus`, `rebaseContext`, `recall` | Workspace GAD VCS (edit → commit → push): vcs.edit records tracked WORKING edits (no commit/build); vcs.commit folds them into a messaged snapshot per repo; push is the only main-advance (fast-forward-only, build-gated — diverged pushes reject, reconcile with vcs.merge). vcs.previewBuild builds working content on demand; status/fileHistory/commitEdits expose provenance. |
| `gad` | namespace | `rawSql`, `query`, `status`, `ensureBlob`, `getTrajectoryBranchHead`, `appendTrajectoryBatch`, `listTrajectoryEvents`, `appendChannelEnvelope`, `getChannelEnvelope`, `getTrajectoryForEnvelope`, `listPublishedEnvelopesForTrajectory`, `getEnvelopesForTrajectory`, `getPublishedArtifactsForTurn`, `getPrivateLineageForPublishedEnvelope`, `getDownstreamConsumers`, `getChannelReplayWindow`, `listChannelEnvelopesAfter`, `listChannelEnvelopesBefore`, `getInitialChannelWindow`, `listChannelEnvelopes`, `inspectChannelEnvelopes`, `listStoredValueRefs`, `inspectStorageDiagnostics`, `listGadBranchFiles`, `diffGadStates`, `readGadFileAtState`, `getGadStateProducer`, `blameGadFileSnippet`, `validateGadHashes`, `clearDirtyAfterValidation`, `checkGadIntegrity`, `rebuildTrajectoryProjections` |  |
| `blobstore` | namespace | `has`, `stat`, `putText`, `getText`, `getRange`, `getRangeBytes`, `grep`, `putBase64`, `getBase64`, `delete`, `list`, `pruneUnreferenced` | Per-workspace content-addressable blob store: putText/putBase64 store, getText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. Persist large artifacts/screenshots and return the digest. |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` |  |
| `extensions` | namespace | `use`, `invoke`, `on`, `list`, `reload` |  |
| `approvals` | namespace | `request`, `revoke`, `list` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
| `workspace` | namespace | `list`, `getActive`, `getActiveEntry`, `getConfig`, `create`, `delete`, `setInitPanels`, `setConfigField`, `switchTo`, `sourceTree`, `findUnitForPath`, `units` | Workspace catalog, source tree, and unit helpers. Does not include panelTree; import top-level panelTree for panel-tree handles. |
| `openPanel` | value |  |  |
| `listPanels` | value |  |  |
| `getPanelHandle` | value |  |  |
| `panelTree` | namespace | `self`, `get`, `list`, `roots`, `children`, `parent`, `navigate` | Top-level export, not workspace.panelTree. Signatures: self(): PanelHandle; get(id): PanelHandle; list(): Promise<PanelHandle[]>; roots(): Promise<PanelHandle[]>; children(id): Promise<PanelHandle[]>; parent(id): PanelHandle \| null; navigate(id, source, opts?): Promise<{ id, title }>. Use list/roots/children/get for existing panels; navigate replaces an existing panel slot; openPanel creates a new panel. self/get are sync; async methods refresh metadata as needed. |
| `Rpc` | value |  | RPC helpers namespace export. |
| `z` | value |  | Zod export. |
| `defineContract` | value |  |  |
| `buildPanelLink` | value |  |  |
| `parseContextId` | value |  |  |
| `isValidContextId` | value |  |  |
| `getInstanceId` | value |  |  |
| `normalizePath` | value |  |  |
| `getFileName` | value |  |  |
| `resolvePath` | value |  |  |
| `createGatewayFetch` | value |  | Create a gateway-authenticated fetch helper from an explicit config. |
| `panel` | namespace | `entityId`, `slotId`, `parentId`, `env`, `getInfo`, `focusPanel`, `getTheme`, `onThemeChange`, `onFocus`, `onConnectionError`, `onChildCreated`, `reopen`, `stateArgs` | Panel-only affordances: identity (entityId/slotId/parentId/env), introspection (getInfo/getTheme/onThemeChange/onFocus/onConnectionError), lifecycle (focusPanel/onChildCreated/reopen), and stateArgs (get/set/setForPanel). |
| `journal` | namespace | `Journal`, `with`, `current` | Panel operation journaling: journal.Journal (class), journal.with(journal, fn), journal.current(). |
| `agentApi` | value |  |  |
| `adblock` | namespace | `getStats`, `isActive`, `getStatsForPanel`, `isEnabledForPanel`, `setEnabledForPanel`, `resetStatsForPanel`, `getPanelUrl`, `addToWhitelist`, `removeFromWhitelist` |  |
<!-- END GENERATED: panel-runtime-surface -->

Workspace source follows **edit → commit → push**: the `edit`/`write` tools — and
`vcs.edit` directly — record each change as a tracked *working* edit on your
context head and project it to disk, so rebuilt panels, workers, packages, or
skills pick it up immediately. A working edit is not a commit: seal working edits
as a messaged milestone with `vcs.commit({ message })`, then advance `main` with
the fast-forward-only, build-gated `vcs.push`. Use `git` only for external
project import, shared remotes, and build-event lookup. For external Git smart
HTTP, construct `GitClient` from `@natstack/git` with `credentials.gitHttp()`.
For workspace-managed external repo declarations, startup auto-import, branches,
approvals, and private repo retries, see
`skills/onboarding/EXTERNAL_GIT_PROJECTS.md`.

## Workspace Catalog

Import `workspace` from `@workspace/runtime` to inspect the active workspace,
workspace catalog, and registered runtime units:

```ts
import { contextId, workspace } from "@workspace/runtime";

const active = await workspace.getActive();
const activeEntry = await workspace.getActiveEntry(); // { name, lastOpened }
const workspaces = await workspace.list();
const units = await workspace.units.list();

console.log({ contextId, active, activeEntry, workspaceCount: workspaces.length });
console.log("Unit sample:", units.slice(0, 5).map((unit) => unit.id));
```

`workspace.getActive()` returns the active workspace id. `getActiveEntry()`
returns the catalog entry for that id. Use `workspace.units.*` for source unit
inspection, diagnostics, logs, versions, restart, and rollback.

## Notifications

Use `notifications.show()` for host chrome notifications:

```ts
import { notifications } from "@workspace/runtime";

const id = await notifications.show({
  type: "info",
  title: "Notification test",
  message: "notification-show-marker",
});
```

`type` may be `info`, `success`, `warning`, `error`, or `consent`. The runtime
client defaults omitted `type` to `info`, and accepts `body` as an alias for
`message`.

### Workspace VCS Call Shape

The `vcs` API is per-repo and state-based, not cwd-based. Each workspace repo
(`packages/foo`, `panels/chat`, `projects/<vault>`, `meta`) is its own versioned
unit with its own log + history. Reads take a `repoPath` (positional) to scope to
one repo; `vcs.diff` takes only `state:…` hashes. Do not pass the workspace root
or `process.cwd()`.

| Task                                          | Call shape                                                   |
| --------------------------------------------- | ----------------------------------------------------------- |
| A repo's uncommitted + committed changes      | `await vcs.status("panels/chat")` (includes `uncommitted`)   |
| Status for a specific head in a repo          | `await vcs.status("panels/chat", "ctx:...")`                |
| Log a repo's commit history                   | `await vcs.log("panels/chat", 20)`                           |
| Resolve a head to a state hash in a repo      | `(await vcs.resolveHead("main", "panels/chat")).stateHash`   |
| Diff two states                               | `await vcs.diff(leftStateHash, rightStateHash)`             |
| Read a file from a repo's head                | `await vcs.readFile("", "notes.md", "panels/chat")`         |
| Record a working edit (projects to disk)      | `await vcs.edit({ edits: [...] })`                          |
| Seal working edits as a milestone             | `await vcs.commit({ message: "…", repoPaths: [...] })`      |
| Drop uncommitted working edits                | `await vcs.discardEdits("panels/chat")`                     |
| Pre-push check (ahead/diverged/uncommitted)   | `await vcs.pushStatus(["panels/chat"])`                     |
| Ship a repo's committed changes into its main | `await vcs.push({ repoPaths: ["panels/chat"] })`           |
| Fold main into your head after a diverge      | `await vcs.merge("panels/chat")`                            |
| Dry-run a build of your working content       | `await vcs.previewBuild({ repoPaths: ["panels/chat"] })`   |

`vcs.status(repoPath, head?)` reports that repo head's `uncommitted` working-edit
count and its committed changes vs the repo's own `main` — a GAD state-diff, not
filesystem dirtiness. The model is **edit → commit → push**: `vcs.edit({ edits })`
records a working change (projected to disk, builds immediately, but NOT a
commit), `vcs.commit({ message })` seals working edits as a messaged milestone
(message mandatory), and `vcs.push({ repoPaths: [...] })` advances `main` —
fast-forward-only and build-gated, multiple repoPaths push as one atomic group.
Push throws if working edits are uncommitted, and returns `status: "diverged"` if
`main` moved past your base; recover from a diverge with `vcs.merge(repoPath)`
(clean merges auto-commit; conflicts write markers you resolve via `vcs.edit` +
`vcs.commit`). To diff repo states, use state hashes: `vcs.diff` accepts
`state:…` hashes, not file paths and not head names. If you have heads, resolve
them first with `vcs.resolveHead(head, repoPath)`; otherwise use the `stateHash`
returned by `vcs.edit`/`vcs.commit`. Those VCS hashes are repo-rooted; before
using one as a pinned `build.getBuild` ref, convert it with
`vcs.workspaceViewWithRepoAt(repoPath, repoStateHash)` and pass the returned
workspace-rooted `stateHash`.

VCS tracks workspace **source**, so every `vcs.edit`/`write` path must live
under a tracked directory (`projects/`, `panels/`, `packages/`, `apps/`,
`workers/`, `skills/`, `extensions/`). A *temporary* or throwaway file you record
still goes inside a repo under one of those — e.g. `projects/tmp-foo/note.txt` —
**not** a
platform-ignored path. `vcs.edit` rejects ignored dirs (`.natstack`,
`.tmp`, `.git`, `.gad`, `node_modules`, `dist`) and ignored files (`.env`,
`*.log`); in particular do **not** pass an `fs.mktemp()` path (it returns an
ignored `.tmp/` location) to `vcs.edit`. In container sections such as
`projects/`, `section/name` is the repo root; write `section/name/file`, not the
repo root itself. No scaffold is needed for a temporary project repo: writing
`projects/tmp-name/file` creates context-local working content. Commit only for a
named local snapshot; push only when it should become visible on `main`.

`vcs.readFile("", path)` returns `{ content, stateHash, contentHash, mode, size }`
— there is no `baseStateHash` field; use the returned `stateHash` as the
`baseStateHash` for a follow-up `vcs.edit`. `content` is a tagged union:
text files return `{ kind: "text", text: "..." }`, while binary files return
`{ kind: "bytes", base64: "..." }`. Do not interpolate `read.content` directly;
check `read.content.kind` and then use `read.content.text` or
`read.content.base64`.

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
await byKnownSlot.navigate("panels/spectrolite", { contextId: "ctx-vault" }); // state/files only; code remains the default/current build
await byKnownSlot.navigate("panels/spectrolite", {
  contextId: "ctx-vault",
  ref: "ctx:ctx-vault",
}); // only when intentionally building code from that context branch
```

`openPanel()` creates a panel owned by the workflow. Handles
from `list`/`roots`/`children`/`get` are existing panels; do not call
`handle.navigate`, `handle.reload`, or `handle.close` unless requested. Inside
the current panel, prefer `reopen({ contextId, stateArgs })` for
self-replacement of state/files. `contextId` does not select code provenance;
pass an explicit `ref` on ref-capable navigation APIs when code should come from
a context branch.

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
page.url(); // string, synchronous like Playwright
await same.click("button");
```

`same.cdp.lightweightPage()` returns a Playwright-style page driven by our own
lightweight, workerd-native CDP client (`@workspace/cdp-client`). It is the
single browser-automation surface — there is no separate "full Playwright" tier,
and you do not import or install any `playwright*` package. The page exposes
locators (`page.locator`, `page.getByRole`, `page.getByText`, `page.getByLabel`,
…), auto-waiting actions (`click`, `fill`, `check`, `selectOption`, …), reads
(`innerText`, `count`, `isVisible`, `getAttribute`, …), and page-level methods
(`goto`, `screenshot`, `waitForSelector`, `evaluate`, …). For protocol-level
work, `import { CdpConnection } from "@workspace/cdp-client"` and connect with
`(await same.cdp.getCdpEndpoint())`. There is no generic `same.cdp.page()` alias.

`openPanel`/`panelTree`/`PanelHandle` are part of the portable runtime surface
from `@workspace/runtime`; they work from server-side eval, panels, workers, and
DOs. The `handle.cdp.*` automation is workerd-native and runs over a WebSocket
to the panel's CDP endpoint, so eval can open or discover a panel and drive its
browser target directly.

CDP and structural operations are approval-gated on first use per requester
runtime entity and target panel. Privileged shell/about targets use a severe
danger-tone approval. CDP transparently loads unloaded targets after approval;
RPC and `_agent` introspection do not auto-load; call `handle.ensureLoaded()`
first. It refreshes metadata for `handle.call.*` / `emit(...)`. A target held by
a mobile/non-CDP host rejects CDP access.

## Userland Approval Prompts

Use `approvals.request()` only when custom userland code exposes a shared resource
to other panels, workers, DOs, or extensions and needs a user decision that
NatStack cannot represent as a built-in permission. The shell verifies the
issuer identity (`callerId`/`callerKind`) and shows the user a trusted consent
prompt for that custom resource.

Do **not** call `approvals.request()` for ordinary actions the caller can already
perform: context filesystem reads/writes/removes, eval work, panel operations,
browser automation, git/runtime APIs, external opens, credential use, and other
host-mediated capabilities are already protected by NatStack's outer permission
systems where needed.

```ts
import { approvals } from "@workspace/runtime";

const result = await approvals.request({
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
const result = await approvals.request({
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
const grants = await approvals.list();
await approvals.revoke("team-x:calendar-write");
```

Use stable, provider-owned `subject.id` values such as
`team-x:calendar-write`. IDs must be 1-128 chars, use only
letters/numbers/`._:/-`, and cannot start with `shell:`, `server:`,
`system:`, or `@`. Option values must be unique, 1-40 chars, and use only
letters/numbers/`_-`; `dismiss` is reserved.

Do not use `approvals.request()` as a general confirmation dialog or a defensive
wrapper around actions the agent/runtime can already take. For host capabilities
that already have a NatStack permission flow, use `openExternal()`,
`credentials.*`, `git.*`, `vcs.*`, or the relevant runtime API so the host can apply the
right trust scope and audit model.

## Workspace VCS Edits

Workspace runtime source is activated from your context head's working GAD state,
and follows **edit → commit → push**: the `edit`/`write` tools and
`vcs.edit({ edits })` record each change as a tracked *working* edit on your
context head and project it to disk. A working edit advances effective versions,
triggers rebuilds, and is immediately visible to workspace runtime units — but it
is NOT a commit. `vcs.commit({ message })` seals your accumulated working edits as
a messaged milestone (message mandatory; this is what shows up in `vcs.log`), and
`vcs.push` advances `main` (fast-forward-only, build-gated). Do not edit source
through `fs.writeFile` and expect it to build: the worktree is a disposable
projection, and builds read GAD state, so source edits must go through
`edit`/`write`/`vcs.edit` to land on the head. Use the repo-rooted `stateHash`
returned by `vcs.edit`/`vcs.commit` (or `vcs.resolveHead(head, repoPath).stateHash`)
for `vcs.diff`. For a pinned `build.getBuild` ref, first compose it into a
workspace-rooted state with `vcs.workspaceViewWithRepoAt(repoPath, repoStateHash)`.
Drop unwanted working edits with `vcs.discardEdits(repoPath)`.

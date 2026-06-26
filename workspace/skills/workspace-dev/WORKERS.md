# Worker Runtime API

Credentials are URL-bound and may only be used through host-mediated egress.

## Worker Runtime Surface

<!-- BEGIN GENERATED: worker-runtime-surface -->
Generated from `runtimeSurface.worker.ts`. Use `await help()` at runtime for the live surface.

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
| `workers` | namespace | `listServices`, `resolveService`, `resolveDurableObject`, `durableObjectService` |  |
| `credentials` | namespace | `store`, `connect`, `configureClient`, `requestCredentialInput`, `getClientConfigStatus`, `deleteClientConfig`, `listStoredCredentials`, `inspectStoredCredentials`, `revokeCredential`, `resolveCredential`, `fetch`, `hookForUrl`, `gitHttp`, `forAudience` |  |
| `git` | namespace | `http`, `importProject`, `completeWorkspaceDependencies`, `setSharedRemote`, `removeSharedRemote` |  |
| `vcs` | namespace | `edit`, `commit`, `discardEdits`, `readFile`, `listFiles`, `revert`, `status`, `log`, `diff`, `resolveHead`, `workspaceViewWithRepoAt`, `merge`, `mergeGroup`, `abortMerge`, `pendingMerge`, `push`, `pushStatus`, `previewBuild`, `commitEdits`, `fileHistory`, `commitAncestors`, `editsByActor`, `editsByTurn`, `editsByInvocation`, `forkRepo`, `contextStatus`, `rebaseContext`, `recall` | Workspace GAD VCS (edit → commit → push): vcs.edit records tracked WORKING edits (no commit/build); vcs.commit folds them into a messaged snapshot per repo; push is the only main-advance (fast-forward-only, build-gated — diverged pushes reject, reconcile with vcs.merge). vcs.previewBuild builds working content on demand; status/fileHistory/commitEdits expose provenance. |
| `gad` | namespace | `rawSql`, `query`, `status`, `ensureBlob`, `getTrajectoryBranchHead`, `appendTrajectoryBatch`, `listTrajectoryEvents`, `appendChannelEnvelope`, `getChannelEnvelope`, `getTrajectoryForEnvelope`, `listPublishedEnvelopesForTrajectory`, `getEnvelopesForTrajectory`, `getPublishedArtifactsForTurn`, `getPrivateLineageForPublishedEnvelope`, `getDownstreamConsumers`, `getChannelReplayWindow`, `listChannelEnvelopesAfter`, `listChannelEnvelopesBefore`, `getInitialChannelWindow`, `listChannelEnvelopes`, `inspectChannelEnvelopes`, `listStoredValueRefs`, `inspectStorageDiagnostics`, `listGadBranchFiles`, `diffGadStates`, `readGadFileAtState`, `getGadStateProducer`, `blameGadFileSnippet`, `validateGadHashes`, `clearDirtyAfterValidation`, `checkGadIntegrity`, `rebuildTrajectoryProjections` |  |
| `blobstore` | namespace | `has`, `stat`, `putText`, `getText`, `getRange`, `getRangeBytes`, `grep`, `putBase64`, `getBase64`, `delete`, `list`, `pruneUnreferenced` | Per-workspace content-addressable blob store: putText/putBase64 store, getText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. Persist large artifacts/screenshots and return the digest. |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` |  |
| `extensions` | namespace | `use`, `invoke`, `on`, `list`, `reload` |  |
| `approvals` | namespace | `request`, `revoke`, `list` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
| `workspace` | namespace | `list`, `getActive`, `getActiveEntry`, `getConfig`, `create`, `delete`, `setInitPanels`, `setConfigField`, `switchTo`, `sourceTree`, `findUnitForPath`, `units` | Workspace catalog, source tree, and unit helpers. Does not include panelTree; use runtime.panelTree for panel-tree handles. |
| `openPanel` | value |  | Open a workspace or browser panel and return a PanelHandle. |
| `listPanels` | value |  | Alias for runtime.panelTree.list(). |
| `getPanelHandle` | value |  | Alias for runtime.panelTree.get(id, kind?). |
| `panelTree` | namespace | `self`, `get`, `list`, `roots`, `children`, `parent`, `navigate` | Runtime property, not workspace.panelTree. Signatures: self(): PanelHandle; get(id): PanelHandle; list(): Promise<PanelHandle[]>; roots(): Promise<PanelHandle[]>; children(id): Promise<PanelHandle[]>; parent(id): PanelHandle \| null; navigate(id, source, opts?): Promise<{ id, title }>. Use list/roots/children/get for existing panels; navigate replaces an existing panel slot; openPanel creates a new panel. self/get are sync; async methods refresh metadata as needed. |
| `handleRpcPost` | value |  |  |
| `destroy` | value |  |  |
<!-- END GENERATED: worker-runtime-surface -->

Existing panel handles are non-owned; do not call `handle.navigate`,
`handle.reload`, or `handle.close` unless requested. Use
`handle.navigate(source, opts)` or `panelTree.navigate(id, source, opts)` only
when replacing that specific slot is the requested behavior. Clean up temporary
panels opened by the worker.

For panel navigation options, `contextId` changes the target panel's
filesystem/storage context and `ref` selects the code build. Never rely on
`contextId` to imply `ctx:<contextId>`; pass `ref` explicitly when replacing a
panel with context-branch code.

## Userland Services

Worker package.json only carries `natstack.durable.classes` (workerd binding).
Workspace-level singletons, services, and HTTP routes live in
`workspace/meta/natstack.yml`. Resolve services by name/protocol through
`workers.resolveService(...)`; do not hardcode `workers/foo`, DO class names,
or `/_r/w/...` paths in callers.

Worker packages may declare simple string overrides in top-level `overrides`.
BuildV2 forwards those overrides, plus overrides from transitive workspace
packages, into generated external-deps installs. Prefer package-local overrides
for broken or missing transitive npm versions; changing an override invalidates
the dependency cache.

**Durable Object-backed service** — add to `workspace/meta/natstack.yml`:

```yaml
singletonObjects:
  - source: workers/my-store
    className: MyStore
    key: main

services:
  - source: workers/my-store
    name: my-store
    protocols: [example.my-store.v1]
    durableObject: { className: MyStore } # key joined from singletonObjects
```

Resolve and call it:

```ts
const svc = await workers.resolveService("example.my-store.v1");
if (svc.kind !== "durable-object") throw new Error("Expected DO service");
await rpc.call(svc.targetId, "methodName", [arg]);
```

**Stateless worker service** — add to `workspace/meta/natstack.yml`:

```yaml
routes:
  - source: workers/my-api
    path: /api
    worker: true

services:
  - source: workers/my-api
    name: my-api
    protocols: [example.my-api.v1]
    worker: { routePath: /api }
```

Resolve and fetch it:

```ts
const svc = await workers.resolveService("example.my-api.v1");
if (svc.kind !== "worker") throw new Error("Expected worker service");
await gatewayFetch(`${svc.routeBasePath}/jobs`, { method: "POST", body: JSON.stringify(payload) });
```

A `services[].durableObject` or `routes[].durableObject` referencing a DO
class with no matching `singletonObjects` row is rejected at workspace-load
time. Stateless service routes are live only while the canonical worker
instance is running.

## Durable Object Schema & Migrations

`DurableObjectBase` owns SQLite schema lifecycle — never run `CREATE TABLE` /
`ALTER TABLE` ad hoc in handlers. Define the schema declaratively and version
it:

```ts
export class MyStoreDO extends DurableObjectBase {
  // Bump this when the schema changes. Persisted per-instance; instances
  // upgrade lazily on their next request.
  static override schemaVersion = 2;

  // Idempotent CREATE TABLE IF NOT EXISTS statements for the CURRENT schema.
  // Runs on every init (fresh and upgraded instances alike).
  protected override createTables(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, archived INTEGER DEFAULT 0
    )`);
  }

  // Step persisted data forward when an instance is below schemaVersion.
  // Runs BEFORE createTables(), once, inside init. Make each step idempotent.
  protected override migrate(fromVersion: number, _toVersion: number): void {
    if (fromVersion < 2) {
      this.sql.exec(`ALTER TABLE items ADD COLUMN archived INTEGER DEFAULT 0`);
    }
  }

  // Optional: tables that must exist before the version is recorded as ready.
  // Failed validation throws and retries on the next request.
  protected override requiredTables(): readonly string[] {
    return ["items"];
  }
}
```

Rules of thumb:

- **Additive changes** (new table, new nullable/defaulted column) — bump
  `schemaVersion`, add the `ALTER` to `migrate`, update `createTables`.
- **Never** renumber or reuse versions; an instance whose stored version is
  *newer* than the code's `schemaVersion` refuses to start (downgrade guard).
- Schema init is lazy (first `fetch()`/`alarm()`) and retried on failure, so a
  throwing migration surfaces in `workspace.units.diagnostics` for the source
  and the instance stays on its old version until fixed.

## Durable Object RPC Exposure & Authorization

DO methods are reachable over RPC only when explicitly opted in, and the
workspace realm enforces a per-method caller policy (default-deny). Two layers,
kept separate — both required. Full design: [`docs/capability-approval-design.md`](../../../docs/capability-approval-design.md).

### Layer 1 — `@rpc` exposure (which methods are callable)

A method with no `@rpc` is private to the DO and cannot be invoked over the
relay; forgetting `@rpc` fails loud ("not exposed"). Mark every method a caller
should reach.

### Layer 2 — `@rpc({ callers })` caller policy (who may call it)

The RPC relay is open between authenticated participants, so the recipient must
gate. **In the workspace realm, every relay-reachable method MUST declare an
`@rpc({ callers: [...] })` policy** — a method with no policy, or a call from a
caller kind not listed, is refused (default-deny). `callers` is a coarse
caller-KIND floor; values: `"panel" | "do" | "server" | "worker" | "shell" |
"app" | "extension"`.

```ts
import { rpc } from "@workspace/runtime/worker";

export class MyStoreDO extends DurableObjectBase {
  @rpc({ callers: ["panel", "do"] })       // a panel or an agent DO may call it
  async addItem(label: string): Promise<{ id: string }> { ... }

  @rpc({ callers: ["server"] })            // server-dispatched only (webhook/alarm)
  async onWebhookDelivery(event: WebhookEvent): Promise<void> { ... }

  private bumpCounter(): void { ... }       // no @rpc — unreachable over RPC
}
```

Typical floors: panel-driven → `["panel"]`/`["panel","do"]`; channel/agent-internal
→ `["do"]`; server-dispatched (webhooks/alarms/lifecycle) → `["server"]`;
broad reads → `["do","panel","server"]`; admin/destructive → `["server","shell"]`.

### Identity-level tightening (inline)

The kind floor is coarse — *any* DO is `"do"`. When a method must accept only ONE
specific caller (this agent's own EvalDO, the agent's own PubSubChannel, a known
class), add an inline check ON TOP of the floor using the server-authenticated
caller, which cannot be forged:

```ts
@rpc({ callers: ["do"] })
async onChannelOp(channelId: string): Promise<void> {
  await this.assertOwnEvalCaller(channelId); // only THIS agent's own EvalDO
  ...
}
// this.rpcCallerId / this.rpcCallerKind / this.caller are server-set from the
// validated token. (Server-realm DOs like EvalDO use a coarser per-DO
// `assertInboundAllowed` override instead of @rpc policies.)
```

### When to add a USER-APPROVAL gate

Reachability (Layers 1–2) answers "may this caller reach the method"; it never
asks the user. For a *userland-useful but sensitive* action, require a user
decision:
- **Built-in host actions** (credentials, external opens, git writes, project
  imports, webhooks, publishing main, spawning workers): call the existing
  runtime API and let NatStack's built-in capability-permission flow prompt — do
  NOT re-implement approval.
- **Custom shared resources** your worker exposes to other userland callers: use
  `runtime.approvals.request(...)` (see "Userland Approval Prompts" below).

Never cache an approval result or invent your own grant scope — the host owns
persistence, scope (once/session/version), and revocation.

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
initial use grant. For provider secrets/config, use
`credentials.configureClient()` and pass `clientConfigId`.

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

Use `type: "oauth2-device-code"` when redirect-based flows can't reach the
server — providers that won't accept a Tailscale `*.ts.net` redirect URI,
headless installs, or when the user wants to authorize on a different device.
The server displays the `user_code` on the trusted approval bar while it
polls the token endpoint. See [api-integrations
SKILL.md](../api-integrations/SKILL.md#device-code-flow) for the full
provider compatibility matrix.

## Use

```ts
await credentials.fetch("https://api.example.com/v1/items", undefined, {
  credentialId: stored.id,
});
```

## Userland Approval Prompts

Workers can ask the user for provider-defined decisions through the runtime's
approval helpers. Use this when a worker exposes its own security-gated service
to other userland callers and needs a human decision that NatStack cannot model
as a built-in credential or capability permission.

Do not call `approvals.request()` before actions the worker or agent can already
take through normal runtime APIs. Context filesystem work, eval work, panel
operations, browser automation, git/runtime APIs, external opens, and credential
use are protected by the outer NatStack permission model where approval is
required.

```ts
import { createWorkerRuntime } from "@workspace/runtime/worker";

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);

    const decision = await runtime.approvals.request({
      subject: {
        id: "team-x:calendar-write",
        label: "Team X calendar write access",
      },
      title: "Allow calendar writes?",
      summary: "This custom calendar worker wants to let the caller create Team X events.",
      details: [
        { label: "Caller", value: request.headers.get("x-caller") ?? "unknown" },
        { label: "Operation", value: "Create calendar events" },
      ],
      options: [
        { value: "allow", label: "Allow", tone: "primary" },
        { value: "deny", label: "Deny", tone: "danger" },
      ],
    });

    if (decision.kind !== "choice" || decision.choice !== "allow") {
      return new Response("Not approved", { status: 403 });
    }

    return new Response("Approved");
  },
};
```

Every non-dismiss choice is persisted by the server under the verified issuer
worker and `subject.id`. Subsequent calls with the same `subject.id` return the
stored choice immediately. Use `runtime.approvals.revoke(subjectId)` to forget a
decision, and `runtime.approvals.list()` to inspect decisions owned by the same
worker.

```ts
await runtime.approvals.revoke("team-x:calendar-write");
const grants = await runtime.approvals.list();
```

Keep `subject.id` stable and provider-owned. It must be 1-128 chars using only
letters/numbers/`._:/-`, and cannot start with `shell:`, `server:`, `system:`,
or `@`. Options must have unique values; `dismiss` is reserved. Treat
`approvals.request()` as a userland policy gate for custom shared resources only.
For host-mediated actions such as external browser opens, credentials, git
writes, project imports, or webhooks, call the existing runtime API and let
NatStack's built-in permission flow handle the prompt and trust scope. For
ordinary context file edits and test temp directories, do not prompt.

## Agent Debug Port

The default AI agent worker exposes a read-only participant method named
`getDebugState`. Use it when a channel appears stuck, especially after
`turn.opened` with no assistant message, tool call, or `turn.closed` event:

```ts
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
console.log(JSON.stringify(debug, null, 2).slice(0, 4000));
```

The response includes dispatcher state, runner phase, persisted pending work,
channel checkpoints, and recent lifecycle/debug events. Do not add sleeps or
timeouts to diagnose these stalls; inspect the debug state and fix the blocked
operation. See `../../../docs/agent-debug-port.md` for the full field guide.

## Blobstore (content-addressable bytes)

The per-workspace blobstore stores arbitrary content keyed by sha256 digest.
Use it for anything large or binary — model outputs, fetched documents,
generated artifacts, the object layer for a custom git-like format.

**Metadata via RPC** (uses the worker's existing `RPC_AUTH_TOKEN` automatically):

```ts
const exists = await callMain("blobstore.has", digest);
const meta = await callMain("blobstore.stat", digest); // { size, mtime } | null
```

**Streaming binary I/O via the gateway**:

```ts
// Writes are streaming — pass any Readable / ReadableStream as the body.
const put = await runtime.gatewayFetch("/_r/s/blobstore/blob", {
  method: "PUT",
  body,
});
const { digest, size } = await put.json();

const get = await runtime.gatewayFetch(`/_r/s/blobstore/blob/${digest}`);
// `get.body` is a ReadableStream of the original bytes.
```

`gatewayFetch` prefixes `GATEWAY_URL` and sends `Authorization: Bearer
<RPC_AUTH_TOKEN>`. Worker tokens are minted from the central `TokenManager`,
so the route's `caller-token` auth admits them.

`blobstore.delete` and `blobstore.list` are restricted to shell/server callers
and cannot be invoked from a worker — design the upper layer (e.g. a server
service) to own GC.

See [`docs/architecture/storage.md`](../../../docs/architecture/storage.md#blobstore-content-addressable-objects)
for the full design.

# Worker Runtime API

Credentials are URL-bound and may only be used through host-mediated egress.

## Worker Runtime Surface

<!-- BEGIN GENERATED: worker-runtime-surface -->
Generated from `runtimeSurface.worker.ts`. Use `await help()` at runtime for the live surface.

| Export | Kind | Members | Description |
|--------|------|---------|-------------|
| `id` | value |  |  |
| `rpc` | value |  |  |
| `fs` | value |  |  |
| `doTargetId` | value |  | Build a unified RPC target ID for a Durable Object reference. |
| `createDurableObjectServiceClient` | value |  | Resolve a Durable Object-backed service and call it through unified RPC. |
| `workers` | namespace | `create`, `destroy`, `update`, `list`, `status`, `listInstanceSources`, `listServices`, `resolveService`, `resolveDurableObject`, `durableObjectService`, `getPort`, `restartAll`, `cloneDO`, `destroyDO` |  |
| `workspace` | namespace | `list`, `getActive`, `getActiveEntry`, `getConfig`, `create`, `delete`, `setInitPanels`, `setConfigField`, `switchTo`, `sourceTree`, `findUnitForPath`, `units` | Workspace catalog, source tree, and unit helpers. Does not include panelTree; use runtime.panelTree for panel-tree handles. |
| `credentials` | namespace | `store`, `connect`, `configureClient`, `requestCredentialInput`, `getClientConfigStatus`, `deleteClientConfig`, `listStoredCredentials`, `revokeCredential`, `grantCredential`, `resolveCredential`, `fetch`, `hookForUrl`, `gitHttp` |  |
| `git` | namespace | `http`, `importProject`, `completeWorkspaceDependencies`, `setSharedRemote`, `removeSharedRemote` |  |
| `vcs` | namespace | `commit`, `applyEdits`, `readFile`, `listFiles`, `revert`, `status`, `unitStatus`, `log`, `diff`, `resolveHead`, `merge`, `abortMerge`, `pendingMerge`, `publishStatus`, `publish`, `recall` | Workspace GAD VCS. Paths are workspace-relative; status scans materialized heads, log can read refs, and diff compares state hashes. |
| `gad` | namespace | `rawSql`, `query`, `status`, `ensureBlob`, `getTrajectoryBranchHead`, `appendTrajectoryBatch`, `listTrajectoryEvents`, `appendChannelEnvelope`, `getChannelEnvelope`, `getTrajectoryForEnvelope`, `listPublishedEnvelopesForTrajectory`, `getEnvelopesForTrajectory`, `getPublishedArtifactsForTurn`, `getPrivateLineageForPublishedEnvelope`, `getDownstreamConsumers`, `getChannelReplayWindow`, `listChannelEnvelopesAfter`, `listChannelEnvelopesBefore`, `getInitialChannelWindow`, `listChannelEnvelopes`, `inspectChannelEnvelopes`, `listStoredValueRefs`, `inspectStorageDiagnostics`, `listGadBranchFiles`, `diffGadStates`, `readGadFileAtState`, `getGadStateProducer`, `blameGadFileSnippet`, `validateGadHashes`, `clearDirtyAfterValidation`, `checkGadIntegrity`, `rebuildTrajectoryProjections` |  |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` |  |
| `extensions` | namespace | `use`, `on`, `list`, `reload` |  |
| `approvals` | namespace | `request`, `revoke`, `list` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
| `contextId` | value |  |  |
| `gatewayConfig` | value |  | Gateway base URL and bearer token for NatStack service routes. |
| `gatewayFetch` | value |  | Fetch helper that prefixes gateway-relative paths and adds Authorization: Bearer. |
| `callMain` | value |  |  |
| `openExternal` | value |  |  |
| `requestApproval` | value |  |  |
| `revokeApproval` | value |  |  |
| `listApprovals` | value |  |  |
| `expose` | value |  |  |
| `getParent` | value |  |  |
| `panelTree` | namespace | `self`, `get`, `list`, `roots`, `children`, `parent`, `navigate`, `open` | Runtime property, not workspace.panelTree. Signatures: self(): PanelHandle; get(id): PanelHandle; list(): Promise<PanelHandle[]>; roots(): Promise<PanelHandle[]>; children(id): Promise<PanelHandle[]>; parent(id): PanelHandle \| null; navigate(id, source, opts?): Promise<{ id, title }>; open(source, opts?): Promise<PanelHandle>. Use list/roots/children/get for existing panels; navigate replaces an existing panel slot; open creates a new panel. self/get are sync; async methods refresh metadata as needed. |
| `handleRpcPost` | value |  |  |
| `destroy` | value |  |  |
<!-- END GENERATED: worker-runtime-surface -->

Existing panel handles are non-owned; do not call `handle.navigate`,
`handle.reload`, or `handle.close` unless requested. Use
`handle.navigate(source, opts)` or `panelTree.navigate(id, source, opts)` only
when replacing that specific slot is the requested behavior. Clean up temporary
panels opened by the worker.

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

Do not call `requestApproval()` before actions the worker or agent can already
take through normal runtime APIs. Context filesystem work, eval work, panel
operations, browser automation, git/runtime APIs, external opens, and credential
use are protected by the outer NatStack permission model where approval is
required.

```ts
import { createWorkerRuntime } from "@workspace/runtime/worker";

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);

    const decision = await runtime.requestApproval({
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
stored choice immediately. Use `runtime.revokeApproval(subjectId)` to forget a
decision, and `runtime.listApprovals()` to inspect decisions owned by the same
worker.

```ts
await runtime.revokeApproval("team-x:calendar-write");
const grants = await runtime.listApprovals();
```

Keep `subject.id` stable and provider-owned. It must be 1-128 chars using only
letters/numbers/`._:/-`, and cannot start with `shell:`, `server:`, `system:`,
or `@`. Options must have unique values; `dismiss` is reserved. Treat
`requestApproval()` as a userland policy gate for custom shared resources only.
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

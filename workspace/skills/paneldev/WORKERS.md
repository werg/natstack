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
| `workers` | namespace | `create`, `destroy`, `update`, `list`, `status`, `listInstanceSources`, `listServices`, `resolveService`, `getPort`, `restartAll`, `cloneDO`, `destroyDO` |  |
| `workspace` | namespace | `list`, `getActive`, `getActiveEntry`, `getConfig`, `create`, `setInitPanels`, `switchTo` |  |
| `credentials` | namespace | `store`, `connect`, `configureClient`, `requestCredentialInput`, `getClientConfigStatus`, `deleteClientConfig`, `listStoredCredentials`, `revokeCredential`, `resolveCredential`, `gitHttp` |  |
| `git` | namespace | `http`, `importProject`, `completeWorkspaceDependencies`, `setSharedRemote`, `removeSharedRemote`, `client` |  |
| `gad` | namespace | `rawSql`, `query`, `status`, `ensureBlob`, `ensureBranch`, `recordSession`, `endSession`, `recordTurn`, `beginToolCall`, `completeToolCall`, `recordRead`, `recordMutation`, `listBranches`, `getBranch`, `listBranchFiles`, `forkBranch`, `createBranchSnapshot`, `listBranchSnapshots`, `recordPlan`, `supersedePlan`, `listPlans`, `getPlanChain`, `createChunk`, `addChunkMention`, `relateChunk`, `listChunks`, `getChunkMentions`, `getChunksFor`, `getRelationsFor`, `walkDependencies`, `upsertChunkEmbedding`, `upsertTurnEmbedding`, `findSimilarChunks`, `findSimilarTurns`, `parseFileVersion`, `getStructures`, `findParsedByName`, `getStructuresInRange`, `getSupportedLanguages`, `indexTurn`, `indexFileVersion`, `indexSession`, `getReviewContext`, `setBlobPolicy`, `getBlobPolicy`, `redactBlob`, `listBlobReferences`, `revokeRawSqlWriteApproval` |  |
| `webhooks` | namespace | `createSubscription`, `listSubscriptions`, `revokeSubscription`, `rotateSecret` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
| `contextId` | value |  |  |
| `gatewayConfig` | value |  | Gateway base URL and bearer token for NatStack service routes. |
| `gatewayFetch` | value |  | Fetch helper that prefixes gateway-relative paths and adds Authorization: Bearer. |
| `gitConfig` | value |  | Git HTTP endpoint and token derived from the gateway config. |
| `pubsubConfig` | value |  | Always null in worker runtime; PubSub access goes through runtime.subscribe(). |
| `subscribe` | value |  | Create a PubSub channel client backed by runtime RPC. |
| `callMain` | value |  |  |
| `openExternal` | value |  |  |
| `getWorkspaceTree` | value |  |  |
| `listBranches` | value |  |  |
| `listCommits` | value |  |  |
| `requestApproval` | value |  |  |
| `approvalAccessPolicy` | value |  | Create an RPC access policy that prompts the user and scopes the grant to the caller source. |
| `revokeApproval` | value |  |  |
| `listApprovals` | value |  |  |
| `exposeMethod` | value |  |  |
| `getParent` | value |  |  |
| `handleRpcPost` | value |  |  |
| `destroy` | value |  |  |
<!-- END GENERATED: worker-runtime-surface -->

## Userland Services

When building a reusable service in `workspace/workers`, declare it in the
worker package manifest with `natstack.services[]`. Other code should resolve
the service by `name` or protocol through `workers.resolveService(...)`; do not
hardcode `workers/foo`, DO class names, or `/_r/w/...` paths in callers.

**Durable Object-backed service**:

```json
{
  "natstack": {
    "entry": "index.ts",
    "durable": { "classes": [{ "className": "MyStore" }] },
    "services": [
      {
        "name": "my-store",
        "protocols": ["example.my-store.v1"],
        "durableObject": { "className": "MyStore", "objectKey": "main" }
      }
    ]
  }
}
```

Resolve and call it:

```ts
const svc = await workers.resolveService("example.my-store.v1", "tenant-1");
if (svc.kind !== "durable-object") throw new Error("Expected DO service");
await rpc.call(svc.targetId, "methodName", arg);
```

## Exposing RPC Methods

RPC receivers must authorize callers with the runtime RPC access-policy API.
Do not pass caller IDs in method arguments and do not read caller identity from
message bodies. The runtime derives `ctx.sourceId` from the authenticated
transport.

Use a narrow policy for each exposed method:

```ts
import { allowCallerIds } from "@natstack/rpc";

runtime.exposeMethod(
  "notes.read",
  allowCallerIds("panel:trusted"),
  async (ctx, noteId: string) => {
    return readNoteForCaller(ctx.sourceId, noteId);
  },
);
```

For user-approved access, use the approval-backed helper. Grants are
automatically keyed by the calling source ID, so approving one caller does not
approve a different panel, worker, or DO.

```ts
runtime.exposeMethod(
  "notes.delete",
  runtime.approvalAccessPolicy({
    subjectId: "notes.delete",
    title: (ctx) => `Allow ${ctx.sourceId} to delete notes?`,
    summary: "This permits the caller to delete notes through this worker.",
    warning: "Deleted notes cannot be recovered.",
  }),
  async (ctx, noteId: string) => {
    return deleteNoteForCaller(ctx.sourceId, noteId);
  },
);
```

Use `allowAllCallers` only for intentionally public, side-effect-free methods.

**Stateless worker service**:

```json
{
  "natstack": {
    "entry": "index.ts",
    "routes": [{ "path": "/api", "methods": ["POST"] }],
    "services": [
      {
        "name": "my-api",
        "protocols": ["example.my-api.v1"],
        "worker": { "routePath": "/api" }
      }
    ]
  }
}
```

Resolve and fetch it:

```ts
const svc = await workers.resolveService("example.my-api.v1");
if (svc.kind !== "worker") throw new Error("Expected worker service");
await gatewayFetch(`${svc.routeBasePath}/jobs`, { method: "POST", body: JSON.stringify(payload) });
```

For stateless services, `worker.routePath` must match a regular
`natstack.routes[]` entry in the same package. Stateless service routes are live
only while the canonical worker instance is running. Use a DO-backed service for
always-available persistence or singleton coordination.

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
await fetch("https://api.example.com/v1/items", {
  headers: { "X-NatStack-Use-Credential": stored.id },
});
```

## Userland Approval Prompts

Workers can ask the user for provider-defined decisions through the runtime's
approval helpers. Use this when a worker exposes its own security-gated service
to other userland callers and needs a human decision that NatStack cannot model
as a built-in credential or capability permission.

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
      summary: "A caller wants this worker to create Team X calendar events.",
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
`requestApproval()` as a userland policy gate only. For host-mediated actions
such as external browser opens, credentials, git writes, project imports, or
webhooks, call the existing runtime API and let NatStack's built-in permission
flow handle the prompt and trust scope.

## Blobstore (content-addressable bytes)

The per-workspace blobstore stores arbitrary content keyed by sha256 digest.
Use it for anything large or binary — model outputs, fetched documents,
generated artifacts, the object layer for a custom git-like format.

**Metadata via RPC**:

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

`gatewayFetch` prefixes `GATEWAY_URL`. Worker identity is attached by the
runtime proxy layer, so route `caller-token` auth sees the verified worker
caller without a JavaScript-visible token.

`blobstore.delete` and `blobstore.list` are restricted to shell/server callers
and cannot be invoked from a worker — design the upper layer (e.g. a server
service) to own GC.

See [`docs/architecture/storage.md`](../../../docs/architecture/storage.md#blobstore-content-addressable-objects)
for the full design.

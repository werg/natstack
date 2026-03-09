# Workers Development Guide

Workers are stateless fetch handlers running in workerd (Cloudflare's V8 isolate runtime). They execute outside Node.js and the browser, in a lightweight sandbox with per-request resource limits.

## Quick Start

```typescript
// workers/hello/index.ts
import { createWorkerRuntime } from "@workspace/runtime/worker";
import type { WorkerEnv, ExecutionContext } from "@workspace/runtime/worker";

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);
    const tree = await runtime.getWorkspaceTree();
    return Response.json(tree);
  },
};
```

```json
// workers/hello/package.json
{
  "name": "@workspace-workers/hello",
  "private": true,
  "type": "module",
  "natstack": { "type": "worker", "entry": "index.ts", "title": "Hello Worker" },
  "dependencies": {
    "@workspace/runtime": "workspace:*"
  }
}
```

## Worker Runtime API

`createWorkerRuntime(env)` returns a `WorkerRuntime` with:

| API | Description |
|-----|-------------|
| `runtime.rpc` | RPC bridge for calling services and other callers |
| `runtime.db` | Database client (`runtime.db.open(name)`) |
| `runtime.fs` | Filesystem access (RPC-backed, scoped to context) |
| `runtime.workers` | Typed client for managing other worker instances |
| `runtime.callMain(method, ...args)` | Call a server-side service method |
| `runtime.getWorkspaceTree()` | Get the workspace file tree |
| `runtime.listBranches(repoPath)` | List git branches |
| `runtime.listCommits(repoPath)` | List git commits |
| `runtime.exposeMethod(name, fn)` | Expose an RPC method callable by panels/workers |
| `runtime.contextId` | Context ID for storage partition |
| `runtime.id` | Worker instance name |

The runtime is cached per worker — multiple `fetch()` calls reuse the same WebSocket connection.

## WorkerEnv Bindings

workerd injects these bindings automatically:

| Binding | Type | Description |
|---------|------|-------------|
| `RPC_WS_URL` | string | WebSocket endpoint for RPC |
| `RPC_AUTH_TOKEN` | string | Auth token for handshake |
| `WORKER_ID` | string | Instance name (e.g., `"hello"`) |
| `CONTEXT_ID` | string | Context ID for storage partition |
| `STATE_ARGS` | object | Parsed JSON state args (if provided at creation) |

User-defined `env` and `bindings` from `workers.create()` are also available on `env`.

## Worker Management Client

Available on every runtime as `runtime.workers` (panels and workers). Also importable standalone:

```typescript
import { createWorkerdClient } from "@workspace/runtime/workerd-client";
```

### Create a Worker

```typescript
const instance = await runtime.workers.create({
  source: "workers/hello",
  contextId: "ctx-1",
  limits: { cpuMs: 100, subrequests: 10 },  // limits are mandatory
  name: "my-hello",         // optional, defaults to source basename
  env: { API_KEY: "..." },  // optional text bindings
  pin: true,                // optional, pin to current build version
});
```

### Full API

| Method | Description |
|--------|-------------|
| `workers.create(options)` | Create a new worker instance (limits required) |
| `workers.destroy(name)` | Destroy an instance |
| `workers.update(name, updates)` | Update env/bindings/limits, triggers restart |
| `workers.list()` | List all instances |
| `workers.status(name)` | Get instance status (null if not found) |
| `workers.listSources()` | List available worker sources from build graph |
| `workers.getPort()` | Get the workerd HTTP port |
| `workers.restartAll()` | Restart all instances |

### Resource Limits

Limits are **mandatory** when creating workers. workerd enforces them per request:

| Limit | Type | Description |
|-------|------|-------------|
| `cpuMs` | number (required) | CPU time limit per request in milliseconds |
| `subrequests` | number (optional) | Max outbound fetch requests per invocation |

### Pinning

Pinned instances (`pin: true`) snapshot their bundle at creation and never auto-update when the source is rebuilt. Use pinning for stability — unpinned instances auto-restart on push.

```typescript
// Pin to current build
await runtime.workers.update("my-hello", { pin: true });

// Unpin — will use latest build on next restart
await runtime.workers.update("my-hello", { pin: false });
```

## Cross-Caller RPC

Workers can communicate with panels, other workers, and the server via the unified `ws:route` protocol:

```typescript
// Worker exposing a method
runtime.exposeMethod("getStatus", async () => {
  return { healthy: true, uptime: process.uptime() };
});

// Panel calling that worker
const status = await rpc.call("worker:hello", "getStatus");
```

Routing rules:
- **Panel → Panel**: requires ancestor/descendant relationship
- **Panel → Worker**: always allowed (workers are server-managed)
- **Worker → any**: always allowed
- **Worker → Server services**: via `runtime.callMain()` or `runtime.rpc.call("main", ...)`

## Build System

Workers are built by the same build system as panels and agents:

- **Platform**: `neutral` (not browser, not node — workerd V8 isolates)
- **Format**: ESM, single bundle (no code splitting)
- **Conditions**: `["worker", "workerd", "import", "default"]`
- **Externals**: None — all dependencies bundled inline (workerd has no module resolution)
- **Source**: `workspace/workers/{name}/`
- **Scope**: `@workspace-workers/`

Workers are auto-discovered by the package graph and built on push, just like panels.

## Differences from Panels

| Aspect | Panel | Worker |
|--------|-------|--------|
| Runtime | Browser (Chromium webview) | workerd (V8 isolate) |
| Entry | React component or HTML | `export default { fetch() }` |
| UI | Yes (DOM, CSS, React) | No (HTTP responses only) |
| Platform | `browser` | `neutral` |
| Code splitting | Yes | No (single bundle) |
| Externals | Import maps | None (all inlined) |
| Lifecycle | Managed by panel system | Managed by WorkerdManager |
| State | Session storage, stateArgs | Stateless (per-request) |
| Resource limits | None | CPU time, subrequests |

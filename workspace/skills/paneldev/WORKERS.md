# Workers Development Guide

Workers are fetch handlers running in workerd (Cloudflare's V8 isolate runtime). They execute outside Node.js and the browser in a lightweight sandbox. This stack does not expose built-in per-instance CPU or subrequest limits. Workers come in two flavors:

1. **Stateless workers** — simple fetch handlers for HTTP endpoints
2. **Durable Object (DO) workers** — stateful agents extending `AgentWorkerBase`. NatStack runs Pi (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`) in-process inside each agent worker; there is no harness child process layer. See `docs/pi-architecture.md` for the full picture.

## 1. Quick Start

### Stateless Worker

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
  "natstack": { "entry": "index.ts", "title": "Hello Worker" },
  "dependencies": {
    "@workspace/runtime": "workspace:*"
  }
}
```

### Agentic DO Worker

```typescript
// workers/my-agent/index.ts
export { MyAgentWorker } from "./my-agent-worker.js";
export default { fetch(_req: Request) { return new Response("my-agent DO service"); } };
```

```json
// workers/my-agent/package.json
{
  "name": "@workspace-workers/my-agent",
  "natstack": {
    "entry": "index.ts",
    "durable": {
      "classes": [{ "className": "MyAgentWorker" }]
    }
  },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/agentic-do": "workspace:*",
    "@natstack/harness": "workspace:*"
  }
}
```

The `durable.classes` array declares which exported classes are DurableObjects. The `className` must match the exported class name exactly.

## 2. Worker Runtime API

`createWorkerRuntime(env)` returns a `WorkerRuntime` with:

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
| `oauth` | namespace | `getToken`, `getConnection`, `listConnections`, `listProviders`, `connect`, `requestConsent`, `startAuth`, `waitForConnection`, `disconnect`, `listConsents` |  |
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

The runtime is cached per worker -- multiple `fetch()` calls reuse the same WebSocket connection.

## 3. AgentWorkerBase — The DO Base Class

All agentic workers extend `AgentWorkerBase` from `@workspace/agentic-do`. The
base owns one Pi `AgentSession` per channel via `PiRunner`; you typically
only override identity and (optionally) the model/thinking-level hooks. The
base's default `onChannelEvent` forwards user messages to the runner; Pi
streams events back; the base forwards them to the channel as ephemeral
state-snapshot + text-delta messages.

```typescript
import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@natstack/harness";

export class MyWorker extends AgentWorkerBase {
  static override schemaVersion = 1;

  protected override getParticipantInfo(): ParticipantDescriptor {
    return {
      handle: "my-worker",
      name: "My Worker",
      type: "agent",
      methods: [],
    };
  }

  // Optional model override:
  // protected override getModel() { return "anthropic:claude-opus-4-5"; }
}
```

### Customization hooks

| Hook | Default | Purpose |
|------|---------|---------|
| `getModel()` | `"anthropic:claude-sonnet-4-20250514"` | Model id in `provider:model` format |
| `getThinkingLevel()` | `"medium"` | Pi thinking level (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`) |
| `getApprovalLevel(channelId)` | `2` (full auto) | Tool approval level: 0=ask all, 1=auto safe, 2=full auto |
| `shouldProcess(event)` | Panel messages only | Filter which events trigger AI turns |
| `buildTurnInput(event)` | Extracts content/senderId | Transform event to TurnInput |
| `getParticipantInfo()` | Generic agent identity | Channel handle, name, methods |

The system prompt lives in `workspace/AGENTS.md` and is read via the
`workspace.*` RPC service. To customize, edit that file.

## 4. Direct Communication APIs

DOs are autonomous -- they call channel and server APIs directly. Channel operations go through `ChannelClient` (wraps `callDO()` to talk directly to the Channel DO via `stub.fetch()`). No action-return pattern.

### Channel Operations -- `this.createChannelClient(channelId)`

Create a `ChannelClient` for a specific channel, then call methods on it:

```typescript
const channel = this.createChannelClient(channelId);
```

| Method | Description |
|--------|-------------|
| `channel.send(participantId, messageId, content, opts?)` | Send a new message |
| `channel.update(participantId, messageId, content)` | Update a streaming message |
| `channel.complete(participantId, messageId)` | Mark a message as complete |
| `channel.sendEphemeral(participantId, content, contentType?)` | Send ephemeral event |
| `channel.sendEphemeralEvent(participantId, contentType, payload)` | Send a typed structured ephemeral (JSON-encoded) |
| `channel.updateMetadata(participantId, metadata)` | Update channel metadata |
| `channel.subscribe(participantId, metadata)` | Subscribe to channel |
| `channel.unsubscribe(participantId)` | Unsubscribe from channel |
| `channel.callMethod(callerPid, targetPid, callId, method, args)` | Async method call |
| `channel.getParticipants()` | Get channel roster |

## 5. SQLite Tables (AgentWorkerBase Internals)

Pi tracks turn state, message state, and session branching itself inside
`AgentSession`. The base class only owns these few tables:

| Table | Purpose |
|-------|---------|
| `state` | Key-value store (approval level per channel, fork metadata) |
| `subscriptions` | Channel subscriptions + participant ID |
| `pi_sessions` | Per-channel Pi session JSONL file path (for restart resume) |
| `delivery_cursor` | Last-processed channel event id (dedup + gap detection) |
| `pending_calls` | Promise continuations for tool callMethod and UI feedback_form awaits |

### Schema Versioning

Override `static schemaVersion` to trigger table re-creation:

```typescript
export class MyWorker extends AgentWorkerBase {
  static schemaVersion = 2; // bump when schema changes
}
```

### Key Helpers

| Method | Description |
|--------|-------------|
| `getActiveHarness()` | Get the active harness ID |
| `getContextId(channelId)` | Get context ID from subscription |
| `getSubscriptionConfig(channelId)` | Get per-channel config |
| `setActiveTurn() / getActiveTurn() / clearActiveTurn()` | Turn state (includes `senderParticipantId`) |
| `setInFlightTurn() / getInFlightTurn() / clearInFlightTurn()` | In-flight turn |
| `advanceCheckpoint() / getCheckpoint()` | Checkpoint tracking |
| `recordTurn()` | Record completed turn |
| `getResumeSessionId(harnessId)` | Get session ID for resume |
| `getResumeSessionIdForChannel(channelId)` | Get resume session (prefers forkSessionId if set) |
| `recordTurnStart(harnessId, channelId, input, messageId, pubsubId, senderParticipantId?)` | Convenience: set active + in-flight + checkpoint |
| `pendingCall(callId, channelId, type, context)` | Store async call continuation (survives hibernation) |
| `consumePendingCall(callId)` | Load and delete a continuation |
| `getParticipantId(channelId)` | Get this DO's channel participant ID |

### Additional Hooks (override in subclass)

| Hook | Default | Purpose |
|------|---------|---------|
| `handleCallResult(type, context, channelId, result, isError)` | no-op | Handle async method-call results (used for approval/tool-call flow) |
| `onMethodCall(channelId, callId, methodName, args)` | returns error | Handle incoming method calls from other participants |
| `onPostClone(parentObjectKey, newChannelId, oldChannelId, forkPointPubsubId)` | no-op | Custom cleanup after fork clone (see Fork Support below) |

### Fork Support

AgentWorkerBase supports semantic conversation forking — cloning at a specific point so the fork resumes independently.

| Method | Description |
|--------|-------------|
| `canFork()` | Preflight: returns `{ ok: true }` if single-channel, rejects multi-channel agents |
| `postClone(parentObjectKey, newChannelId, oldChannelId, forkPointMessageId)` | Post-clone cleanup on the new DO: fixes identity, migrates pi_sessions row, clears ephemeral state, resubscribes to forked channel |

**`postClone()` sequence**: fix `__objectKey` → record fork metadata → migrate `pi_sessions` row (oldChannelId → newChannelId, truncate messages_blob at fork point) → rename approval keys → clear ephemeral state → delete old subscription + resubscribe to forked channel → call `onPostClone()`.

**Resume after fork**: the cloned DO's `getOrCreateRunner()` restores messages from the truncated `messages_blob`, creating a fresh `Agent` with the forked conversation history. No harness respawn or session-file management.

**Fork worker** (`workspace/workers/fork/`): stateless fetch handler that orchestrates forks. Uses platform RPC primitives (`workerd.cloneDO`, `workerd.destroyDO`) for filesystem ops and `fetch()` for DO method calls (`canFork`, `postClone`, `subscribeChannel`). Trigger: `POST /fork` with `{ channelId, forkPointPubsubId, exclude?, replace? }`. Rolls back cloned SQLite and replacement subscriptions on failure.

### Tool Approval via the Approval Gate Extension

Tool approval is handled by the **approval-gate extension** (`packages/harness/src/extensions/approval-gate.ts`). The extension intercepts `tool_call` events before tool execution and checks the approval level:

- **Level 2 (Full Auto)**: all tools run without prompts (default)
- **Level 1 (Auto Safe)**: read-only tools (`read`, `ls`, `grep`, `find`) auto-approve; others get a UI confirm prompt via the `NatStackExtensionUIContext` bridge
- **Level 0 (Ask All)**: every tool call gets a confirm prompt

The approval level is read lazily via a closure-bound getter so the worker can change it mid-conversation (e.g., when the channel config updates).

```typescript
// The approval gate is wired automatically by PiRunner. To customize
// the approval level per channel:
protected override getApprovalLevel(channelId: string): ApprovalLevel {
  // 0 = ask all, 1 = auto-safe, 2 = full auto
  return 2;
}
```

Under the hood, PiRunner wraps each tool's `execute()` to consult the extension runtime's `tool_call` handlers first. If a handler returns `{ block: true, reason }`, the wrapper throws an error which pi-agent-core's loop catches and feeds to the LLM as an error tool result. No continuation store or harness commands — the extension runs in-process.

## 7. Testing with createTestDO()

`createTestDO()` creates a DO instance backed by in-memory SQLite (sql.js / WASM), eliminating the need for workerd or native modules in unit tests:

```typescript
import { describe, it, expect } from "vitest";
import { createTestDO } from "@workspace/runtime/worker";
import { MyWorker } from "./my-worker.js";

describe("MyWorker", () => {
  it("initializes PiRunner on first message", async () => {
    const { instance, sql } = await createTestDO(MyWorker);
    await instance.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" });

    const event = {
      id: 1, messageId: "msg-1", type: "message",
      payload: { content: "Hello" }, senderId: "user-1",
      senderMetadata: { type: "panel" }, ts: Date.now(), persist: true,
    };

    // onChannelEvent: shouldProcess → buildTurnInput → getOrCreateRunner → runTurn
    await instance.onChannelEvent("ch-1", event);
  });
});
```

The `sql` object allows direct database inspection:

```typescript
const rows = sql.exec(`SELECT * FROM pi_sessions`).toArray();
expect(rows).toHaveLength(1);
```

Run tests with `pnpm test` (not `npx vitest run`).

## 8. Debugging

In development, the server exposes a debug endpoint for inspecting DO state:

```
GET /_do/:className/:objectKey/state
```

This calls `getState()` on the DO and returns all table contents as JSON:

```json
{
  "subscriptions": [...],
  "piSessions": [...],
  "pendingCalls": [...],
  "deliveryCursors": [...]
}
```

## 9. Per-Channel Config

Subscription config is passed during `subscribeChannel()` and stored in the `subscriptions` table:

```typescript
await instance.subscribeChannel({
  channelId: "ch-1",
  contextId: "ctx-1",
  config: { model: "claude-4", temperature: 0.3 },
});
```

Access it in your hooks:

```typescript
const config = this.getSubscriptionConfig(channelId);
if (config?.model) {
  // use per-channel model override
}
```

Subscription config can override `model` and `thinkingLevel` via `extraConfig`. The system prompt comes from `workspace/AGENTS.md` (loaded via `workspace.getAgentsMd` RPC). Tools are dynamically discovered from channel participants via the channel-tools extension.

## Headless Agentic Sessions

To run an agentic session without a chat panel (from a worker, test harness, or server), use `@workspace/agentic-session`. See the **headless-sessions** skill for full documentation.

```typescript
import { HeadlessSession, createRpcSandboxConfig } from "@workspace/agentic-session";

const session = await HeadlessSession.createWithAgent({
  config: { serverUrl: pubsubUrl, token, clientId: `worker-${objectKey}` },
  sandbox: createRpcSandboxConfig(rpc),
  rpcCall: (t, m, ...a) => rpc.call(t, m, ...a),
  source: "agent-worker",
  className: "AiChatWorker",
  contextId,
});

await session.send("Analyze the data in scope.dataset");
const response = await session.waitForAgentMessage();
await session.close();
```

## 10. Creating Workers with paneldev

Use the paneldev skill to scaffold new workers:

### Stateless Worker

```
create-project --type worker --name my-api
```

Creates a standard fetch handler worker with `index.ts` and `package.json`.

### Agentic DO Worker

```
create-project --type worker --name my-agent --template agentic
```

Creates a full DO worker scaffold with:
- `package.json` with `durable.classes` declaration
- `index.ts` with DO class export + default fetch handler
- `my-agent-worker.ts` with DO class extending `AgentWorkerBase`, all 5 hooks stubbed and commented
- `my-agent-worker.test.ts` using `createTestDO()` with sample event + assertion

## WorkerEnv Bindings

workerd injects these bindings automatically:

| Binding | Type | Description |
|---------|------|-------------|
| `SERVER_URL` | string | HTTP base URL for the RPC server |
| `RPC_AUTH_TOKEN` | string | Auth token for handshake |
| `WORKER_ID` | string | Instance name (e.g., `"hello"`) |
| `CONTEXT_ID` | string | Context ID for storage partition |
| `STATE_ARGS` | object | Parsed JSON state args (if provided at creation) |

User-defined `env` and `bindings` from `workers.create()` are also available on `env`.

## Worker Management Client

Available on every runtime as `runtime.workers` (panels and workers):

```typescript
import { createWorkerdClient } from "@workspace/runtime/workerd-client";
```

| Method | Description |
|--------|-------------|
| `workers.create(options)` | Create a new worker instance |
| `workers.destroy(name)` | Destroy an instance |
| `workers.update(name, updates)` | Update env/bindings/ref, triggers restart |
| `workers.list()` | List all instances |
| `workers.status(name)` | Get instance status (null if not found) |
| `workers.listInstanceSources()` | List available worker-instance sources from build graph |
| `workers.getPort()` | Get the workerd HTTP port |
| `workers.restartAll()` | Restart all instances |

workerd OSS does not support per-instance CPU or subrequest limits in the generated worker config. If you need request-level execution bounds in this stack, enforce them in application code with wrappers such as `AbortSignal.timeout(...)`.

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

## Build System

Workers are built by the same build system as panels and agents:

- **Platform**: `neutral` (not browser, not node -- workerd V8 isolates)
- **Format**: ESM, single bundle (no code splitting)
- **Conditions**: `["worker", "workerd", "import", "default"]`
- **Externals**: None -- all dependencies bundled inline (workerd has no module resolution)
- **Source**: `workspace/workers/{name}/`
- **Scope**: `@workspace-workers/`

Workers are auto-discovered by the package graph and built on push, just like panels.

## Differences from Panels

| Aspect | Panel | Worker |
|--------|-------|--------|
| Runtime | Browser (Chromium webview) | workerd (V8 isolate) |
| Entry | React component or HTML | `export default { fetch() }` or DO class |
| UI | Yes (DOM, CSS, React) | No (HTTP responses only) |
| Platform | `browser` | `neutral` |
| Code splitting | Yes | No (single bundle) |
| Externals | Import maps | None (all inlined) |
| Lifecycle | Managed by panel system | Managed by WorkerdManager |
| State | Session storage, stateArgs | Stateless or SQLite (DO) |
| Resource limits | None | None built in |

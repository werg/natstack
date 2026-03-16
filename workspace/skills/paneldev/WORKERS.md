# Workers Development Guide

Workers are fetch handlers running in workerd (Cloudflare's V8 isolate runtime). They execute outside Node.js and the browser, in a lightweight sandbox with per-request resource limits. Workers come in two flavors:

1. **Stateless workers** — simple fetch handlers for HTTP endpoints
2. **Durable Object (DO) workers** — stateful agents with SQLite-backed state, channel subscriptions, and harness management

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
  "natstack": { "type": "worker", "entry": "index.ts", "title": "Hello Worker" },
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
    "type": "worker",
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

The runtime is cached per worker -- multiple `fetch()` calls reuse the same WebSocket connection.

## 3. AgentWorkerBase — The DO Base Class

All agentic workers extend `AgentWorkerBase` from `@workspace/agentic-do`:

```typescript
import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ChannelEvent, HarnessOutput } from "@natstack/harness";

export class MyWorker extends AgentWorkerBase {
  static schemaVersion = 1;

  async onChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    // Handle event — call this.pubsub.* and this.server.* directly
  }

  async onHarnessEvent(harnessId: string, event: HarnessOutput): Promise<void> {
    // Handle harness output — call this.pubsub.* and this.server.* directly
  }
}
```

### The Five Hooks

| Hook | Default | Purpose |
|------|---------|---------|
| `getHarnessType()` | `'claude-sdk'` | Which AI provider to use |
| `getHarnessConfig()` | `{}` | System prompt, model, temperature, MCP servers |
| `shouldProcess(event)` | Panel messages only | Filter which events trigger AI turns |
| `buildTurnInput(event)` | Extracts content/senderId | Transform event to TurnInput |
| `getParticipantInfo()` | Generic agent identity | PubSub handle, name, methods |

## 4. Direct Communication APIs

DOs are autonomous -- they call PubSub and server APIs directly via HTTP POST. No action-return pattern.

### PubSub Operations -- `this.pubsub`

| Method | Description |
|--------|-------------|
| `.send(participantId, channelId, messageId, content, opts?)` | Send a new message |
| `.update(participantId, channelId, messageId, content)` | Update a streaming message |
| `.complete(participantId, channelId, messageId)` | Mark a message as complete |
| `.sendEphemeral(participantId, channelId, content, contentType?)` | Send ephemeral event |
| `.updateMetadata(participantId, channelId, metadata)` | Update channel metadata |
| `.subscribe(channelId, participantId, metadata)` | Subscribe to channel |
| `.unsubscribe(channelId, participantId)` | Unsubscribe from channel |
| `.callMethod(channelId, callerPid, targetPid, callId, method, args)` | Async method call |
| `.getParticipants(channelId)` | Get channel roster |

### Server Operations -- `this.server`

| Method | Description |
|--------|-------------|
| `.spawnHarness(opts)` | Spawn a new harness process |
| `.sendHarnessCommand(harnessId, command)` | Send command to harness (start-turn, approve-tool, interrupt, etc.) |
| `.stopHarness(harnessId)` | Stop a harness process |
| `.forkChannel(doRef, sourceChannel, forkPointId)` | Fork a channel |

### StreamWriter -- `this.createWriter(channelId, turn)`

```typescript
const turn = this.getActiveTurn(harnessId);
if (turn) {
  const writer = this.createWriter(channelId, turn);
  await writer.startText();           // sends a new message
  await writer.updateText("chunk");   // updates content
  await writer.completeText();        // marks complete
  this.persistStreamState(harnessId, writer);
}
```

## 5. StreamWriter

All StreamWriter methods are async (HTTP calls to PubSub):

| Method | Description |
|--------|-------------|
| `startThinking()` / `updateThinking(content)` / `endThinking()` | Thinking block lifecycle |
| `startText(metadata?)` / `updateText(content)` / `completeText()` | Text message lifecycle |
| `startAction(tool, description, toolUseId?)` / `endAction()` | Tool action lifecycle |
| `sendInlineUi(data)` | Send inline UI component |
| `startTyping()` / `stopTyping()` | Typing indicator lifecycle |

Call `this.persistStreamState(harnessId, writer)` after using the writer to save message IDs to SQLite.

## 6. SQLite Tables (AgentWorkerBase Internals)

The base class creates 8 tables on initialization:

| Table | Purpose |
|-------|---------|
| `state` | Key-value store (schema version, custom state) |
| `subscriptions` | Channel subscriptions with config + participant ID |
| `harnesses` | Harness instances (id, type, channel, status) |
| `turn_map` | Completed turn records for fork resolution |
| `checkpoints` | Last-processed pubsub ID per channel/harness |
| `in_flight_turns` | Currently executing turns (for crash retry) |
| `active_turns` | Currently streaming turns (replyToId, turnMessageId, senderParticipantId) |
| `pending_calls` | Continuation state for async method calls (survives hibernation) |

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
| `getHarnessForChannel(channelId)` | Find active harness for a channel |
| `getChannelForHarness(harnessId)` | Find channel for a harness |
| `getContextId(channelId)` | Get context ID from subscription |
| `getSubscriptionConfig(channelId)` | Get per-channel config |
| `setActiveTurn() / getActiveTurn() / clearActiveTurn()` | Turn state (includes `senderParticipantId`) |
| `setInFlightTurn() / getInFlightTurn() / clearInFlightTurn()` | In-flight turn |
| `advanceCheckpoint() / getCheckpoint()` | Checkpoint tracking |
| `recordTurn()` | Record completed turn |
| `getResumeSessionId(harnessId)` | Get session ID for resume |
| `recordTurnStart(harnessId, channelId, input, messageId, pubsubId, senderParticipantId?)` | Convenience: set active + in-flight + checkpoint |
| `pendingCall(callId, channelId, type, context)` | Store async call continuation (survives hibernation) |
| `consumePendingCall(callId)` | Load and delete a continuation |
| `getParticipantId(channelId)` | Get this DO's PubSub participant ID |

### Additional Hooks (override in subclass)

| Hook | Default | Purpose |
|------|---------|---------|
| `handleCallResult(type, context, channelId, result, isError)` | no-op | Handle async method-call results (used for approval/tool-call flow) |
| `onMethodCall(channelId, callId, methodName, args)` | returns error | Handle incoming method calls from other participants |
| `onChannelForked(sourceChannel, forkedChannelId, forkPointId)` | no-op | Called when a channel fork completes |

### Tool Approval via Continuations

Tool approval uses the **async continuation pattern** -- the DO stores pending call state in SQLite (survives hibernation), calls PubSub's `callMethod` (async), and receives the result via POST-back to `onCallResult()` → `handleCallResult()`.

```typescript
// In your onHarnessEvent handler for "approval-needed":
case "approval-needed": {
  const callId = crypto.randomUUID();
  const turn = this.getActiveTurn(harnessId);
  const panelId = turn?.senderParticipantId;
  if (!panelId) {
    await this.server.sendHarnessCommand(harnessId, {
      type: "approve-tool", toolUseId: event.toolUseId, allow: false,
    });
    break;
  }
  // Store continuation in SQLite (survives hibernation)
  this.pendingCall(callId, channelId, 'approval', {
    harnessId, toolUseId: event.toolUseId,
  });
  // Async call via PubSub — result arrives at onCallResult
  await this.pubsub.callMethod(
    channelId,
    this.getParticipantId(channelId)!,
    panelId, callId, 'request_tool_approval',
    { agentId: this.getParticipantId(channelId), toolName: event.toolName, toolArgs: event.input },
  );
  break;
}
```

```typescript
// Override handleCallResult to process the approval response:
protected override async handleCallResult(
  type: string, context: Record<string, unknown>,
  channelId: string, result: unknown, isError: boolean,
): Promise<void> {
  if (type === 'approval') {
    const { harnessId, toolUseId } = context as { harnessId: string; toolUseId: string };
    let allow = false;
    if (!isError && result && typeof result === 'object') {
      allow = (result as Record<string, unknown>)["allow"] === true;
    }
    await this.server.sendHarnessCommand(harnessId, {
      type: "approve-tool", toolUseId, allow,
    });
  }
}
```

The built-in `AiChatWorker` implements this pattern -- see `workspace/workers/agent-worker/ai-chat-worker.ts` for the full reference implementation.

## 7. Testing with createTestDO()

`createTestDO()` creates a DO instance backed by in-memory SQLite (sql.js / WASM), eliminating the need for workerd or native modules in unit tests:

```typescript
import { describe, it, expect } from "vitest";
import { createTestDO } from "@workspace/runtime/worker";
import { MyWorker } from "./my-worker.js";

describe("MyWorker", () => {
  it("spawns harness on first message", async () => {
    const { instance, sql } = await createTestDO(MyWorker);
    await instance.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" });

    const event = {
      id: 1, messageId: "msg-1", type: "message",
      payload: { content: "Hello" }, senderId: "user-1",
      senderType: "panel", ts: Date.now(), persist: true,
    };

    // onChannelEvent returns void — side effects happen via direct HTTP calls
    await instance.onChannelEvent("ch-1", event);
  });
});
```

The `sql` object allows direct database inspection:

```typescript
const rows = sql.exec(`SELECT * FROM active_turns`).toArray();
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
  "harnesses": [...],
  "activeTurns": [...],
  "checkpoints": [...],
  "inFlightTurns": [...],
  "pendingCalls": [...]
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

The built-in `AiChatWorker` merges subscription config with `getHarnessConfig()` automatically -- per-channel overrides for `systemPrompt`, `model`, `temperature`, and `maxTokens` take precedence.

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
| `RPC_WS_URL` | string | WebSocket endpoint for RPC |
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
| `workers.create(options)` | Create a new worker instance (limits required) |
| `workers.destroy(name)` | Destroy an instance |
| `workers.update(name, updates)` | Update env/bindings/limits, triggers restart |
| `workers.list()` | List all instances |
| `workers.status(name)` | Get instance status (null if not found) |
| `workers.listSources()` | List available worker sources from build graph |
| `workers.getPort()` | Get the workerd HTTP port |
| `workers.restartAll()` | Restart all instances |

### Resource Limits

Limits are **mandatory** when creating workers:

| Limit | Type | Description |
|-------|------|-------------|
| `cpuMs` | number (required) | CPU time limit per request in milliseconds |
| `subrequests` | number (optional) | Max outbound fetch requests per invocation |

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
| Resource limits | None | CPU time, subrequests |

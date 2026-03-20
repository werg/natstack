# Agentic Architecture: Channels, Workers, and Harnesses

## Overview

NatStack's agentic system is a 3-layer server-side architecture:

```
Panel (browser)          Channel DO (workerd)     Worker DO (workerd)          Harness (Node.js)
     │                        │                        │                          │
     │── user message ───────►│── callback event ──────►│                          │
     │                        │                        │── spawnHarness ──────────►│
     │                        │                        │── startTurn(input) ──────►│
     │                        │◄── send/update ────────│◄── text-delta ───────────│
     │◄── channel message ────│                        │                          │
     │                        │                        │◄── approval-needed ──────│
     │                        │◄── callMethod ─────────│   (store continuation)   │
     │── method-result ──────►│── onCallResult ───────►│── approveTool ──────────►│
     │                        │                        │◄── turn-complete ────────│
```

- **Channels** — Channel DOs with forkable history and SQLite-backed message storage
- **Workers** — Durable Objects in workerd with SQLite state, calling Channel DOs directly via `callDO()`
- **Harnesses** — Node.js child processes running AI SDKs (Claude, Pi), communicating via bidirectional RPC

## Key Design Principle: Autonomous DOs with Direct Calls

DOs call Channel DOs (via `callDO()` / `stub.fetch()`) and server APIs directly. All event handlers return `void` — side effects happen inline via `this.createChannelClient(channelId).*` and `this.server.*` methods.

```typescript
async onChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
  if (!this.shouldProcess(event)) return;
  const input = this.buildTurnInput(event);
  const harnessId = `harness-${crypto.randomUUID()}`;
  this.registerHarness(harnessId, this.getHarnessType());
  this.recordTurnStart(harnessId, channelId, input, event.messageId, event.id);
  await this.server.spawnHarness({
    doRef: this.doRef, harnessId,
    type: this.getHarnessType(), contextId,
    config: this.getHarnessConfig(), initialInput: input,
  });
}
```

## Server-Side Components

### HarnessApi (`src/server/harnessApi.ts`)

HTTP endpoints called by DOs directly via fetch():
- `POST /harness/spawn` — spawn a new harness process
- `POST /harness/{id}/command` — send a command to a running harness
- `POST /harness/{id}/stop` — stop a harness process
- `POST /do/clone` — clone a DO's SQLite (self-class only)
- `POST /validate-token` — validate a caller token, returns identity

### DODispatch (`src/server/doDispatch.ts`)

Source-scoped HTTP dispatch to Durable Objects via `/_w/{source}/{className}/{objectKey}/{method}`.

### HarnessManager (`src/server/harnessManager.ts`)

Spawns and tracks Node.js child processes. Each harness:
1. Gets environment vars (RPC_WS_URL, AUTH_TOKEN, HARNESS_ID, CHANNEL_ID, etc.)
2. Connects back via WebSocket
3. Authenticates and creates an RPC bridge
4. Pushes `HarnessOutput` events to its owning DO via DODispatch

## DO Base Classes

**DurableObjectBase** — generic DO foundation (~150 lines).
Location: `workspace/packages/runtime/src/worker/durable-base.ts`

**AgentWorkerBase** — agent composition shell extending DurableObjectBase.
Location: `workspace/packages/agentic-do/src/agent-worker-base.ts`

### Five Customization Hooks

| Hook | Default | Purpose |
|------|---------|---------|
| `getHarnessType()` | `'claude-sdk'` | AI provider |
| `getHarnessConfig()` | `{}` | System prompt, model, toolAllowlist |
| `shouldProcess(event)` | Panel messages only | Filter events |
| `buildTurnInput(event)` | Extract content | Transform to TurnInput |
| `getParticipantInfo()` | Generic agent | Channel identity + methods |

### SQLite Tables (8 total)

| Table | Purpose |
|-------|---------|
| `state` | Key-value store |
| `subscriptions` | Channel subscriptions + participant ID |
| `harnesses` | Harness lifecycle (status, session ID) |
| `turn_map` | Completed turns for fork resolution |
| `checkpoints` | Last-processed event ID |
| `in_flight_turns` | In-progress turns for crash retry |
| `active_turns` | Streaming state (replyToId, senderParticipantId, streamState) |
| `pending_calls` | Async call continuations (survives hibernation) |

### Additional Override Hooks

| Hook | Purpose |
|------|---------|
| `handleCallResult()` | Process method-call results (approval flow) |
| `onMethodCall()` | Handle incoming method calls |
| `alarm()` | Handle timer callbacks (inherited from DurableObjectBase) |

## Flows

### First User Message

```
Panel sends message → Channel DO → callback to Worker DO → onChannelEvent()
  1. shouldProcess() → true
  2. getActiveHarness() → null (no harness yet)
  3. registerHarness() + recordTurnStart() locally
  4. Send bootstrap typing indicator via channel.send()
  5. Call this.server.spawnHarness() with initialInput

Server handles /harness/spawn:
  1. Ensure context folder
  2. Fork Node.js process
  3. Wait for WebSocket authentication
  4. Notify DO: onHarnessEvent("ready")
  5. Fire-and-forget: bridge.startTurn(initialInput)
```

### Subsequent Messages

```
Panel sends message → Channel DO → callback to Worker DO → onChannelEvent()
  1. getActiveHarness() → harnessId
  2. Start typing via StreamWriter, call this.server.sendHarnessCommand(start-turn)
  3. Record active_turn + in_flight_turn
```

### Streaming Response

```
Harness emits events → DODispatch → DO.onHarnessEvent()
  text-start     → writer.startText()     → channel send (new message)
  text-delta     → writer.updateText()    → channel update
  text-end       → writer.completeText()  → channel complete
  turn-complete  → record turn, clear state
```

### Tool Approval (Continuation-Based)

```
Harness: approval-needed(toolUseId, toolName, input)
  → DO stores pendingCall(callId, "approval", {harnessId, toolUseId})
  → DO calls channel.callMethod(callId, panelId, "request_tool_approval", args)

Channel DO: routes callMethod to panel
Panel: request_tool_approval handler
  → checkToolApproval() for auto-approve
  → requestApproval() for UI prompt
  → returns {allow, alwaysAllow}

Channel DO: receives method-result → callDO back to Worker DO → onCallResult(callId, result)
  → consumePendingCall(callId) → handleCallResult("approval", ...)
  → DO calls this.server.sendHarnessCommand(approveTool)
```

### Crash Recovery

```
Harness process dies → HarnessManager detects exit → DODispatch
  → DO.onHarnessEvent(harnessId, {type: "error"})
  → Complete partial stream
  → Read in-flight turn for retry
  → reactivateHarness() + recordTurnStart() locally
  → Call this.server.spawnHarness() with resumeSessionId + initialInput
```

## RPC Services (Panel-Accessible)

| Service | Method | Purpose |
|---------|--------|---------|
| `workers` | `listSources` | Available worker DO classes |
| `workers` | `getChannelWorkers` | DOs subscribed to a channel |
| `workers` | `callDO` | Call a DO method (subscribe/unsubscribe) |
| `channel` | `fork` | Create a forked channel |
| `channel` | `callMethod` | Proxy harness→participant calls |
| `channel` | `discoverMethods` | List available methods |
| `harness` | `pushEvent` | Receive harness output events |

## Package Map

| Package | Location | Contents |
|---------|----------|----------|
| `@natstack/harness` | `packages/harness/` | Types (HarnessOutput, ChannelEvent), SDK adapters |
| `@natstack/pubsub` | `workspace/packages/pubsub/` | PubSubClient (panel-side), protocol types, approval schemas |
| `@workspace/runtime` | `workspace/packages/runtime/` | DurableObjectBase, ServerDOClient |
| `@workspace/agentic-do` | `workspace/packages/agentic-do/` | AgentWorkerBase, ChannelClient, StreamWriter, composable modules |
| Workers | `workspace/workers/` | DO implementations (agent-worker, test-agent) |

## Further Reading

- **Worker Authoring Guide**: `workspace/workers/README.md` — full annotated walkthrough with examples
- **Paneldev Skill**: `workspace/skills/paneldev/WORKERS.md` — reference for AI agents building workers
- **Harness Types**: `packages/harness/README.md` — HarnessOutput, HarnessCommand, WorkerAction type catalog
- **Channel Forking**: Channel DO handles fork semantics, replay, and schema internally

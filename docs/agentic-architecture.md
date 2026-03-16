# Agentic Architecture: Channels, Workers, and Harnesses

## Overview

NatStack's agentic system is a 3-layer server-side architecture:

```
Panel (browser)          PubSub Channel          Worker DO (workerd)          Harness (Node.js)
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

- **Channels** — PubSub messaging with forkable history
- **Workers** — Durable Objects in workerd with SQLite state, making direct HTTP calls
- **Harnesses** — Node.js child processes running AI SDKs (Claude, Pi), communicating via bidirectional RPC

## Key Design Principle: Autonomous DOs with Direct HTTP Calls

DOs make direct outbound HTTP calls to PubSub and server APIs. All event handlers return `void` — side effects happen inline via `this.pubsub.*` and `this.server.*` methods.

```typescript
async onChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
  if (!this.shouldProcess(event)) return;
  const input = this.buildTurnInput(event);
  await this.server.spawnHarness({
    doRef: this.doRef, harnessId: `harness-${crypto.randomUUID()}`,
    type: this.getHarnessType(), channelId, contextId,
    config: this.getHarnessConfig(), initialTurn: { input, ... },
  });
}
```

## Server-Side Components

### HarnessApi (`src/server/harnessApi.ts`)

HTTP endpoints called by DOs directly via fetch():
- `POST /harness/spawn` — spawn a new harness process
- `POST /harness/{id}/command` — send a command to a running harness
- `POST /harness/{id}/stop` — stop a harness process
- `POST /harness/fork-channel` — create a forked channel
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
| `getParticipantInfo()` | Generic agent | PubSub identity + methods |

### SQLite Tables (8 total)

| Table | Purpose |
|-------|---------|
| `state` | Key-value store |
| `subscriptions` | Channel subscriptions + participant ID |
| `harnesses` | Harness lifecycle (status, session ID) |
| `turn_map` | Completed turns for fork resolution |
| `checkpoints` | Last-processed pubsub ID |
| `in_flight_turns` | In-progress turns for crash retry |
| `active_turns` | Streaming state (replyToId, senderParticipantId, streamState) |
| `pending_calls` | Async call continuations (survives hibernation) |

### Additional Override Hooks

| Hook | Purpose |
|------|---------|
| `handleCallResult()` | Process method-call results (approval flow) |
| `onMethodCall()` | Handle incoming method calls |
| `onChannelForked()` | React to channel forks |
| `alarm()` | Handle timer callbacks (inherited from DurableObjectBase) |

## Flows

### First User Message

```
Panel sends message → PubSub → POST-back to DO → onChannelEvent()
  1. shouldProcess() → true
  2. getHarnessForChannel() → null (no harness yet)
  3. Send bootstrap typing indicator via this.pubsub.send()
  4. Call this.server.spawnHarness() with initialTurn

Server handles /harness/spawn:
  1. Register harness in DO via DODispatch
  2. Ensure context folder
  3. Fork Node.js process
  4. Wait for WebSocket authentication
  5. Notify DO: onHarnessEvent("ready")
  6. Record turn state in DO
  7. Fire-and-forget: bridge.startTurn(input)
```

### Subsequent Messages

```
Panel sends message → PubSub → POST-back to DO → onChannelEvent()
  1. getHarnessForChannel() → harnessId
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
  → DO returns callMethod(callId, panelId, "request_tool_approval", args)

DO: this.pubsub.callMethod() → broadcasts to panel via PubSub
Panel: request_tool_approval handler
  → checkToolApproval() for auto-approve
  → requestApproval() for UI prompt
  → returns {allow, alwaysAllow}

Server: receives method-result → DO.onCallResult(callId, result)
  → consumePendingCall(callId) → handleCallResult("approval", ...)
  → DO calls this.server.sendHarnessCommand(approveTool)
```

### Crash Recovery

```
Harness process dies → HarnessManager detects exit → DODispatch
  → DO.onHarnessEvent(harnessId, {type: "error"})
  → Complete partial stream
  → Read in-flight turn for retry
  → Call this.server.spawnHarness() with resumeSessionId + retryTurn
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
| `@natstack/pubsub` | `workspace/packages/pubsub/` | PubSubClient, protocol types, approval schemas |
| `@natstack/pubsub-server` | `packages/pubsub-server/` | PubSub server with channel forking |
| `@workspace/runtime` | `workspace/packages/runtime/` | DurableObjectBase, PubSubDOClient, ServerDOClient |
| `@workspace/agentic-do` | `workspace/packages/agentic-do/` | AgentWorkerBase, StreamWriter, composable modules |
| Workers | `workspace/workers/` | DO implementations (agent-worker, test-agent) |

## Further Reading

- **Worker Authoring Guide**: `workspace/workers/README.md` — full annotated walkthrough with examples
- **Paneldev Skill**: `workspace/skills/paneldev/WORKERS.md` — reference for AI agents building workers
- **Harness Types**: `packages/harness/README.md` — HarnessOutput, HarnessCommand, WorkerAction type catalog
- **Channel Forking**: `packages/pubsub-server/README.md` — fork semantics, replay, schema

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
- **Workers** — Durable Objects in workerd with SQLite state, returning actions for the server to execute
- **Harnesses** — Node.js child processes running AI SDKs (Claude, Pi), communicating via bidirectional RPC

## Key Design Principle: Action-Return Pattern

DOs never make outbound calls. Every DO method returns `WorkerActions` — a list of typed actions that the server executes. This keeps DOs stateless between invocations and makes all side effects explicit.

```typescript
async onChannelEvent(channelId, event): Promise<WorkerActions> {
  const $ = this.actions();
  $.channel(channelId).send("Hello");
  $.harness(harnessId).startTurn(input);
  $.spawnHarness({ type: "claude-sdk", channelId, contextId, initialTurn: {...} });
  return $.result();  // server executes these
}
```

Action types: channel operations (send, update, complete, call-method, method-result), harness commands (start-turn, approve-tool, interrupt), system operations (spawn-harness, respawn-harness, fork-channel, set-alarm).

## Server-Side Components

### PubSubFacade (`src/server/services/pubsubFacade.ts`)

Bridges DOs with PubSub channels. When a DO subscribes:
1. Registers a **callback participant** on the PubSub server (in-process, not WebSocket)
2. Events arrive via async queue (per-participant, ordered)
3. Dispatches events to DO via `WorkerRouter`
4. Executes returned `WorkerActions`

Also handles `callParticipantMethod()` with two paths:
- **DO → DO**: Direct dispatch via router
- **DO → Panel**: Broadcasts method-call through PubSub, waits for method-result

### WorkerRouter (`src/server/workerRouter.ts`)

Central registry mapping `participantId → DO` and `harnessId → DO`. Dispatches method calls to DOs via HTTP POST to workerd (`/_do/{className}/{objectKey}/{method}`).

### HarnessManager (`src/server/harnessManager.ts`)

Spawns and tracks Node.js child processes. Each harness:
1. Gets environment vars (RPC_WS_URL, AUTH_TOKEN, HARNESS_ID, CHANNEL_ID, etc.)
2. Connects back via WebSocket
3. Authenticates and creates an RPC bridge
4. Pushes `HarnessOutput` events to its owning DO via `harnessService.pushEvent()`

### executeActions (`src/server/executeActions.ts`)

The single execution path for all DO action results. Handles spawn-harness (7-step bootstrap), respawn-harness (crash recovery), fork-channel, set-alarm, and delegates channel/harness actions to the facade and bridges.

## DO Base Class: AgentWorkerBase

Location: `workspace/packages/runtime/src/worker/durable.ts`

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
| `onOutgoingMethodCall()` | Intercept harness method calls |
| `onChannelForked()` | React to channel forks |
| `onAlarm()` | Handle timer callbacks |

## Flows

### First User Message

```
Panel sends message → PubSub → Facade callback → DO.onChannelEvent()
  1. shouldProcess() → true
  2. getHarnessForChannel() → null (no harness yet)
  3. Send bootstrap typing indicator
  4. Return spawnHarness action with initialTurn

Server executes spawn-harness:
  1. Register harness in router + DO
  2. Ensure context folder
  3. Fork Node.js process
  4. Wait for WebSocket authentication
  5. Notify DO: onHarnessEvent("ready")
  6. Record turn state in DO
  7. Fire-and-forget: bridge.startTurn(input)
```

### Subsequent Messages

```
Panel sends message → DO.onChannelEvent()
  1. getHarnessForChannel() → harnessId
  2. Return startTurn action + typing indicator
  3. Record active_turn + in_flight_turn
```

### Streaming Response

```
Harness emits events → harnessService.pushEvent() → DO.onHarnessEvent()
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

Server: facade.callParticipantMethod() → broadcasts to panel via PubSub
Panel: request_tool_approval handler
  → checkToolApproval() for auto-approve
  → requestApproval() for UI prompt
  → returns {allow, alwaysAllow}

Server: receives method-result → DO.onCallResult(callId, result)
  → consumePendingCall(callId) → handleCallResult("approval", ...)
  → DO returns approveTool(toolUseId, allow, alwaysAllow) action
```

### Crash Recovery

```
Harness process dies → HarnessManager detects exit → onCrash callback
  → DO.onHarnessEvent(harnessId, {type: "error"})
  → Complete partial stream
  → Read in-flight turn for retry
  → Return respawnHarness action with resumeSessionId + retryTurn
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
| `@natstack/harness` | `packages/harness/` | Types (HarnessOutput, WorkerAction, ChannelEvent), SDK adapters |
| `@natstack/pubsub` | `packages/pubsub/` | PubSubClient, protocol types, approval schemas |
| `@natstack/pubsub-server` | `packages/pubsub-server/` | PubSub server with channel forking |
| `@workspace/runtime` | `workspace/packages/runtime/` | AgentWorkerBase, ActionCollector, StreamWriter |
| Workers | `workspace/workers/` | DO implementations (agent-worker, test-agent) |

## Further Reading

- **Worker Authoring Guide**: `workspace/workers/README.md` — full annotated walkthrough with examples
- **Paneldev Skill**: `workspace/skills/paneldev/WORKERS.md` — reference for AI agents building workers
- **Harness Types**: `packages/harness/README.md` — HarnessOutput, HarnessCommand, WorkerAction type catalog
- **Channel Forking**: `packages/pubsub-server/README.md` — fork semantics, replay, schema

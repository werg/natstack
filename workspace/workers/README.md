# Worker Authoring Guide

This guide covers building Durable Object (DO) workers that participate in AI chat channels. Workers run in workerd (Cloudflare's V8 isolate runtime) and use SQLite-backed state that survives across invocations.

## 1. Quick Start

### Directory Structure

```
workspace/workers/my-agent/
  package.json       # manifest with durable class declarations
  index.ts           # entry point — exports DO class + default fetch handler
  my-agent-worker.ts # DO implementation extending AgentWorkerBase
  my-agent-worker.test.ts  # tests using createTestDO()
```

### Manifest (package.json)

```json
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

### Entry Point (index.ts)

```typescript
export { MyAgentWorker } from "./my-agent-worker.js";
export default { fetch(_req: Request) { return new Response("my-agent DO service"); } };
```

The entry point must:
1. Re-export all DO classes by name
2. Export a default fetch handler (required by workerd)

## 2. The Five Hooks

`AgentWorkerBase` provides five hooks you can override to customize behavior:

### getHarnessType(): string

Returns the harness type identifier. Default: `"claude-sdk"`.

```typescript
protected getHarnessType(): string {
  return 'claude-sdk'; // or 'openai', 'custom', etc.
}
```

### getHarnessConfig(): HarnessConfig

Returns configuration passed to the harness on spawn. Override to set system prompts, model, temperature, MCP servers, etc.

```typescript
protected getHarnessConfig(): HarnessConfig {
  return {
    systemPrompt: 'You are a helpful coding assistant.',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 4096,
    mcpServers: [{ name: 'fs', tools: [...] }],
  };
}
```

### shouldProcess(event: ChannelEvent): boolean

Filter which channel events trigger an AI turn. Default: only `panel`-sent `message` events.

```typescript
protected shouldProcess(event: ChannelEvent): boolean {
  // Process messages from panels and also handle @mentions
  return event.senderType === 'panel' && event.type === 'message';
}
```

### buildTurnInput(event: ChannelEvent): TurnInput

Transform a channel event into the input for an AI turn. Default extracts content, senderId, and attachments.

```typescript
protected buildTurnInput(event: ChannelEvent): TurnInput {
  const payload = event.payload as { content?: string };
  return {
    content: payload.content ?? '',
    senderId: event.senderId,
    attachments: event.attachments,
    context: 'Additional context injected here',
  };
}
```

### getParticipantInfo(channelId, config?): ParticipantDescriptor

Declare the channel identity for this DO. Controls what handle, name, and callable methods are advertised.

```typescript
protected getParticipantInfo(): ParticipantDescriptor {
  return {
    handle: 'my-agent',
    name: 'My Agent',
    type: 'agent',
    methods: [
      { name: 'pause', description: 'Pause the current turn' },
    ],
  };
}
```

## 3. Direct Communication APIs

DOs are autonomous — they call channel and server APIs directly. Channel operations go through `ChannelClient` (which wraps `callDO()` to talk directly to the Channel DO via `stub.fetch()`). Server operations go through `this.server`. All methods return void.

### Channel Operations — `this.createChannelClient(channelId)`

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
| `channel.updateMetadata(participantId, metadata)` | Update channel metadata |
| `channel.subscribe(participantId, metadata)` | Subscribe to channel |
| `channel.unsubscribe(participantId)` | Unsubscribe from channel |
| `channel.callMethod(callerPid, targetPid, callId, method, args)` | Async method call |
| `channel.getParticipants()` | Get channel roster |

### Server Operations — `this.server`

| Method | Description |
|--------|-------------|
| `.spawnHarness(opts)` | Spawn a new harness process |
| `.sendHarnessCommand(harnessId, command)` | Send command to harness |
| `.stopHarness(harnessId)` | Stop a harness process |
| `.cloneDO(ref, newObjectKey)` | Clone a DO's SQLite storage |
| `.destroyDO(ref)` | Destroy a DO's SQLite storage |

## 4. StreamWriter

`StreamWriter` handles the send -> update -> complete lifecycle of streaming messages. It takes a `ChannelClient` directly:

```typescript
const turn = this.getActiveTurn(harnessId);
if (turn) {
  const writer = this.createWriter(channelId, turn);
  await writer.startText();           // sends a new message
  await writer.updateText("chunk");   // updates the message content
  await writer.completeText();        // marks message as complete
  this.persistStreamState(harnessId, writer);
}
```

### StreamWriter Methods

All methods are async (calls to the Channel DO):

| Method | Description |
|--------|-------------|
| `startThinking()` / `updateThinking(content)` / `endThinking()` | Thinking block lifecycle |
| `startText(metadata?)` / `updateText(content)` / `completeText()` | Text message lifecycle |
| `startAction(tool, description, toolUseId?)` / `endAction()` | Tool action lifecycle |
| `sendInlineUi(data)` | Send inline UI component |
| `startTyping()` / `stopTyping()` | Typing indicator lifecycle |

Call `this.persistStreamState(harnessId, writer)` after using the writer to save message IDs to SQLite.

## 5. ParticipantDescriptor

```typescript
interface ParticipantDescriptor {
  handle: string;                    // unique identifier in the channel
  name: string;                      // display name
  type: string;                      // 'agent', 'panel', etc.
  metadata?: Record<string, unknown>;
  methods?: MethodAdvertisement[];   // callable methods
}

interface MethodAdvertisement {
  name: string;
  description: string;
  parameters?: unknown;  // JSON Schema for method args
}
```

## 6. AgentWorkerBase Internals

### SQLite Tables

The base class creates 8 tables on initialization:

| Table | Purpose |
|-------|---------|
| `state` | Key-value store (schema version, custom state) |
| `subscriptions` | Channel subscriptions with config + participant ID |
| `harnesses` | Harness instances (id, type, status) |
| `turn_map` | Completed turn records for fork resolution |
| `checkpoints` | Last-processed event ID per channel/harness |
| `in_flight_turns` | Currently executing turns (for crash retry) |
| `active_turns` | Currently streaming turns (replyToId, turnMessageId, senderParticipantId) |
| `pending_calls` | Continuation state for async method calls (survives hibernation) |

### Helper Methods

| Method | Description |
|--------|-------------|
| `getActiveHarness()` | Get the active harness ID |
| `getContextId(channelId)` | Get context ID from subscription |
| `getSubscriptionConfig(channelId)` | Get per-channel config |
| `setActiveTurn(harnessId, channelId, replyToId, turnMessageId?)` | Record active turn |
| `getActiveTurn(harnessId)` | Get active turn state |
| `clearActiveTurn(harnessId)` | Clear active turn |
| `setInFlightTurn(channelId, harnessId, messageId, pubsubId, input)` | Record in-flight turn |
| `getInFlightTurn(channelId, harnessId)` | Get in-flight turn |
| `clearInFlightTurn(channelId, harnessId)` | Clear in-flight turn |
| `advanceCheckpoint(channelId, harnessId, pubsubId)` | Advance checkpoint |
| `getCheckpoint(channelId, harnessId)` | Get checkpoint |
| `recordTurn(harnessId, messageId, triggerPubsubId, sessionId)` | Record completed turn |
| `getResumeSessionId(harnessId)` | Get session ID for conversation resume |
| `getResumeSessionIdForChannel(channelId)` | Get resume session (prefers forkSessionId if set) |
| `getAlignment(harnessId)` | Get alignment state |
| `registerHarness(harnessId, type)` | Register a new harness |
| `reactivateHarness(harnessId)` | Reactivate a harness |
| `recordTurnStart(harnessId, channelId, input, messageId, pubsubId, senderParticipantId?)` | Convenience: set active + in-flight + checkpoint |
| `pendingCall(callId, channelId, type, context)` | Store a continuation (survives hibernation) |
| `consumePendingCall(callId)` | Load and delete a continuation |
| `getParticipantId(channelId)` | Get this DO's channel participant ID |

### Schema Versioning

Override `static schemaVersion` to trigger table re-creation:

```typescript
export class MyWorker extends AgentWorkerBase {
  static schemaVersion = 2; // bump when schema changes
  // ...
}
```

The base class checks the stored version against `schemaVersion` on construction and re-runs `createTables()` if needed.

## 7. Testing with createTestDO()

`createTestDO()` creates a DO instance backed by in-memory SQLite (sql.js / WASM), eliminating the need for workerd or native modules in unit tests.

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

    // onChannelEvent returns void — side effects happen via direct calls to Channel DO and server
    await instance.onChannelEvent("ch-1", event);
  });
});
```

The `sql` object exposes `exec(query, ...bindings)` for direct database inspection:

```typescript
const rows = sql.exec(`SELECT * FROM active_turns`).toArray();
expect(rows).toHaveLength(1);
```

## 8. Debugging

In development, the server exposes a debug endpoint for inspecting DO state:

```
GET /_do/:className/:objectKey/state
```

This calls `getState()` on the DO and returns all table contents as JSON.

## 9. Per-Channel Config

Subscription config is passed during `subscribeChannel()` and stored in the `subscriptions` table. Access it in your hooks:

```typescript
const config = this.getSubscriptionConfig(channelId);
if (config?.model) {
  // use per-channel model override
}
```

The `AiChatWorker` merges subscription config with `getHarnessConfig()` automatically — per-channel overrides for `systemPrompt`, `model`, `temperature`, and `maxTokens` take precedence.

## 10. Full Annotated AiChatWorker Walkthrough

The built-in `AiChatWorker` (in `workspace/workers/agent-worker/`) implements all three event handlers. Here is the complete flow:

### Channel Event Flow

```
User sends message
  -> onChannelEvent(channelId, event)
    -> Does shouldProcess() pass?
       No  -> Advance checkpoint, return empty actions
       Yes -> Build TurnInput from event
              -> Is there an active harness?
                 No  -> registerHarness + recordTurnStart locally
                        then $.spawnHarness() with initialInput
                 Yes -> $.harness(id).startTurn(input)
                        + typing indicator
                        + record active/in-flight turns
```

### Harness Event Flow

```
Harness emits event
  -> onHarnessEvent(harnessId, event)
    -> Look up active turn + channel
    -> Create StreamWriter via this.createWriter(channelId, turn)
    -> Map event type to StreamWriter calls:
       thinking-start  -> writer.startThinking()
       thinking-delta  -> writer.updateThinking(content)
       thinking-end    -> writer.endThinking()
       text-start      -> writer.startText(metadata)
       text-delta      -> writer.updateText(content)
       text-end        -> writer.completeText()
       action-start    -> writer.startAction(tool, description)
       action-end      -> writer.endAction()
       inline-ui       -> writer.sendInlineUi(data)
       turn-complete   -> recordTurn(), clearActiveTurn(), clearInFlightTurn()
       error           -> Mark crashed, complete partial message, respawn via this.server.spawnHarness()
       approval-needed -> Store continuation + channel.callMethod(request_tool_approval)
       metadata-update -> channel.updateMetadata()
       ready           -> Set harness status to 'active'
```

### Crash Recovery

When a harness sends an `error` event:
1. Harness is marked `crashed` in SQLite with the error message
2. Any partial streaming message is completed
3. The resume session ID is looked up from turn_map
4. The in-flight turn is read for retry
5. Active turn state is cleared
6. `reactivateHarness()` + `recordTurnStart()` locally
7. Respawns via `this.server.spawnHarness()` with `initialInput`

## 11. Fork Support

AgentWorkerBase has built-in support for semantic conversation forking — cloning an agent DO at a specific point in the conversation history so the fork can resume independently.

### Preflight: `canFork()`

Called by the fork orchestrator before cloning. Returns `{ ok, subscriptionCount }`. The orchestrator rejects multi-channel agents (>1 sub) and replacement DOs with existing subscriptions (>0 subs).

### Post-clone: `postClone(parentObjectKey, newChannelId, oldChannelId, forkPointPubsubId)`

Called on the **newly cloned** DO after `cloneDO()` copies the parent's SQLite. Performs:

1. Fixes `__objectKey` and restores identity
2. Records fork metadata in state KV (`forkedFrom`, `forkPointPubsubId`, `forkSourceChannel`)
3. Resolves the fork session ID from `turn_map` (most recent session at or before fork point) → `forkSessionId`
4. Marks all harnesses as `stopped`
5. Clears ephemeral tables (`active_turns`, `in_flight_turns`, `pending_calls`, `checkpoints`)
6. Renames `approvalLevel:{oldChannel}` → `approvalLevel:{newChannel}`
7. Deletes old subscription and resubscribes to the forked channel
8. Calls `onPostClone()` subclass hook

### Resume after fork

`getResumeSessionIdForChannel()` returns the stored `forkSessionId` on every call until the first turn succeeds (consumed in `recordTurn()`). This is passed as `RESUME_SESSION_ID` to the harness, which tells the Claude SDK to fork at that session point. Survives spawn retries.

### Subclass hook: `onPostClone()`

Override for custom cleanup after fork. Called at the end of `postClone()`:

```typescript
protected async onPostClone(
  parentObjectKey: string,
  newChannelId: string,
  oldChannelId: string,
  forkPointPubsubId: number,
): Promise<void> {
  // Custom cleanup, e.g., reset counters, clear caches
}
```

### Fork Worker (`workspace/workers/fork/`)

The fork worker is a stateless fetch handler that orchestrates the full fork sequence. It uses platform primitives via RPC:

- `runtime.callMain("workerd.cloneDO", ref, newKey)` — clone a DO's SQLite
- `runtime.callMain("workerd.destroyDO", ref)` — destroy on rollback
- `rpc.call("do:source:className:objectKey", method, ...args)` — call DO methods via RPC relay

Trigger via `POST /fork`:

```json
{
  "channelId": "chan-1",
  "forkPointPubsubId": 42,
  "exclude": ["participantId-to-skip"],
  "replace": { "participantId": { "source": "workers/agent", "className": "Agent", "objectKey": "new-key" } }
}
```

Flow:
1. Fetches channel roster and contextId
2. Preflight: `canFork()` on clones (≤1 sub), replacements (0 subs)
3. Clones channel SQLite + `postClone` (trims messages, clears roster)
4. Clones each agent DO + `postClone` (rewrites identity, resubscribes)
5. Subscribes replacement DOs to the forked channel
6. On failure: best-effort rollback (destroy cloned SQLite, unsubscribe replacements)

## 12. Custom Worker Example: CodeReviewWorker

```typescript
import { AgentWorkerBase } from "@workspace/agentic-do";
import type {
  ChannelEvent, HarnessConfig, HarnessOutput,
  ParticipantDescriptor, TurnInput,
} from "@natstack/harness";

export class CodeReviewWorker extends AgentWorkerBase {
  static override schemaVersion = 3;

  protected override getHarnessConfig(): HarnessConfig {
    return {
      systemPrompt: `You are a code review assistant. When given a diff or code snippet,
        provide constructive feedback on: correctness, performance, readability, and security.
        Format your response as a structured review with sections.`,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.3,
    };
  }

  protected override getParticipantInfo(): ParticipantDescriptor {
    return {
      handle: 'code-reviewer',
      name: 'Code Reviewer',
      type: 'agent',
      methods: [
        { name: 'set-strictness', description: 'Set review strictness (1-5)' },
      ],
    };
  }

  protected override shouldProcess(event: ChannelEvent): boolean {
    if (event.senderType !== 'panel' || event.type !== 'message') return false;
    const content = (event.payload as { content?: string })?.content ?? '';
    return content.includes('```') || content.includes('diff --git');
  }

  protected override buildTurnInput(event: ChannelEvent): TurnInput {
    const payload = event.payload as { content?: string };
    return {
      content: `Please review the following code:\n\n${payload.content ?? ''}`,
      senderId: event.senderId,
      attachments: event.attachments,
    };
  }

  async onChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    if (!this.shouldProcess(event)) {
      this.advanceCheckpoint(channelId, null, event.id);
      return;
    }

    const input = this.buildTurnInput(event);
    const activeHarnessId = this.getActiveHarness();

    if (!activeHarnessId) {
      const contextId = this.getContextId(channelId);
      const harnessId = `harness-${crypto.randomUUID()}`;
      this.registerHarness(harnessId, this.getHarnessType());
      this.recordTurnStart(harnessId, channelId, input, event.messageId, event.id);
      await this.server.spawnHarness({
        doRef: this.doRef,
        harnessId,
        type: this.getHarnessType(),
        contextId,
        config: this.getHarnessConfig() as unknown as Record<string, unknown>,
        initialInput: input,
      });
    } else {
      this.setActiveTurn(activeHarnessId, channelId, event.messageId);
      this.setInFlightTurn(channelId, activeHarnessId, event.messageId, event.id, input);
      this.advanceCheckpoint(channelId, harnessId, event.id);
      await this.server.sendHarnessCommand(activeHarnessId, { type: "start-turn", input });
    }
  }

  async onHarnessEvent(harnessId: string, event: HarnessOutput): Promise<void> {
    if (event.type === "ready") {
      this.sql.exec(`UPDATE harnesses SET status = 'active' WHERE id = ?`, harnessId);
      return;
    }
    const turn = this.getActiveTurn(harnessId);
    const channelId = turn?.channelId;
    if (!channelId || !turn) return;

    const writer = this.createWriter(channelId, turn);

    switch (event.type) {
      case 'text-start': await writer.startText(); break;
      case 'text-delta': await writer.updateText(event.content); break;
      case 'text-end': await writer.completeText(); break;
      case 'turn-complete': {
        this.persistStreamState(harnessId, writer);
        const at = this.getActiveTurn(harnessId);
        if (at?.turnMessageId) {
          const inf = this.getInFlightTurn(channelId, harnessId);
          this.recordTurn(harnessId, at.turnMessageId, inf?.triggerPubsubId ?? 0, event.sessionId);
        }
        this.clearActiveTurn(harnessId);
        this.clearInFlightTurn(channelId, harnessId);
        return;
      }
      case 'ready':
        this.harnesses.setStatus(harnessId, 'active');
        break;
    }

    this.persistStreamState(harnessId, writer);
  }

  override async onMethodCall(
    channelId: string, callId: string, methodName: string, args: unknown,
  ): Promise<{ result: unknown; isError?: boolean }> {
    if (methodName === 'set-strictness') {
      const level = (args as { level?: number })?.level ?? 3;
      this.setStateValue('strictness', String(level));
      return { result: { strictness: level } };
    }
    return { result: { error: 'unknown method' }, isError: true };
  }
}
```

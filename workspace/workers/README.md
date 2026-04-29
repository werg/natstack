# Worker Authoring Guide

This guide covers building Durable Object (DO) workers that participate in AI chat channels. Workers run in workerd (Cloudflare's V8 isolate runtime) and use SQLite-backed state that survives across invocations.

NatStack runs Pi (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`)
in-process inside each agent worker DO — there is no harness child process
layer. See `docs/pi-architecture.md` for the full architectural picture and
`docs/agentic-architecture.md` for the higher-level overview.

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

## 2. Customization Hooks (Pi-native)

`AgentWorkerBase` provides hooks you can override to customize Pi behavior:

### getModel(): string

Returns the model id in `provider:model` format. `AgentWorkerBase` requires
subclasses to override this hook. The default chat worker uses
`"openai-codex:gpt-5.5"`.

```typescript
protected getModel(): string {
  return 'openai-codex:gpt-5.5';
}
```

The format is parsed by `resolveModelToPi` in `packages/shared/src/ai/`.
Pi-AI's built-in providers (anthropic, openai, google, etc.) work
out-of-the-box; custom providers can be registered via `models.json`.

### getThinkingLevel(): ThinkingLevel

Returns the Pi thinking level. Default: `"medium"`. Allowed:
`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`.

```typescript
protected getThinkingLevel() {
  return 'high';
}
```

### getApprovalLevel(channelId: string): 0 | 1 | 2

Returns the tool approval level for a channel. Default: `2` (full auto).

| Level | Meaning |
|---|---|
| `0` | Ask all — every tool call gets a UI confirm prompt |
| `1` | Auto safe — read-only tools auto-approve, others prompt |
| `2` | Full auto — everything runs without prompts |

The default reads from a per-channel `state` table key
(`approvalLevel:<channelId>`); subclasses rarely need to override.

### System prompt

The final prompt is composed at `PiRunner` init from the NatStack base prompt,
`workspace/meta/AGENTS.md`, the generated skill index, and optional
subscription config (`systemPrompt` / `systemPromptMode`). Model/runtime
customization is via `getModel()` / `getThinkingLevel()` /
`getApprovalLevel()` hooks.

### shouldProcess(event: ChannelEvent): boolean

Filter which channel events trigger an AI turn. Default: `message` events from
client participants (panels and headless clients), as classified by
`isClientParticipantType` from `@natstack/pubsub`.

```typescript
import { isClientParticipantType } from '@natstack/pubsub';

protected shouldProcess(event: ChannelEvent): boolean {
  if (event.type !== 'message') return false;
  const senderType = event.senderMetadata?.["type"] as string | undefined;
  return isClientParticipantType(senderType);
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
protected getParticipantInfo(channelId: string, config?: unknown): ParticipantDescriptor {
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

## 4. Pi Event Forwarding

The worker base subscribes to the in-process Pi `Agent`'s event stream and routes events through a `ContentBlockProjector`, which emits one channel message per Pi content block. The mapping:

| Pi Event | Channel Message |
|----------|----------------|
| `message_update` / `text_start` | `channel.send()` a new streaming text message |
| `message_update` / `text_delta` | `channel.update()` appending the delta |
| `message_update` / `text_end` | `channel.complete()` the text message |
| `message_update` / `thinking_*` | `contentType: "thinking"` message streamed via `{ append: true }` updates |
| `message_update` / `toolcall_start` | `contentType: "toolCall"` message carrying a `ToolCallPayload` snapshot |
| `tool_execution_update` (console) | `channel.update()` with updated payload (status `"pending"`) |
| `tool_execution_end` | `channel.update()` with final payload (status `"complete"` or `"error"`; any result images fold into `execution.resultImages`) then `channel.complete()` |
| `agent_end` | Complete typing indicator |

Typing is a roster-metadata state (`participant.metadata.typing`), toggled before `runTurn` and on `agent_end`. On abort/error, the projector's `closeAll()` emits `channel.complete` for every in-flight block so clients see clean closure.

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

The base class creates these tables on initialization:

| Table | Purpose |
|-------|---------|
| `state` | Key-value store (schema version, custom state) |
| `subscriptions` | Channel subscriptions with config + participant ID |
| `pi_sessions` | Per-channel Pi message persistence (`messages_blob` JSON) |
| `pending_calls` | Continuation state for async method calls (survives hibernation) |
| `delivery_cursor` | Last-processed event ID per channel (dedup + gap detection) |

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
const rows = sql.exec(`SELECT * FROM pi_sessions`).toArray();
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

Subscription config can override `model`, `thinkingLevel`, `systemPrompt`, and
`systemPromptMode` via `extraConfig`. The final prompt is composed from the
NatStack base prompt, `workspace/meta/AGENTS.md`, the generated skill index,
and any subscription prompt override.

## 10. Event Flow

```
User sends message
  -> onChannelEvent(channelId, event)
    -> shouldProcess(event)?
       No  -> return
       Yes -> buildTurnInput(event)
              -> refreshRoster(channelId)
              -> getOrCreateRunner(channelId) [lazy init: loads resources, creates Agent]
              -> sendTypingIndicator(channelId)  [instant "Agent typing" feedback]
              -> runner.runTurn(content, images) or runner.steer(content, images)
```

Pi Agent events flow through `ContentBlockProjector` (one channel message per Pi content block):

```
Agent emits event
  -> projector.handleEvent(event)
    -> text_start / text_delta / text_end:
         channel.send → update (deltas) → complete
    -> thinking_start / thinking_delta / thinking_end:
         channel.send(contentType:"thinking") → update(append:true) → complete
    -> toolcall_start:
         channel.send(contentType:"toolCall") with ToolCallPayload snapshot
    -> toolcall_end:
         channel.update() with finalized args
    -> tool_execution_update (console):
         channel.update() with payload (consoleOutput appended)
    -> tool_execution_end:
         channel.update() with status:"complete"|"error", result, resultImages
         channel.complete()
    -> agent_end:
         setTyping(false)
  -> projector.closeAll()  (on abort/error — completes every in-flight block)
```

## 11. Fork Support

AgentWorkerBase supports conversation forking — cloning an agent DO at a specific message index so the fork resumes independently.

### Preflight: `canFork()`

Returns `{ ok, subscriptionCount }`. Rejects multi-channel agents (>1 sub).

### Post-clone: `postClone(parentObjectKey, newChannelId, oldChannelId, forkPointMessageId)`

Called on the **newly cloned** DO after `cloneDO()` copies the parent's SQLite. Performs:

1. Fixes `__objectKey` and restores identity
2. Records fork metadata in state KV
3. Migrates the parent's `pi_sessions` row from oldChannelId → newChannelId (messages blob is truncated at the fork point)
4. Renames `approvalLevel:{oldChannel}` → `approvalLevel:{newChannel}`
5. Deletes old subscription, clears ephemeral state, resubscribes to forked channel
6. Calls `onPostClone()` subclass hook

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
import type { ChannelEvent, ParticipantDescriptor, TurnInput } from "@natstack/harness";

export class CodeReviewWorker extends AgentWorkerBase {
  static override schemaVersion = 3;

  // The system prompt is composed from NatStack base + workspace/meta/AGENTS.md.
  // Override getModel() to select a specific model for code review:
  protected override getModel(): string {
    return "openai-codex:gpt-5.5";
  }

  protected override getParticipantInfo(channelId: string, config?: unknown): ParticipantDescriptor {
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
    if (event.type !== 'message') return false;
    const senderType = event.senderMetadata?.["type"] as string | undefined;
    if (!isClientParticipantType(senderType)) return false;
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

  // onChannelEvent is inherited from AgentWorkerBase — no override needed.
  // The base class handles:
  //   shouldProcess → buildTurnInput → refreshRoster → getOrCreateRunner
  //   → setTyping(true) → runner.runTurn/steer
  //   → ContentBlockProjector (text / thinking / toolCall streams → cleanup)
  //
  // Override onChannelEvent only when you need custom routing logic (e.g.,
  // filtering messages by content like the shouldProcess override above).

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

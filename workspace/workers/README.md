# Worker Authoring Guide

This guide covers building Durable Object (DO) workers that participate in AI chat channels. Workers run in workerd (Cloudflare's V8 isolate runtime) and use `this.sql` state that survives across invocations.

NatStack runs Pi (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`)
in-process inside each agent worker DO — there is no harness child process
layer. See `docs/pi-architecture.md` for the full architectural picture and
`docs/agentic-architecture.md` for the higher-level overview.

Transcript-visible chat state flows through PubSub channel events:

```
Producer -> PubSub channel log -> typed agentic event reducer -> UI view model
```

GAD stores private trajectory provenance and can back PubSub channel persistence,
but channel history and trajectory history remain distinct. When a trajectory
event is published, GAD records a `trajectory_channel_publications` join so
audits can connect the branchable agent context to the envelope users or other
agents actually received.

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
  },
  "pnpm": {
    "overrides": {
      "problem-dependency": "1.2.3"
    }
  }
}
```

The `durable.classes` array declares which exported classes are DurableObjects. The `className` must match the exported class name exactly.

### Dependency Overrides

Workers can use top-level `overrides` in their `package.json`. BuildV2 forwards
simple string overrides from the worker and its transitive workspace packages
into the generated external-deps npm install. This is the supported way to
repair a transitive package that points at a missing, broken, or patched npm
version.

Overrides are included in the external-deps cache key, so changing one triggers
a fresh install.

### PubSub Persistence Backend

`PubSubChannel` writes durable transcript envelopes through a `ChannelLogStore`.
The implementation delegates durable channel-envelope storage to GAD while
keeping the same PubSub fan-out/replay API and the same UI reducer path.

### Userland Services

Worker package.json only declares DO classes (workerd binding) via
`natstack.durable.classes`. Workspace-level declarations — singletons,
services, and HTTP routes — live in `workspace/meta/natstack.yml`.

DO-backed service (in `workspace/meta/natstack.yml`):

```yaml
singletonObjects:
  - source: workers/my-store
    className: MyStore
    key: main

services:
  - source: workers/my-store
    name: my-store
    protocols: [example.my-store.v1]
    durableObject: { className: MyStore }    # key joined from singletonObjects
```

Stateless worker service:

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

Resolve at runtime:

```ts
const svc = await workers.resolveService("example.my-store.v1");
if (svc.kind === "durable-object") {
  await rpc.call(svc.targetId, "methodName", []);
}

const api = await workers.resolveService("example.my-api.v1");
if (api.kind === "worker") {
  await gatewayFetch(`${api.routeBasePath}/work`, { method: "POST" });
}
```

A `services[].durableObject` or `routes[].durableObject` entry referencing a
DO class with no matching `singletonObjects` row is rejected at workspace-load
time. The package.json no longer carries `services` or `routes` arrays — those
sections live exclusively in `natstack.yml`.

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
`isClientParticipantType` from `@workspace/pubsub`.

```typescript
import { isClientParticipantType } from '@workspace/pubsub';

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

DOs are autonomous — they call channel and server APIs directly. Channel operations go through `ChannelClient` over unified RPC to the Channel DO. Server operations go through `this.server`. All methods return void.

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
| `channel.sendSignal(participantId, content, contentType?)` | Send signal event |
| `channel.updateMetadata(participantId, metadata)` | Update channel metadata |
| `channel.subscribe(participantId, metadata)` | Subscribe to channel |
| `channel.unsubscribe(participantId)` | Unsubscribe from channel |
| `channel.callMethod(callerPid, targetPid, transportCallId, method, args, { invocationId?, turnId? })` | Async method call; `transportCallId` routes/cancels the dispatch, `invocationId` is the transcript/provenance id |
| `channel.getParticipants()` | Get channel roster |

## 4. Trajectory Event Publishing

The worker base owns runner lifecycle and dispatch cancellation. `PiRunner`
writes canonical `AgenticEvent` records to gad and publishes opaque
`agentic.trajectory.v1/event` channel envelopes. Chat clients build their
visible transcript by subscribing to those envelopes and reducing them locally.
Visible typing is derived from durable `turn.opened` / `turn.closed` events;
roster typing metadata is only a secondary ephemeral signal for participants
that do not own durable agent turns.

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
      senderType: "panel", ts: Date.now(),
    };

    // processChannelEvent returns void — side effects happen via direct calls to Channel DO and server
    await instance.processChannelEvent("ch-1", event);
  });
});
```

The `sql` object exposes `exec(query, ...bindings)` for direct database inspection:

```typescript
const rows = sql.exec(`SELECT * FROM subscriptions`).toArray();
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
  -> onChannelEnvelope(channelId, { kind: "log", phase: "live", event })
    -> shouldProcess(event)?
       No  -> return
       Yes -> buildTurnInput(event)
              -> refreshRoster(channelId)
              -> getOrCreateRunner(channelId) [lazy init: loads resources, creates Agent]
              -> PiRunner publishes turn.opened/turn.closed [durable typing state]
              -> runner.runTurn(content, images) or runner.steer(content, images)
```

Pi events flow through the trajectory store:

```
Agent emits event
  -> PiRunner maps it to AgenticEvent
  -> gad.appendTrajectoryBatch(... publish.channelIds for transcript-visible events)
  -> GAD channel_envelopes payloadKind "agentic.trajectory.v1/event"
  -> trajectory_channel_publications joins the trajectory event to the envelope
  -> clients reduce channel envelopes into chat state
```

## 11. Fork Support

AgentWorkerBase supports conversation forking — cloning an agent DO at a specific message index so the fork resumes independently.

### Preflight: `canFork()`

Returns `{ ok, subscriptionCount }`. Rejects multi-channel agents (>1 sub).

### Post-clone: `postClone(parentObjectKey, newChannelId, oldChannelId, forkPointMessageId)`

Called on the **newly cloned** DO after `cloneDO()` copies the parent's SQLite. Performs:

1. Fixes `__objectKey` and restores identity
2. Records fork metadata in state KV
3. Forks the channel trajectory branch for the cloned channel
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
- `rpc.call("do:source:className:objectKey", method, args)` — call DO methods via RPC relay

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

  // onChannelEnvelope is inherited from AgentWorkerBase — no override needed.
  // The base class handles:
  //   shouldProcess → buildTurnInput → refreshRoster → getOrCreateRunner
  //   → setTyping(true) → runner.runTurn/steer
  //   → PiRunner trajectory append + channel envelope publication
  //
  // Override processChannelEvent only when you need custom routing logic (e.g.,
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

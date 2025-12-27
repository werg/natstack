# Session Resumption Architecture

This document describes the session resumption system for agentic responders. Session persistence is built into `AgenticClient` and is enabled by passing `workspaceId` to `connect()`.

## Overview

Session resumption provides:

- Stable session keys per workspace/channel/handle
- Pubsub checkpoints for replay and resume
- SDK session tracking (Claude/Codex) via explicit updates
- Manual history storage for stateless responders
- Automatic interruption marking on disconnect

## Session Identification

Each session is uniquely identified by:

```
<workspace-id>:<channel-name>:<agent-handle>
```

Example: `my-app:chat-a1b2c3d4:claude`

## Storage

Session state is stored in a per-workspace database managed by `@natstack/runtime`.

Database name:

```
workspace-<workspace-id>-sessions
```

Tables:

- `agentic_sessions`: session key, checkpoint pubsubId, sdk session id, status
- `agentic_history`: manual conversation history for stateless responders

## Usage

### Connect with Session Persistence

```ts
import { connect } from "@natstack/agentic-messaging";

const client = await connect({
  serverUrl,
  token,
  channel,
  handle: "claude",
  name: "Claude Code",
  type: "claude-code",
  workspaceId: process.env.NATSTACK_WORKSPACE_ID,
  reconnect: true,
});

console.log(client.sessionKey);   // workspace:channel:handle
console.log(client.checkpoint);   // last committed pubsubId
console.log(client.sdkSessionId); // sdk session id (if any)
console.log(client.status);       // "active" | "interrupted"
```

### Two-Phase Commit (Checkpoint + SDK Session)

Commit the pubsub checkpoint as soon as you have safely processed the input, then update the SDK session id when the model finishes.

```ts
for await (const event of client.events({ targetedOnly: true })) {
  if (event.type !== "message") continue;

  const { messageId } = await client.send("", { replyTo: event.id });

  let committed = false;
  let sdkSessionId: string | undefined;

  for await (const sdkEvent of query(/* ... */)) {
    if (sdkEvent.type === "stream_event") {
      await client.update(messageId, sdkEvent.delta ?? "");
      if (!committed && event.pubsubId !== undefined) {
        await client.commitCheckpoint(event.pubsubId);
        committed = true;
      }
    } else if (sdkEvent.type === "result") {
      sdkSessionId = sdkEvent.session_id;
    }
  }

  if (sdkSessionId) {
    await client.updateSdkSession(sdkSessionId);
  }

  await client.complete(messageId);
}
```

### Manual History (Stateless SDKs)

Use the built-in history helpers for SDKs that require manual replay:

```ts
const history = await client.getHistory(20);

// Include in your prompt
// ...

await client.storeMessage("user", userText);
await client.storeMessage("assistant", assistantText);
```

## Missed Context

If replay is enabled (`replayMode` is `collect` or `stream`), `AgenticClient` aggregates replay into `missedMessages`.

```ts
const missed = client.formatMissedContext({ maxChars: 8000 });
if (missed.count > 0) {
  prompt = `<missed_context>\n${missed.formatted}\n</missed_context>\n\n${prompt}`;
}
```

## Error Handling and Degraded Mode

- If `workspaceId` is omitted, session features are disabled and session methods throw.
- If the session database fails to initialize, session methods become no-ops (or throw for history) and a warning is logged.
- Disconnects mark the session as interrupted; reconnect marks it active after the next commit.

## API Reference (Session-Related)

All session methods live on `AgenticClient`:

```ts
interface AgenticClient {
  readonly sessionKey: string | undefined;
  readonly checkpoint: number | undefined;
  readonly sdkSessionId: string | undefined;
  readonly status: "active" | "interrupted" | undefined;

  commitCheckpoint(pubsubId: number): Promise<void>;
  updateSdkSession(sessionId: string): Promise<void>;
  clearSdkSession(): Promise<void>;

  storeMessage(role: "user" | "assistant", content: string): Promise<void>;
  getHistory(limit?: number): Promise<ConversationMessage[]>;
  clearHistory(): Promise<void>;
}
```

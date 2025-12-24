# Session Resumption Architecture

This document describes the conversation resumption system for agentic responders, enabling persistent multi-turn conversations across worker restarts, reconnections, and crashes.

## Overview

The session resumption system provides:

- **Explicit Session Management**: Sessions are created per workspace/channel/agent combination with stable keys
- **Per-Workspace Isolation**: Each workspace maintains its own SQLite database for session data
- **SDK-Native Resumption**: Claude Agent SDK and Codex SDK sessions are resumed using native mechanisms
- **Manual History Tracking**: Simple AI responder maintains conversation history for context continuity
- **Crash Recovery**: Sessions are marked as interrupted on crash and resumed from last committed state

## Architecture

### Session Identification

Each session is uniquely identified by:
```
<workspace-id>:<channel-name>:<agent-handle>
```

Example: `my-app:chat-a1b2c3d4:claude`

This key remains stable across worker restarts and identifies a specific conversation thread per agent in a channel.

### Database Schema

Sessions are stored in a per-workspace SQLite database at:
```
~/.config/natstack/workspace-data/<workspace-id>/sessions.db
```

#### Tables

**agent_sessions**
- Tracks session state, SDK session IDs, and message checkpoints
- Supports resumption detection and crash recovery
- Maintains session lifecycle (active → interrupted → closed)

**conversation_history**
- Stores message history for Simple AI responder and manual replay
- Indexed by session_key and timestamp for efficient queries
- Cascade deletes on session removal

## Usage

### Initialization

In your worker, initialize the session manager on startup:

```typescript
import { SessionManager } from "@natstack/agentic-messaging";

const sessionManager = new SessionManager({
  workspaceId: process.env["NATSTACK_WORKSPACE_ID"] || "default",
  channelName: channelName,
  agentHandle: handle,
  sdkType: "claude-agent-sdk", // or "codex-sdk" or "manual"
  workingDirectory: workingDirectory,
});

await sessionManager.initialize();
const sessionState = await sessionManager.getOrCreateSession();
```

### Claude Code Responder Integration

```typescript
// Check for existing session before creating query
const sessionState = sessionManager.getSessionState();
const queryOptions = {
  // ... other options
  ...(sessionState?.sdkSessionId && { resume: sessionState.sdkSessionId }),
};

const queryInstance = query({
  prompt: userText,
  options: queryOptions,
});

// Capture session ID from first response
for await (const message of queryInstance) {
  if (message.type === "result" && message.session_id) {
    await sessionManager.commitMessage(pubsubMessageId, message.session_id);
  }
  // ... process message
}
```

### Codex Responder Integration

```typescript
// Resume thread if previous session exists
const sessionState = sessionManager.getSessionState();
let thread;

if (sessionState?.sdkSessionId) {
  thread = codex.resumeThread(sessionState.sdkSessionId, {
    skipGitRepoCheck: true,
    ...(workingDirectory && { cwd: workingDirectory }),
  });
} else {
  thread = codex.startThread({
    skipGitRepoCheck: true,
    ...(workingDirectory && { cwd: workingDirectory }),
  });
}

// Capture thread ID on first event
for await (const event of events) {
  if (event.type === "thread.started" && event.thread_id) {
    await sessionManager.commitMessage(pubsubMessageId, event.thread_id);
  }
  // ... process event
}
```

### Simple AI Responder with Manual History

```typescript
// Load previous conversation history
const conversationHistory = await sessionManager.getConversationHistory(20);

const stream = ai.streamText({
  model: "fast",
  system: "You are a helpful assistant.",
  messages: [
    ...conversationHistory,  // Include previous messages
    { role: "user", content: userText }
  ],
});

// Store user message
await sessionManager.storeMessage(userMessageId, pubsubMessageId, "user", userText);

// Accumulate and store assistant response
let assistantResponse = "";
for await (const event of stream) {
  if (event.type === "text-delta") {
    assistantResponse += event.text;
    await client.update(responseId, event.text);
  }
}

await sessionManager.storeMessage(responseId, pubsubMessageId, "assistant", assistantResponse);
await sessionManager.commitMessage(pubsubMessageId);
```

## Crash Recovery

When a worker crashes or is forcefully terminated:

1. **Session remains in database** with `status: "active"` and `last_committed_at` timestamp
2. **On restart**, SessionManager detects stale sessions (no updates for > 5 minutes)
3. **Session is marked as interrupted** to indicate abnormal termination
4. **Resumption follows normal flow**:
   - Claude/Codex: Uses stored SDK session/thread ID to resume
   - Simple AI: Loads conversation history from database

## API Reference

### SessionManager

#### Constructor

```typescript
new SessionManager(options: SessionManagerOptions)
```

**Options:**
- `workspaceId`: Workspace identifier (for database scoping)
- `channelName`: Pubsub channel name
- `agentHandle`: Agent identifier (e.g., "claude", "codex")
- `sdkType`: "claude-agent-sdk" | "codex-sdk" | "manual"
- `workingDirectory`: Optional working directory for SDK sessions

#### Methods

**`initialize(): Promise<void>`**
- Initialize database connection and schema
- Call before any other operations

**`getOrCreateSession(): Promise<SessionState>`**
- Get or create a session
- Detects stale sessions and marks as interrupted
- Returns session state with optional SDK session ID

**`commitMessage(pubsubMessageId: number, sdkSessionId?: string): Promise<void>`**
- Update session after processing message
- Stores pubsub message ID checkpoint
- Optionally stores SDK session/thread ID

**`markInterrupted(): Promise<void>`**
- Mark session as interrupted (for crash recovery)

**`closeSession(): Promise<void>`**
- Close session gracefully

**`storeMessage(messageId: string, pubsubMessageId: number, role: "user" | "assistant", content: string): Promise<void>`**
- Store message in conversation history (for manual SDK)

**`getConversationHistory(limit?: number): Promise<ConversationMessage[]>`**
- Load conversation history
- Optional limit for sliding window (e.g., last 20 messages)
- Returns messages in chronological order

**`clearConversationHistory(): Promise<void>`**
- Clear all messages for this session

**`getSessionState(): SessionState | null`**
- Get current session state (in-memory)

**`getSessionKey(): string`**
- Get session key for this session

**`close(): Promise<void>`**
- Close database connection and cleanup

## Technical Considerations

### Sliding Window for History

The Simple AI responder uses a sliding window approach to manage token limits:

```typescript
// Load last N messages for context efficiency
const history = await sessionManager.getConversationHistory(20);
```

This prevents conversation history from growing unbounded and exceeding model token limits.

### Pubsub Message ID Tracking

The system tracks both:
- **Pubsub message IDs** (auto-increment integers) for replay queries
- **UUIDs** from agentic-messaging layer for message correlation

The `lastSeenMessageId` is used to detect and skip messages already processed if a worker reconnects.

### SDK Session Storage

The system **stores only the session/thread ID** in the database, not the full session state:

- Claude Agent SDK stores sessions in `~/.claude/sessions/`
- Codex SDK stores threads in `~/.codex/sessions/`
- Our database just references these external sessions
- If SDK session is lost, fallback to manual history

### Working Directory Changes

If a worker is restarted with a different working directory:

- The session record is updated with the new directory
- SDK sessions still reference the old directory (acceptable)
- Simple AI history remains valid
- A warning is logged for debugging

### Concurrent Workers

Multiple workers of the same type can join the same channel with independent sessions:

- Session key includes `agent_handle` (e.g., `@claude`, `@codex`)
- Database enforces UNIQUE constraint on `(workspace_id, channel_name, agent_handle)`
- Each worker gets its own independent session

## Performance

### Database Efficiency

- Indexed queries on `(session_key, timestamp)` for fast history retrieval
- Connection pooling via `@natstack/runtime` db module
- WAL (Write-Ahead Logging) for concurrent access
- Minimal overhead: one session record per agent per channel

### Message History Limits

For Simple AI responder:
- Default sliding window: last 20 messages (~4KB text)
- Configurable per responder
- No automatic cleanup (sessions preserved for historical reference)

## Examples

### Full Integration Pattern (Claude Code)

```typescript
import { SessionManager } from "@natstack/agentic-messaging";

async function setupSessionManager(channelName: string, handle: string) {
  const sessionManager = new SessionManager({
    workspaceId: process.env["NATSTACK_WORKSPACE_ID"] || "default",
    channelName,
    agentHandle: handle,
    sdkType: "claude-agent-sdk",
    workingDirectory: process.env["NATSTACK_WORKSPACE"],
  });

  await sessionManager.initialize();
  const sessionState = await sessionManager.getOrCreateSession();

  if (sessionState.sdkSessionId) {
    console.log(`Resuming Claude session: ${sessionState.sdkSessionId}`);
  }

  return sessionManager;
}

async function queryWithSession(
  sessionManager: SessionManager,
  userText: string
) {
  const sessionState = sessionManager.getSessionState();

  const queryInstance = query({
    prompt: userText,
    options: {
      ...(sessionState?.sdkSessionId && { resume: sessionState.sdkSessionId }),
      // ... other options
    },
  });

  for await (const message of queryInstance) {
    if (message.type === "result" && message.session_id) {
      await sessionManager.commitMessage(0, message.session_id);
    }
    // ... handle message
  }
}
```

## Troubleshooting

### Session Not Resuming

1. **Check workspace ID**: Verify `NATSTACK_WORKSPACE_ID` env var is set correctly
2. **Check database path**: Ensure `~/.config/natstack/workspace-data/<workspace-id>/sessions.db` exists
3. **Check session key**: Verify workspace:channel:handle combination is consistent
4. **Check SDK session**: For Claude/Codex, verify SDK session files exist in their respective homes

### Duplicate Processing

If messages are being processed twice:

1. **Check pubsub message ID**: Ensure `commitMessage()` is called with correct message ID
2. **Check replay filtering**: Verify `event.kind === "replay"` check is in place
3. **Check handler idempotency**: Ensure message handlers are idempotent

### Missing History

For Simple AI responder:

1. **Check storeMessage calls**: Verify messages are stored before/after processing
2. **Check sliding window**: History may be limited to last N messages
3. **Check session isolation**: Different handles = different histories

## Future Enhancements

Possible improvements for future versions:

1. **Automatic Summarization**: Summarize old messages to reduce history size
2. **Cross-Workspace Sessions**: Allow sessions to span multiple channels
3. **Manual History Pruning**: API to clean old messages
4. **Session Metadata**: Custom metadata per session
5. **Analytics**: Query session metrics and usage patterns

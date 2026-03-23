# @natstack/harness

Shared type definitions for the NatStack agentic harness messaging system. This is a pure types package with no runtime code.

## Type Flow

```
Panel --> Channel DO --> Worker DO (ChannelEvent) --> Server --> Harness (HarnessCommand) --> HarnessOutput --> Worker DO --> Channel DO
```

1. **Panel** sends user messages via the **Channel DO**
2. **Channel DO** delivers events to subscribed worker DOs as `ChannelEvent` (via `callDO()`)
3. Worker DO processes the event and calls server/channel APIs directly
4. For harness operations, the DO calls the server which sends `HarnessCommand` to the harness process
5. Harness emits `HarnessOutput` events as it streams a response
6. Server feeds harness output back to the DO via DODispatch
7. DO calls channel APIs directly (e.g., sending messages back via the Channel DO)

## HarnessOutput (19 variants)

Events emitted by a harness process back to the server:

| Type | Description |
|------|-------------|
| `thinking-start` | Signals the start of an extended thinking block |
| `thinking-delta` | Incremental content within a thinking block |
| `thinking-end` | Signals the end of a thinking block |
| `text-start` | Signals the start of a text response; may include metadata |
| `text-delta` | Incremental text content of the response |
| `text-end` | Signals the end of a text response block |
| `action-start` | A tool use has begun; includes tool name, description, and toolUseId |
| `action-end` | A tool use has completed |
| `inline-ui` | Arbitrary inline UI data to render in the chat |
| `subagent-start` | A subagent has been spawned for a tool use |
| `subagent-event` | An event from a running subagent |
| `subagent-end` | A subagent has completed |
| `approval-needed` | The harness is paused, waiting for tool approval |
| `message-complete` | A single message (possibly multi-block) is complete |
| `turn-complete` | The entire turn is finished; includes session ID and optional usage metrics |
| `error` | An error occurred; includes message and optional error code |
| `metadata-update` | Updated metadata for the current session |
| `ready` | The harness process has initialized and is ready to accept commands |

## HarnessCommand (5 variants)

Commands sent from the server to a harness process:

| Type | Description |
|------|-------------|
| `start-turn` | Begin a new AI turn with the provided `TurnInput` |
| `approve-tool` | Respond to an `approval-needed` event; allow or deny a tool use |
| `interrupt` | Cancel the current turn |
| `fork` | Fork the conversation at a specific message ID with a new session |
| `dispose` | Shut down the harness process |

## WorkerAction (14 variants)

Actions returned by worker DOs for the server to execute. Grouped by target:

### Channel operations (7)

| Operation | Description |
|-----------|-------------|
| `send` | Send a new message to a channel |
| `update` | Update an existing message's content |
| `complete` | Mark a message as complete |
| `call-method` | Invoke a method on another participant |
| `method-result` | Return the result of a method call |
| `update-metadata` | Update channel metadata |
| `send-ephemeral` | Send an ephemeral (non-persisted) message with a content type |

### Harness operations (1)

| Operation | Description |
|-----------|-------------|
| `command` | Send a `HarnessCommand` to a specific harness by ID |

### System operations (6)

| Operation | Description |
|-----------|-------------|
| `spawn-harness` | Create a new harness process with optional initial turn |
| `respawn-harness` | Restart a crashed harness, optionally resuming a session or retrying a turn |
| `spawn-subagent` | Spawn a subagent for a specific tool use |
| `cleanup-subagent` | Clean up a subagent after completion or failure |
| `set-alarm` | Schedule a delayed callback to the worker DO |

## Supporting Types

| Type | Description |
|------|-------------|
| `TurnUsage` | Token usage metrics (input, output, cache read/write) |
| `HarnessSettings` | Per-turn settings (model, system prompt, max tokens, temperature) |
| `HarnessConfig` | Full harness configuration including MCP servers and adapter config |
| `Attachment` | File or data attachment on a user message |
| `ChannelEvent` | A channel event as delivered to a worker DO |
| `SendOptions` | Options for channel send actions (type, persist, metadata, reply-to) |
| `TurnInput` | Input for starting a new AI turn (content, sender, context, attachments, settings) |
| `WorkerActions` | Wrapper containing an array of `WorkerAction` |
| `ParticipantDescriptor` | Channel participant identity with handle, name, type, and advertised methods |
| `MethodAdvertisement` | A method callable by other participants |
| `SpawnHarnessOpts` | Options for spawning a fresh harness |
| `RespawnHarnessOpts` | Options for respawning a crashed harness |
| `SubagentOpts` | Options for spawning a subagent |
| `UnsubscribeResult` | Result from unsubscribing a channel; lists affected harness IDs |

# API Reference

## SessionManager (from `@workspace/agentic-core`)

Core session orchestrator. No React, no browser APIs.

### Constructor

```typescript
new SessionManager(config: SessionManagerConfig)
```

```typescript
interface SessionManagerConfig {
  config: ConnectionConfig;           // serverUrl, token, clientId, optional rpc
  metadata?: ChatParticipantMetadata; // defaults to { name: "Headless Client", type: "panel", handle: "headless" }
  eventMiddleware?: EventMiddleware[]; // middleware pipeline for incoming events
  scopeManager?: ScopeManager;        // optional, for eval-backed scope persistence
  sandbox?: SandboxConfig;            // optional, for eval support
}
```

### Lifecycle

| Method | Description |
|--------|-------------|
| `connect(channelId, options?)` | Connect to a PubSub channel. Options: `methods`, `channelConfig`, `contextId` |
| `disconnect()` | Disconnect from channel |
| `dispose()` | Sync best-effort teardown (fire-and-forget scope persist) |
| `close()` | Async teardown (awaits scope persist, then disconnects) |

### Communication

| Method | Description |
|--------|-------------|
| `send(text, options?)` | Send a message. Options: `attachments`, `idempotencyKey`. Returns `messageId` |
| `interrupt(agentId)` | Interrupt an agent (sends "pause" method call) |
| `callMethod(participantId, method, args)` | Call a method on another participant |
| `loadEarlierMessages()` | Load older messages (pagination) |
| `startTyping()` | Send typing indicator |
| `stopTyping()` | Clear typing indicator |

### State (read-only)

| Getter | Type |
|--------|------|
| `messages` | `readonly ChatMessage[]` |
| `participants` | `Record<string, Participant<ChatParticipantMetadata>>` |
| `allParticipants` | Same, including historical (disconnected) participants |
| `methodHistory` | `ReadonlyMap<string, MethodHistoryEntry>` |
| `connected` | `boolean` |
| `status` | `string` |
| `channelId` | `string \| null` |
| `contextId` | `string \| undefined` |
| `hasMoreHistory` | `boolean` |
| `loadingMore` | `boolean` |
| `scope` | `Record<string, unknown>` |
| `scopeManager` | `ScopeManager \| null` |
| `scopesApi` | `ScopesApi \| null` |
| `client` | `PubSubClient \| null` (escape hatch) |
| `debugEvents` | `readonly (AgentDebugPayload & { ts: number })[]` |
| `dirtyRepoWarnings` | `ReadonlyMap<string, DirtyRepoDetails>` |
| `pendingAgents` | `ReadonlyMap<string, PendingAgent>` |

### Mutation API (for adapter layers)

| Method | Description |
|--------|-------------|
| `updateMessages(updater)` | Update messages with `(prev) => next` function |
| `dispatchMessageAction(action)` | Dispatch raw message window action |
| `addMethodHistoryEntry(entry)` | Add a method history entry |
| `updateMethodHistoryEntry(callId, updates)` | Update an existing entry |
| `handleMethodResult(result)` | Process a method result |
| `clearMethodHistory()` | Clear all method history |
| `addPendingAgent(handle, agentId)` | Track a pending agent |
| `dismissDirtyRepoWarning(handle)` | Remove a dirty repo warning |
| `setScopeManager(mgr)` | Set/replace scope manager (for deferred init) |
| `buildChatSandboxValue()` | Build a ChatSandboxValue for tool providers |

### Events

Subscribe with `manager.on(event, handler)` — returns an unsubscribe function.

| Event | Payload |
|-------|---------|
| `messagesChanged` | `(messages: readonly ChatMessage[])` |
| `participantsChanged` | `(participants: Record<string, Participant>)` |
| `allParticipantsChanged` | `(participants: Record<string, Participant>)` |
| `methodHistoryChanged` | `(entries: ReadonlyMap<string, MethodHistoryEntry>)` |
| `connectionChanged` | `(connected: boolean, status: string)` |
| `pendingAgentsChanged` | `(agents: ReadonlyMap<string, PendingAgent>)` |
| `debugEvent` | `(event: AgentDebugPayload & { ts: number })` |
| `dirtyRepoWarning` | `(handle: string, details: DirtyRepoDetails)` |
| `scopeDirty` | `()` |
| `error` | `(error: Error)` |

---

## HeadlessSession (from `@workspace/agentic-session`)

Thin wrapper over SessionManager with headless defaults.

### Static Constructors

```typescript
// Simple creation (call connect() separately)
HeadlessSession.create(config: HeadlessSessionConfig): HeadlessSession

// All-in-one: create channel + subscribe agent + connect
HeadlessSession.createWithAgent(config: HeadlessWithAgentConfig): Promise<HeadlessSession>
```

### HeadlessSessionConfig

```typescript
interface HeadlessSessionConfig {
  config: ConnectionConfig;
  metadata?: ChatParticipantMetadata;
  sandbox?: SandboxConfig;        // enables eval + auto scope persistence
  scopeManager?: ScopeManager;    // override auto-created scope manager
  systemPrompt?: string;          // override default headless prompt
}
```

### HeadlessWithAgentConfig

Extends `HeadlessSessionConfig` with:

```typescript
interface HeadlessWithAgentConfig extends HeadlessSessionConfig {
  rpcCall: (target: string, method: string, ...args: unknown[]) => Promise<unknown>;
  source: string;           // worker source (e.g., "agent-worker")
  className: string;        // DO class (e.g., "AiChatWorker")
  objectKey?: string;       // auto-generated if omitted
  contextId: string;
  channelId?: string;       // auto-generated if omitted
  channelConfig?: ChannelConfig;
  methods?: Record<string, MethodDefinition>;  // merged with default eval/set_title
  extraConfig?: Record<string, unknown>;
}
```

### Headless-Specific Methods

| Method | Description |
|--------|-------------|
| `waitForAgentMessage(opts?)` | Wait for a complete agent message. Options: `timeout` (default 60s) |
| `getRecommendedHarnessConfig()` | Returns `{ toolAllowlist, systemPrompt, systemPromptMode }` |
| `getRecommendedChannelConfig()` | Returns `{ approvalLevel: 2 }` (full-auto) |
| `manager` | Access the underlying SessionManager |

All SessionManager methods (send, interrupt, connect, close, etc.) are also available directly on HeadlessSession.

---

## Channel Helpers (from `@workspace/agentic-session`)

```typescript
// Get recommended harness config (conditional on eval availability)
getRecommendedHarnessConfig(opts?: { systemPrompt?: string; hasEval?: boolean })

// Get recommended channel config (full-auto approval)
getRecommendedChannelConfig(): Partial<ChannelConfig>

// Subscribe a DO agent with headless defaults
subscribeHeadlessAgent(opts: SubscribeHeadlessAgentOptions): Promise<{ ok: boolean; participantId?: string }>
```

---

## Headless System Prompts

| Constant | When Used |
|----------|-----------|
| `HEADLESS_SYSTEM_PROMPT` | Sandbox available — references eval + set_title |
| `HEADLESS_NO_EVAL_PROMPT` | No sandbox — references only set_title |

The `systemPromptMode` is always `"replace-natstack"` — replaces the NatStack panel prompt but still appends to SDK defaults.

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
  metadata?: ChatParticipantMetadata; // defaults to { name: "Headless Client", type: "headless", handle: "headless" }
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
  metadata?: ChatParticipantMetadata;  // defaults to type:"headless"
  sandbox?: SandboxConfig;              // enables eval + auto scope persistence
  scopeManager?: ScopeManager;          // override auto-created scope manager
}
```

To customize the agent's system prompt, edit the workspace's
`<contextFolder>/.pi/AGENTS.md` file *before* spawning the session. The
`systemPrompt`/`systemPromptMode`/`temperature` fields were removed in
Phase 5 — Pi handles the prompt and runtime tuning itself.

### HeadlessWithAgentConfig

Extends `HeadlessSessionConfig` with:

```typescript
interface HeadlessWithAgentConfig extends HeadlessSessionConfig {
  rpcCall: (target: string, method: string, ...args: unknown[]) => Promise<unknown>;
  source: string;           // worker source (e.g., "workers/agent-worker")
  className: string;        // DO class (e.g., "AiChatWorker")
  objectKey?: string;       // auto-generated if omitted
  contextId: string;
  channelId?: string;       // auto-generated if omitted
  channelConfig?: ChannelConfig;
  methods?: Record<string, MethodDefinition>;  // merged with default eval/set_title
  /**
   * Pi-native pass-through subscription config. Allowed keys: model,
   * thinkingLevel, approvalLevel.
   */
  extraConfig?: Record<string, unknown>;
}
```

`methods` lets you register additional client-side method definitions that the
agent will discover and can call. There is no longer any worker-side allowlist
filtering them out — channel membership is the trust boundary.

### Headless-Specific Methods

| Method | Description |
|--------|-------------|
| `waitForAgentMessage(opts?)` | Wait for a complete agent message. Options: `timeout` (default 60s) |
| `waitForIdle(opts?)` | Wait for the conversation to settle. Options: `timeout`, `debounce` |
| `sendAndWait(text, opts?)` | Send a message and wait for the agent to finish responding |
| `getRecommendedChannelConfig()` | Returns `{ approvalLevel: 2 }` (full-auto) |
| `manager` | Access the underlying SessionManager |

All SessionManager methods (send, interrupt, connect, close, etc.) are also available directly on HeadlessSession.

---

## Channel Helpers (from `@workspace/agentic-session`)

```typescript
// Get recommended channel config (full-auto approval)
getRecommendedChannelConfig(): Partial<ChannelConfig>

// Subscribe a DO agent to a channel with full-auto approval.
// The agent uses the same harness config and system prompt as panel sessions —
// no extra restrictions are applied.
subscribeHeadlessAgent(opts: SubscribeHeadlessAgentOptions): Promise<{ ok: boolean; participantId?: string }>
```

```typescript
interface SubscribeHeadlessAgentOptions {
  rpcCall: (target: string, method: string, ...args: unknown[]) => Promise<unknown>;
  source: string;        // e.g., "workers/agent-worker"
  className: string;     // e.g., "AiChatWorker"
  objectKey: string;
  channelId: string;
  contextId: string;
  /**
   * Pi-native pass-through subscription config. Allowed keys: model,
   * thinkingLevel, approvalLevel.
   */
  extraConfig?: Record<string, unknown>;
}
```

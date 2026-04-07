# Architecture

## Layer Diagram

```
@workspace/agentic-core          ← all business logic, no React
  SessionManager class
  - connection lifecycle (connect, event loop, reconnect, roster)
  - message state (messageWindowReducer, pagination, auto-trim)
  - method history tracking (with auto-pruning)
  - event dispatch routing (middleware pipeline)
  - roster tracking (disconnect detection, typing cleanup, expected stops)
  - pending agent timeouts (45s)
  - typed event emitter for state changes
  - scope management (scopeDirty events, persist lifecycle)
  - types: ChatMessage, ChatParticipantMetadata, ConnectionConfig, etc.
  - SandboxConfig factory: createPanelSandboxConfig

@workspace/agentic-chat          ← thin React adapter
  useChatCore() creates SessionManager internally
  - subscribes to events → pipes into useState
  - adds React-only concerns: input state, pending images,
    document.title, inline UI compilation, tool approval UI
  useAgenticChat() composes useChatCore + feature hooks

@workspace/agentic-session       ← thin headless convenience
  HeadlessSession = SessionManager + headless defaults
  - full-auto channel config (approval level 2)
  - automatic ScopeManager creation when sandbox provided
  - default eval + set_title method registration on the client
  - convenience: createWithAgent() does subscribe + connect in one call
  - SandboxConfig factory: createRpcSandboxConfig (workers + Node servers)
  - Uses the same agent worker prompt and tool surface as panel sessions;
    UI tools naturally drop out because no panel is advertising them.
```

## What Lives Where

**agentic-core** (no React, no tool-ui, no browser APIs):
- `SessionManager` — the single source of truth for session state
- `ConnectionManager` — PubSub connection lifecycle
- `MessageState` — message window with reducer, pagination, auto-trim
- `MethodHistoryTracker` — method call lifecycle with pruning
- `dispatchAgenticEvent` — event router with middleware
- `TypedEmitter` — lightweight typed event emitter
- `messageWindowReducer` — pure reducer (also used by React adapter)
- Headless-safe types: `ChatMessage`, `ChatParticipantMetadata`, `ConnectionConfig`, `SandboxConfig`, `ToolProviderDeps`, `MethodHistoryEntry`, etc.
- `createPanelSandboxConfig(rpc, db)` — panel SandboxConfig factory

**agentic-session** (no React, no browser APIs):
- `HeadlessSession` — SessionManager + headless defaults
- `getRecommendedChannelConfig()` — full-auto approval channel config
- `subscribeHeadlessAgent()` — subscribe a DO agent to a channel with full-auto approval
- `createRpcSandboxConfig(rpc)` — sandbox factory for any non-panel context with an RPC bridge

**agentic-chat** (React adapter):
- `useChatCore()` — creates SessionManager, subscribes to events, returns React state
- `useAgenticChat()` — composes useChatCore + feedback/tools/debug/inlineUi hooks
- UI-only types: `ChatContextValue`, `ChatInputContextValue`, `InlineUiComponentEntry`
- UI-only hooks: `useChatFeedback`, `useChatTools`, `useChatDebug`, `useInlineUi`

## SessionManager Event Flow

```
PubSub Server
  ↓ WebSocket
ConnectionManager
  ↓ onEvent / onAggregatedEvent / onRoster / onReconnect
SessionManager
  ├─ dispatchAgenticEvent → MessageState, MethodHistoryTracker
  ├─ handleRoster → participants, disconnect messages, typing cleanup
  ├─ handleReconnect → clear historical participants
  └─ emits typed events:
      messagesChanged, participantsChanged, allParticipantsChanged,
      methodHistoryChanged, connectionChanged, pendingAgentsChanged,
      debugEvent, dirtyRepoWarning, scopeDirty, error
            ↓
React adapter (useChatCore) subscribes → useState
            ↓
React components re-render
```

## Teardown Contract

SessionManager provides two teardown paths:

- **`dispose(): void`** — synchronous best-effort. Scope persist is fire-and-forget. Use for browser panels where the tab is closing.
- **`close(): Promise<void>`** — awaitable. Flushes dirty scope to DB, then disconnects. Use for headless consumers (workers, tests, servers).
- **`Symbol.asyncDispose`** — supports `await using session = ...` syntax.

## Scope Ownership

SessionManager owns the ScopeManager when provided. It:
- Wires `onChange` to emit `scopeDirty` events
- Persists on `close()` / `dispose()`
- Does NOT register browser lifecycle listeners (`beforeunload`, `visibilitychange`) — those belong in the React adapter layer

The React adapter (`useAgenticChat`) adds browser lifecycle persistence on top.

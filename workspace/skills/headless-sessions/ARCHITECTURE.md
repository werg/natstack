# Architecture

## Layer Diagram

```
@workspace/agentic-core          ← shared business logic, no React
  - typed agentic event → ChannelViewState reducer
  - ChannelViewState → ChatMessage / InvocationCard / ApprovalCard / InlineUiCard selectors
  - connection primitives and sandbox factories
  - types: ChatMessage, ChatParticipantMetadata, ConnectionConfig, etc.

@workspace/agentic-chat          ← thin React adapter
  useChatCore() owns the PubSubClient lifecycle
  - useChannelMessages() subscribes with replay and live events
  - adds React-only concerns: input state, pending images,
    document.title, inline UI/action-bar compilation, tool approval UI
  useAgenticChat() composes useChatCore + feature hooks

@workspace/agentic-session       ← thin headless convenience
  HeadlessSession = PubSub connection + the same typed reducer/selector path
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
- `ConnectionManager` — PubSub connection lifecycle
- `useChannelMessages` / `HeadlessSession` — reduce typed PubSub channel events
  into the same channel view model
- `TypedEmitter` — lightweight typed event emitter
- `chatMessagesFromChannelView` — single selector that projects messages,
  invocation cards, inline UI, and related transcript models
- Headless-safe types: `ChatMessage`, `ChatParticipantMetadata`, `ConnectionConfig`, `SandboxConfig`, `ToolProviderDeps`, etc.
- `createPanelSandboxConfig(rpc)` — panel SandboxConfig factory

**agentic-session** (no React, no browser APIs):
- `HeadlessSession` — headless PubSub client + typed channel reducer
- `getRecommendedChannelConfig()` — full-auto approval channel config
- `subscribeHeadlessAgent()` — subscribe a DO agent to a channel with full-auto approval
- `createRpcSandboxConfig(rpc)` — sandbox factory for any non-panel context with an RPC bridge

**agentic-chat** (React adapter):
- `useChatCore()` — owns the PubSub client, subscribes to the typed channel log, returns React state
- `useAgenticChat()` — composes useChatCore + feedback/tools/debug/inlineUi hooks
- UI-only types: `ChatContextValue`, `ChatInputContextValue`, `InlineUiComponentEntry`
- UI-only hooks: `useChatFeedback`, `useChatTools`, `useChatDebug`, `useInlineUi`

## Transcript Event Flow

```
Producer
  ↓ send()/publish()
PubSub channel log
  ↓ WebSocket
ConnectionManager
  ↓ events(includeReplay)
Typed Agentic Event Reducer
  ↓ ChannelViewState
chatMessagesFromChannelView / actionBarPayloadFromChannelView
  ↓
React adapter (useChatCore/useAgenticChat)
  ↓
React components re-render
```

The transcript source is the PubSub channel log. Initial prompts, user messages,
agent responses, invocation updates, approvals, inline UI, and action bars all
enter the UI through typed channel events and the same reducer/selector path.
Do not add hidden transcript side channels or merge legacy method history into
React state.

GAD stores private branchable provenance separately from transmitted channel
history. When a trajectory event is published to a channel, GAD records a
`trajectory_channel_publications` row so tools can join:

```
trajectory_events.event_id
  → trajectory_channel_publications.envelope_id
  → channel_envelopes.envelope_id
```

Use that join for audits, side-task forks, and “what did the user actually see?”
queries. Keep roster/debug streams separate unless they are rendered in the
transcript UX.

## Teardown Contract

SessionManager provides two teardown paths:

- **`dispose(): void`** — synchronous best-effort. Scope persist is fire-and-forget. Use for browser panels where the tab is closing.
- **`close(): Promise<void>`** — awaitable. Flushes dirty scope through the `scope` RPC service, then disconnects. Use for headless consumers (workers, tests, servers).
- **`Symbol.asyncDispose`** — supports `await using session = ...` syntax.

## Scope Ownership

SessionManager owns the ScopeManager when provided. It:
- Wires `onChange` to emit `scopeDirty` events
- Persists on `close()` / `dispose()`
- Does NOT register browser lifecycle listeners (`beforeunload`, `visibilitychange`) — those belong in the React adapter layer

The React adapter (`useAgenticChat`) adds browser lifecycle persistence on top.

Scope snapshots are persisted by the server-side `scope` service backed by
`ScopeStoreDO`; sessions no longer use a userland database proxy.

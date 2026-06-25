# API Reference

## HeadlessSession (from `@workspace/agentic-session`)

The headless session wrapper. No React, no browser APIs. Internally it drives a
`ConnectionManager` (from `@workspace/agentic-core`) and projects the channel log
through the same typed reducer/selectors the panel UI uses.

The session is a channel client only. The agent's own tools — including `eval`
(server-side in the agent's per-channel `EvalDO`), file tools, and web tools —
come from the agent worker, not from this session. The session registers only a
`set_title` method by default.

### Static Constructors

```typescript
// Simple creation (call connect() separately)
HeadlessSession.create(config: HeadlessSessionConfig): HeadlessSession

// All-in-one: create channel + connect client + subscribe agent
HeadlessSession.createWithAgent(config: HeadlessWithAgentConfig): Promise<HeadlessSession>
```

### HeadlessSessionConfig

```typescript
interface HeadlessSessionConfig {
  config: ConnectionConfig;             // { clientId, rpc }, where rpc is the full portable RpcClient
  metadata?: ChatParticipantMetadata;   // defaults to { name: "Headless Client", type: "headless", handle: "headless" }
  sandbox?: SandboxConfig;              // optional; only backs local chat-sandbox helpers (callMethod, etc.) — NOT the agent's eval
}
```

`sandbox` is optional and does not enable or disable the agent's eval. The agent
evaluates code in its own server-side `EvalDO` whether or not a session sandbox
is provided.

When passing `config: { clientId, rpc }`, `rpc` must be the normal runtime
client shape used by panels/workers/eval: it includes `selfId`,
`call(target, method, args)`, and event subscription support such as `on(...)`.
For server-side eval, worker, and Durable Object callers, pass
`clientId: rpc.selfId`. PubSub authorizes those connectionless callers by their
runtime identity, so an arbitrary client id will be rejected during channel
subscription. Panel integrations that have a distinct stable panel slot id may
use that slot id as their participant id.

### HeadlessWithAgentConfig

Extends `HeadlessSessionConfig` with:

```typescript
interface HeadlessWithAgentConfig extends HeadlessSessionConfig {
  rpcCall: (target: string, method: string, args: unknown[]) => Promise<unknown>;
  source: string;           // worker source (e.g., "workers/agent-worker")
  className: string;        // DO class (e.g., "AiChatWorker")
  objectKey?: string;       // auto-generated if omitted
  contextId: string;
  channelId?: string;       // auto-generated if omitted
  channelConfig?: ChannelConfig;
  methods?: Record<string, MethodDefinition>;  // merged with the default set_title method
  /**
   * Pi-native pass-through subscription config. Common keys: model,
   * thinkingLevel, approvalLevel, systemPrompt, systemPromptMode.
   */
  extraConfig?: AgentSubscriptionConfig;
}
```

`methods` lets you register additional client-side method definitions that the
agent will discover and can call. There is no worker-side allowlist filtering
them out — channel membership is the trust boundary.

To customize the agent's system prompt for a session, pass `systemPrompt` and
`systemPromptMode` through `extraConfig`.

### Lifecycle

| Method | Description |
|--------|-------------|
| `connect(channelId, options?)` | Connect to a PubSub channel. Options: `channelConfig`, `contextId`, `methods` |
| `disconnect()` | Abort the message consumer and disconnect the client |
| `dispose()` | Sync best-effort teardown (disconnect + clear listeners) |
| `close(opts?)` | Async teardown: unsubscribe + retire the agent subscribed by `createWithAgent`, then dispose. Pass `{ waitForRemoteCleanup: false }` to detach local state immediately while remote cleanup continues best-effort. |
| `[Symbol.asyncDispose]()` | Supports `await using session = ...` (calls `close()`) |

### Communication

| Method | Description |
|--------|-------------|
| `send(text, options?)` | Publish a user message. Options: `attachments`, `idempotencyKey`. Returns `messageId` |
| `interrupt(agentId)` | Interrupt an agent (sends a `pause` method call) |
| `callMethod(participantId, method, args)` | Call a method on another participant and return the unwrapped provider payload |
| `callMethodResult(participantId, method, args)` | Call a method and return the full `ChatMethodResult` envelope |
| `loadEarlierMessages()` | No-op — channel replay already delivers the full persisted history |

### State (read-only)

| Getter | Type |
|--------|------|
| `messages` | `readonly ChatMessage[]` |
| `participants` | `Record<string, Participant<ChatParticipantMetadata>>` |
| `allParticipants` | Same (headless sessions don't track separate historical roster) |
| `connected` | `boolean` |
| `status` | `string` |
| `channelId` | `string \| null` |
| `isStreaming` | `boolean` (any message still incomplete) |
| `debugEvents` | `readonly (AgentDebugPayload & { ts: number })[]` |
| `client` | `PubSubClient \| null` (escape hatch) |

Invocation/tool-call diagnostics are exposed through `messages`: entries with
`contentType: "invocation"` have a parsed `message.invocation` payload with
name, arguments, progress/output, result, and error state. `snapshot()` also
projects these into an `invocations` array.

Custom message types are visible through `messages` as entries with
`contentType: "custom"` and a populated `message.custom` payload. To register or
publish custom message types from a headless session, use the underlying
`session.client` (PubSubClient) escape hatch — `registerMessageType`,
`publishCustomMessage`, `updateCustomMessage`, `clearMessageType`. The full
reference lives in
[`workspace/skills/sandbox/CUSTOM_MESSAGES.md`](../sandbox/CUSTOM_MESSAGES.md).
Headless sessions don't render React, so they only emit and observe the events;
the panel side does the rendering.

### Listeners

```typescript
// Fires on every channel update (including streaming deltas). Returns an unsubscribe fn.
onMessage(listener: (latest: ChatMessage) => void): () => void
```

### Headless-Specific Helpers

| Method | Description |
|--------|-------------|
| `waitForAgentMessage(opts?)` | Resolve with the next complete agent message. Options: `timeoutMs`, `signal`. Rejects on an agent failure message |
| `waitForIdle(opts?)` | Resolve once the agent settles (no new messages for `debounce` ms and no open agent turn). Options: `debounce` (default 3000), `timeoutMs`, `signal` |
| `sendAndWait(text, opts?)` | `send(text)` then `waitForIdle(opts)` |
| `getRecommendedChannelConfig()` | Returns `{ approvalLevel: 2 }` (full-auto) |
| `snapshot()` | Diagnostic snapshot: messages, invocations, debugEvents, cleanupErrors, participants, localMethodNames, connected, duration |

---

## ConnectionManager (from `@workspace/agentic-core`)

The lower-level PubSub connection primitive that `HeadlessSession` is built on.
Use it directly only when you need to connect to a channel without the headless
conveniences (auto agent subscription, `set_title`, the wait helpers, the
transcript projection). Constructed with `{ config, metadata, callbacks }`; its
`connect({ channelId, methods, channelConfig?, contextId? })` returns the
underlying `PubSubClient`.

---

## Channel Helpers (from `@workspace/agentic-session`)

```typescript
// Recommended channel config for headless sessions (full-auto approval, level 2)
getRecommendedChannelConfig(): Partial<ChannelConfig>

// Subscribe a DO agent to a channel with headless defaults (full-auto approval).
// The agent uses the same harness config and system prompt as panel sessions.
subscribeHeadlessAgent(opts: SubscribeHeadlessAgentOptions): Promise<HeadlessAgentSubscription>
```

```typescript
interface SubscribeHeadlessAgentOptions {
  rpcCall: (target: string, method: string, args: unknown[]) => Promise<unknown>;
  source: string;        // e.g., "workers/agent-worker"
  className: string;     // e.g., "AiChatWorker"
  objectKey: string;
  channelId: string;
  contextId: string;
  /**
   * Pi-native pass-through subscription config. Common keys: model,
   * thinkingLevel, approvalLevel, systemPrompt, systemPromptMode.
   */
  extraConfig?: AgentSubscriptionConfig;
}

interface HeadlessAgentSubscription {
  ok: boolean;
  participantId?: string;
  entityId: string;   // pass to retireHeadlessAgent
  targetId: string;   // pass to unsubscribeHeadlessAgent
}
```

`subscribeHeadlessAgent` creates the agent entity and subscribes it; pair it with
`unsubscribeHeadlessAgent({ rpcCall, targetId, channelId })` and
`retireHeadlessAgent({ rpcCall, entityId })` for cleanup. `createWithAgent` /
`close()` do this wiring for you. Harnesses that must not be held by a wedged
remote agent can call `close({ waitForRemoteCleanup: false })`; this disposes
the local PubSub connection synchronously and starts unsubscribe/retire cleanup
without awaiting it.

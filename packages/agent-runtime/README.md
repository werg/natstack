# @natstack/agent-runtime

Runtime framework for NatStack agents. Provides the `Agent` base class, state management, and deployment-specific adapters.

## Architecture Overview

The runtime is designed with a clean separation between:

1. **Core abstractions** - Deployment-agnostic interfaces that agents program against
2. **Runtime adapters** - Deployment-specific implementations (currently Electron only)

```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent<S> Base Class                        │
│  - state, settings, lifecycle hooks                             │
│  - this.client (outgoing messaging)                             │
│  - this.storage, this.ai (via RuntimeContext)                   │
│  - onEvent() called by runtime                                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     RuntimeContext                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ StorageApi  │  │  EventBus   │  │ AiProvider  │              │
│  │             │  │ (outgoing)  │  │             │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└────────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
     ┌─────────────────┐          ┌─────────────────┐
     │ Electron        │          │ Future Runtime  │
     │ Adapters        │          │ (e.g., DO)      │
     │ - RPC storage   │          │ - Direct SQL    │
     │ - WebSocket bus │          │ - HTTP bus      │
     │ - RPC AI        │          │ - Direct AI     │
     └─────────────────┘          └─────────────────┘
```

## Core Abstractions

These interfaces define what agents can use, independent of deployment target:

### StorageApi (`abstractions/storage.ts`)

Unified database interface for state persistence.

```typescript
interface StorageApi {
  exec(sql: string): void | Promise<void>;
  run(sql: string, params?: unknown[]): RunResult | Promise<RunResult>;
  get<T>(sql: string, params?: unknown[]): T | null | Promise<T | null>;
  query<T>(sql: string, params?: unknown[]): T[] | Promise<T[]>;
  flush(): void | Promise<void>;
}
```

Methods return sync or Promise to support both:
- **Electron**: Async RPC to host process with better-sqlite3
- **Future runtimes**: Potentially sync (e.g., Cloudflare DO's `ctx.storage.sql`)

### EventBus (`abstractions/event-bus.ts`)

Outgoing messaging operations. This is a subset of AgenticClient focused on what agents need to send.

```typescript
interface EventBus {
  // Messaging
  send(content: string, options?): Promise<SendResult>;
  update(id: string, content: string, options?): Promise<number | undefined>;
  complete(id: string): Promise<number | undefined>;
  error(id: string, error: string, code?: string): Promise<number | undefined>;
  publish(eventType: string, payload: unknown, options?): Promise<void>;

  // Methods (RPC)
  callMethod(providerId, methodName, args, options?): MethodCallHandle;

  // Roster & identity
  readonly roster: Record<string, Participant>;
  readonly handle: string;
  readonly clientId: string | null;

  // ... and more (settings, lifecycle, etc.)
}
```

**Important**: EventBus handles OUTGOING operations only. Event RECEPTION is handled differently per runtime:
- **Electron**: WebSocket subscription (pull model) → `agent.onEvent()`
- **Future runtimes**: Could be HTTP push → `agent.onEvent()`

### AiProvider (`abstractions/ai-provider.ts`)

LLM streaming interface with cancellation support.

```typescript
interface AiProvider {
  listRoles(): Promise<AIRoleRecord>;
  streamText(options: StreamTextOptions): StreamHandle;
  generateText(options: StreamTextOptions): Promise<GenerateResult>;
}

interface StreamHandle {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  cancel(): void;
  readonly done: Promise<StreamResult>;
  readonly streamId: string;
}
```

### RuntimeContext (`abstractions/runtime-context.ts`)

Combines all services into a single injectable context.

```typescript
interface RuntimeContext {
  readonly storage: StorageApi;
  readonly eventBus: EventBus;
  readonly ai: AiProvider;
  readonly log: AgentLogger;

  readonly agentId: string;
  readonly channel: string;
  readonly handle: string;
  readonly config: Record<string, unknown>;

  readonly mode: 'electron' | 'durable-object' | string;
  readonly checkpoint: number | undefined;
}
```

## Event Filtering (`abstractions/event-filter.ts`)

Shared logic for filtering events before delivery to agents. Used by all runtimes to ensure consistent behavior.

```typescript
function shouldYieldEvent(event: EventStreamItem, ctx: EventFilterContext): boolean;
function isAgentDebugEvent(event: EventStreamItem): boolean;
```

## Auto-Checkpoint

The runtime automatically advances checkpoints when events are received. Agents don't manage checkpoints manually.

**Semantics: "I've received it"**

The checkpoint advances as soon as we see an event, regardless of whether processing succeeds. This provides at-most-once delivery - if a crash happens mid-processing, the event won't replay. Users can prompt the agent to recover if needed.

**What gets checkpointed:**

| Event | Checkpointed |
|-------|--------------|
| Any event with `pubsubId` | Yes |
| Filtered events (e.g., `targetedOnly`) | Yes (via `onFiltered` callback) |
| Ephemeral events | No (no `pubsubId`) |

The `kind` field (`persisted` vs `replay`) is informational only - both checkpoint the same way. Replay events represent historical data being re-delivered; once we've seen them, we checkpoint to avoid infinite replay loops.

**Agent responsibility:**
- Be idempotent where possible (network duplicates can still happen)
- Persist critical state before returning from `onEvent()` if stronger guarantees needed

## Current Implementation: Electron

Located in `electron/`:

| File | Purpose |
|------|---------|
| `electron-storage.ts` | Wraps RPC DatabaseInterface → StorageApi |
| `ws-event-bus.ts` | Wraps AgenticClient → EventBus |
| `rpc-ai-provider.ts` | Wraps @natstack/ai → AiProvider |
| `create-runtime.ts` | Factory to create ElectronRuntimeContext |
| `event-source.ts` | WebSocket event loop → agent.onEvent() |

The main entry point `runtime.ts` (at package root) is Electron-specific - it:
- Sets up RPC bridge via parentPort
- Creates DB client
- Connects to pubsub via WebSocket
- Runs the event loop

## Implementing a New Runtime Target

To add support for a new deployment target (e.g., Cloudflare Durable Objects):

### 1. Create adapter implementations

```
src/
└── {target}/
    ├── index.ts
    ├── {target}-storage.ts    # implements StorageApi
    ├── {target}-event-bus.ts  # implements EventBus
    ├── {target}-ai-provider.ts # implements AiProvider
    └── create-runtime.ts      # factory function
```

### 2. Implement StorageApi

For sync storage (like DO's `ctx.storage.sql`):
```typescript
function createDoStorage(ctx: DurableObjectState): StorageApi {
  return {
    exec(sql) { ctx.storage.sql.exec(sql); },
    run(sql, params) { return ctx.storage.sql.exec(sql, params); },
    get(sql, params) { return ctx.storage.sql.exec(sql, params).one(); },
    query(sql, params) { return ctx.storage.sql.exec(sql, params).toArray(); },
    flush() { /* no-op for sync storage */ },
  };
}
```

### 3. Implement EventBus

For HTTP-based messaging (push model):
```typescript
function createHttpEventBus(config: HttpEventBusConfig): EventBus {
  return {
    async send(content, options) {
      // POST to pubsub server
      const response = await fetch(`${config.serverUrl}/send`, {
        method: 'POST',
        body: JSON.stringify({ channel: config.channel, content, ...options }),
      });
      return response.json();
    },
    // ... implement other methods
  };
}
```

### 4. Implement AiProvider

For direct API calls:
```typescript
function createDirectAiProvider(config: { apiKey: string }): AiProvider {
  return {
    async listRoles() { return { default: 'claude-sonnet-4-...', ... }; },

    streamText(options) {
      const controller = new AbortController();
      // Return StreamHandle that fetches from Anthropic API
      // Use controller.signal for cancellation
    },

    async generateText(options) {
      // Non-streaming fetch to Anthropic API
    },
  };
}
```

### 5. Create runtime factory

```typescript
function createDoRuntime(config: DoRuntimeConfig): RuntimeContext {
  return createRuntimeContext({
    storage: createDoStorage(config.ctx),
    eventBus: createHttpEventBus(config.eventBusConfig),
    ai: createDirectAiProvider(config.aiConfig),
    log: createDoLogger(config.agentId),
    mode: 'durable-object',
    // ... other config
  });
}
```

### 6. Create entry point / wrapper

For DO, this would be the DurableObject class that:
- Handles HTTP requests (init, event push, shutdown)
- Creates RuntimeContext
- Instantiates agent and injects runtime
- Calls `agent.onEvent()` for incoming events
- Returns checkpoint in response

### Key Differences by Runtime

| Aspect | Electron | Durable Objects |
|--------|----------|-----------------|
| Event reception | Pull (WebSocket) | Push (HTTP POST) |
| Storage | Async RPC | Sync SQL |
| AI calls | RPC to host | Direct HTTP |
| State persistence | On timer/shutdown | After each request |
| Checkpoint | Runtime advances | Return in HTTP response |

## Known Limitations

1. **`runtime.ts` is Electron-specific** - Despite sitting at package root, it uses Electron-specific imports (RPC, parentPort, WebSocket connect). A cleaner design would move this to `electron/run-agent.ts`.

2. **Peer dependency on @natstack/ai** - The Electron adapter wraps this package. Future runtimes that call AI directly won't need it.

3. **Agent base class has some Electron assumptions** - Some protected methods assume the existence of certain runtime features.

## See Also

- `PHASE4-PLAN.md` - Original design document for runtime abstractions
- `packages/agentic-messaging/` - AgenticClient that EventBus wraps
- `workspace/agents/test-echo/` - Simple agent example

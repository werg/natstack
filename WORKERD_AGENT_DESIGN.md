# Design Space: Two-Tier Agent Architecture

## Overview

This document explores the design for restructuring NatStack's agent system into two tiers:

1. **Builtin agents** — Claude Code and Codex responders move out of `workspace/` into the core app, running as privileged Node.js processes with full system access.

2. **User-authored agents** — A new sandboxed runtime using workerd (via miniflare), where third-party agents can only interact with the system through explicitly granted capabilities.

---

## Part 1: Moving Claude/Codex to Builtin

### What "builtin" means

Today, Claude Code and Codex responders live in `workspace/agents/` alongside user-authored agents like `test-echo` and `pubsub-chat-responder`. They're discovered by `agentDiscovery.ts` scanning that directory, built by the V2 build system with esbuild targeting `node20`, and spawned as `utilityProcess`/`child_process` forks by `agentHost.ts`.

Making them "builtin" means:

1. **Source moves from `workspace/agents/` to `src/`** — they become part of the core application, not workspace-level code. They're compiled as part of the main build (`build.mjs`), not by the V2 build system.

2. **No longer discovered dynamically** — Instead of `agentDiscovery.ts` scanning the filesystem, the host knows about them statically. They're registered at startup, not discovered.

3. **Spawned differently** — They can be spawned directly by the host with richer initialization, without the generic `AgentInitConfig` protocol. The host can pass Node.js-specific resources (file descriptors, shared memory, direct function references in the Electron case).

4. **Full Node.js access is explicit and expected** — They can use `child_process`, `fs`, `http`, native modules, etc. This is not a sandbox escape — it's the intended runtime.

### Architectural changes

#### Build system

Currently: `workspace/agents/claude-code-responder/` → V2 build system → `{userData}/builds/{key}/bundle.mjs` → spawned by agentHost.

Proposed: `src/agents/claude-code-responder/` → `build.mjs` esbuild → `dist/agents/claude-code-responder.mjs` → spawned by agentHost directly.

The V2 build system continues to handle user-authored agents in `workspace/agents/`. Builtin agents are just another esbuild entry point in the main build, like `dist/server.mjs` or `dist/main.cjs`.

```
build.mjs targets (existing):
  dist/server.mjs              ← headless server
  dist/server-electron.cjs     ← electron utilityProcess server
  dist/main.cjs                ← electron main process
  dist/preload.cjs             ← preload scripts
  dist/renderer/               ← shell webview

build.mjs targets (new):
  dist/agents/claude-code.mjs  ← builtin Claude agent
  dist/agents/codex.mjs        ← builtin Codex agent
```

#### Agent host

`agentHost.ts` currently treats all agents uniformly. With builtin agents:

```typescript
// New: AgentHost knows about builtins statically
const BUILTIN_AGENTS = {
  "claude-code-responder": {
    bundlePath: path.join(__dirname, "agents/claude-code.mjs"),
    manifest: { /* static manifest */ },
  },
  "codex-responder": {
    bundlePath: path.join(__dirname, "agents/codex.mjs"),
    manifest: { /* static manifest */ },
  },
};

// spawn() checks builtins first, then falls back to V2-discovered agents
async spawn(agentId: string, options: SpawnOptions) {
  const builtin = BUILTIN_AGENTS[agentId];
  if (builtin) {
    return this.spawnBuiltin(builtin, options);
  }
  // ... existing V2 discovery + build path for workspace agents
}
```

#### Dependencies

The Claude and Codex SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`) become direct dependencies of the main app, not external deps installed per-build. They're listed in the root `package.json` and bundled by esbuild into the agent bundles.

The shared workspace packages they depend on (`@workspace/agent-runtime`, `@workspace/agent-patterns`, `@workspace/agentic-messaging`) continue to live in `workspace/packages/` and are resolved by esbuild as internal dependencies.

### What stays the same

- **Agent base class** — Builtin agents still extend `Agent<TState>` from `@workspace/agent-runtime`. The runtime, lifecycle, and state management are unchanged.
- **Pubsub communication** — They still connect to pubsub, discover tools, send messages. The `AgenticClient` interface is the same.
- **RPC bridge** — The host still provides database access and AI streaming via the RPC bridge.
- **ProcessAdapter** — Same process spawning abstraction. The only difference is where the bundle path comes from.

### Migration path

1. Copy agent source from `workspace/agents/{claude-code,codex}-responder/` to `src/agents/`.
2. Add esbuild entry points to `build.mjs`.
3. Register builtins in `agentHost.ts` with static manifests.
4. Update `agentDiscovery.ts` to skip builtin agent IDs during workspace scanning.
5. Remove original `workspace/agents/{claude-code,codex}-responder/` directories.
6. Move SDK dependencies from workspace agent `package.json` to root `package.json`.

This is a relatively straightforward refactor. The hard part is the next section.

---

## Part 2: User-Authored Agents in workerd

### Design goals

1. **Strong sandbox** — User-authored agents cannot access the host filesystem, spawn processes, or make arbitrary network requests. All capabilities are explicitly granted through bindings.

2. **Capability-based** — Agents receive only the interfaces they need: pubsub messaging, scoped storage, and optionally AI access. No ambient authority.

3. **Same Agent abstraction** — User agents still extend `Agent<TState>` and implement `onWake()`, `onEvent()`, `onSleep()`. The programming model is the same as today, minus Node.js access.

4. **Hot-reloadable** — Code changes in `workspace/agents/` trigger rebuilds and live reload the agent in workerd, matching the current development experience.

5. **Local-first** — Uses miniflare to embed workerd locally. No Cloudflare account or infrastructure required. The same agents could later deploy to Cloudflare Workers/DOs if desired, but that's not a goal right now.

### Runtime architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  NatStack Main Process (Node.js)                                │
│                                                                 │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐   │
│  │  AgentHost     │  │  PubSub       │  │  Build System V2  │   │
│  │  (manages      │  │  Server       │  │  (builds agents   │   │
│  │   lifecycles)  │  │               │  │   for workerd)    │   │
│  └───────┬───────┘  └───────────────┘  └───────────────────┘   │
│          │                                                      │
│          │  Spawn                                               │
│          ▼                                                      │
│  ┌───────────────────────────────────────────────────────┐      │
│  │  WorkerdHost (new)                                     │      │
│  │                                                        │      │
│  │  ┌──────────────────────────────────────────────────┐ │      │
│  │  │  Miniflare Instance                               │ │      │
│  │  │  (manages workerd process)                        │ │      │
│  │  │                                                   │ │      │
│  │  │  ┌─────────────┐  ┌─────────────┐                │ │      │
│  │  │  │ Agent Worker │  │ Agent Worker │  ...           │ │      │
│  │  │  │ (isolate)    │  │ (isolate)    │               │ │      │
│  │  │  └─────────────┘  └─────────────┘                │ │      │
│  │  └──────────────────────────────────────────────────┘ │      │
│  │                                                        │      │
│  │  Service Bindings (Node.js ↔ workerd):                │      │
│  │  ┌──────────────────────────────────────────────────┐ │      │
│  │  │  PUBSUB    → PubSub proxy service                 │ │      │
│  │  │  STORAGE   → SQLite-backed state service          │ │      │
│  │  │  AI        → AI provider proxy                    │ │      │
│  │  │  HOST      → Lifecycle & config service           │ │      │
│  │  └──────────────────────────────────────────────────┘ │      │
│  └───────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

### The WorkerdHost

A new component (`src/main/workerdHost.ts`) that manages the miniflare instance and maps between the existing `AgentHost` protocol and workerd workers.

```typescript
import { Miniflare } from "miniflare";

class WorkerdHost {
  private mf: Miniflare | null = null;
  private agents: Map<string, WorkerdAgent> = new Map();

  async start() {
    this.mf = new Miniflare({
      compatibilityDate: "2025-09-15",
      compatibilityFlags: ["nodejs_compat"],
      workers: [], // Populated dynamically
    });
    await this.mf.ready;
  }

  async spawnAgent(agentId: string, bundlePath: string, config: AgentInitConfig) {
    // Rebuild miniflare with new worker added
    await this.mf.setOptions({
      workers: [
        ...this.currentWorkerConfigs(),
        this.createWorkerConfig(agentId, bundlePath, config),
      ],
    });
  }

  private createWorkerConfig(agentId: string, bundlePath: string, config: AgentInitConfig) {
    return {
      name: `agent-${agentId}-${config.channel}`,
      modules: true,
      scriptPath: bundlePath,
      serviceBindings: {
        PUBSUB: this.createPubsubBinding(config),
        STORAGE: this.createStorageBinding(agentId, config),
        AI: this.createAiBinding(),
        HOST: this.createHostBinding(agentId, config),
      },
      bindings: {
        AGENT_ID: agentId,
        CHANNEL: config.channel,
        HANDLE: config.handle,
        CONFIG: JSON.stringify(config.config),
      },
    };
  }
}
```

### Service bindings: the capability surface

Each service binding is a function-valued binding that runs in Node.js and handles requests from the workerd agent. This is where the capability boundary lives.

#### PUBSUB binding

Proxies pubsub operations. The agent in workerd calls `env.PUBSUB.fetch()` with structured requests, and the Node.js handler translates them to pubsub client operations.

```typescript
// In Node.js (service binding handler)
createPubsubBinding(config: AgentInitConfig) {
  return async (request: Request) => {
    const { method, params } = await request.json();

    switch (method) {
      case "send":
        return Response.json(await client.send(params.content, params.options));
      case "update":
        return Response.json(await client.update(params.id, params.content, params.options));
      case "complete":
        return Response.json(await client.complete(params.id));
      case "discoverMethodDefs":
        return Response.json(client.discoverMethodDefs());
      case "callMethod":
        const handle = client.callMethod(params.providerId, params.methodName, params.args);
        return Response.json(await handle.result);
      // ... other EventBus methods
    }
  };
}
```

```typescript
// In workerd (agent-side adapter)
class WorkerdEventBus implements EventBus {
  constructor(private pubsub: Fetcher) {}

  async send(content: string, options?: SendOptions) {
    const res = await this.pubsub.fetch("http://host/rpc", {
      method: "POST",
      body: JSON.stringify({ method: "send", params: { content, options } }),
    });
    return res.json();
  }
  // ... other EventBus methods
}
```

#### STORAGE binding

Provides the `StorageApi` interface backed by SQLite on the host. Each agent gets its own scoped database.

```typescript
createStorageBinding(agentId: string, config: AgentInitConfig) {
  // Open a dedicated database for this agent instance
  const db = dbManager.open(`agent-${agentId}-${config.channel}.db`);

  return async (request: Request) => {
    const { method, params } = await request.json();
    switch (method) {
      case "exec":
        await db.exec(params.sql);
        return new Response("ok");
      case "run":
        return Response.json(db.run(params.sql, params.params));
      case "get":
        return Response.json(db.get(params.sql, params.params));
      case "query":
        return Response.json(db.query(params.sql, params.params));
    }
  };
}
```

#### AI binding

Proxies AI model access through the host's `AIHandler`.

```typescript
createAiBinding() {
  return async (request: Request) => {
    const { method, params } = await request.json();
    switch (method) {
      case "streamText":
        // Start a streaming AI call and return a ReadableStream
        const stream = aiHandler.streamText(params);
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      case "listRoles":
        return Response.json(aiHandler.listRoles());
    }
  };
}
```

#### HOST binding

Lifecycle management — the agent can signal readiness, request shutdown, report errors.

```typescript
createHostBinding(agentId: string, config: AgentInitConfig) {
  return async (request: Request) => {
    const { method, params } = await request.json();
    switch (method) {
      case "ready":
        this.emit("agent-ready", agentId);
        return new Response("ok");
      case "log":
        this.logForAgent(agentId, params.level, params.message);
        return new Response("ok");
      case "setState":
        this.stateStore.set(agentId, params.state);
        return new Response("ok");
    }
  };
}
```

### Event delivery: the hard problem

The service binding model (agent calls host via `fetch()`) works well for outgoing operations. But **incoming events** (pubsub messages arriving for the agent) need the reverse direction: host pushes to agent.

#### Option A: Polling

The agent periodically calls `env.PUBSUB.fetch("http://host/poll")` to check for new events. Simple but introduces latency and wasted cycles.

```typescript
// In workerd agent
async function eventLoop(env: Env) {
  while (true) {
    const res = await env.PUBSUB.fetch("http://host/poll", { method: "POST" });
    const events = await res.json();
    for (const event of events) {
      await agent.onEvent(event);
    }
    // Back-off if no events
    if (events.length === 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
}
```

This is workable but inelegant. Latency of 0-100ms on event delivery, tunable but always a tradeoff.

#### Option B: Long-polling

The agent calls `env.PUBSUB.fetch("http://host/events")` and the host holds the connection open until events arrive, then returns them. The agent immediately re-polls.

```typescript
// In Node.js (host side)
async (request: Request) => {
  // Wait for next event batch (with timeout)
  const events = await eventQueue.waitForEvents({ timeoutMs: 30000 });
  return Response.json(events);
};
```

Better latency (near-instant delivery), but requires managing long-lived HTTP connections in the miniflare loopback. This is a solved problem — the miniflare loopback server handles concurrent requests fine.

#### Option C: WebSocket from agent to host

The agent opens a WebSocket to the host via a service binding, and the host pushes events over it. This is the most natural fit.

```typescript
// In workerd agent
const ws = new WebSocket("ws://host/events");
ws.onmessage = (event) => {
  const parsed = JSON.parse(event.data);
  agent.onEvent(parsed);
};
```

However, WebSocket support in miniflare service bindings is uncertain. The workerd runtime supports WebSocket creation via `fetch()` upgrade, but function-valued service bindings may not support the upgrade protocol. This needs validation.

#### Option D: Durable Object with WebSocket hibernation

The agent itself is a Durable Object with inbound WebSocket support. The host connects to the DO via WebSocket and pushes events. The DO uses the Hibernation API so it's not consuming resources when idle.

This is architecturally clean but adds significant complexity — we'd be running a DO inside miniflare just for the WebSocket management.

#### Recommendation: Start with long-polling (Option B), migrate to WebSocket (Option C) if validated.

Long-polling is simple, works reliably with function-valued service bindings, and has near-zero latency in practice. If WebSocket support in service bindings works, it's a transparent upgrade (just change the transport, keep the same event delivery semantics).

### Build system changes

#### New build target: workerd

The V2 build system needs a third build strategy alongside `buildPanel()` (browser) and `buildAgent()` (node):

```typescript
// In builder.ts
async function buildWorkerdAgent(
  node: GraphNode,
  ev: string,
  graph: Map<string, GraphNode>,
  options: BuildOptions
): Promise<BuildArtifacts> {
  return esbuild.build({
    entryPoints: [entryPoint],
    platform: "neutral",        // Not node, not browser
    target: "esnext",
    format: "esm",
    bundle: true,
    splitting: false,
    outfile: "bundle.mjs",

    // workerd conditions for package.json exports resolution
    conditions: ["workerd", "worker", "import", "default"],

    // External: nothing should be external — everything must be bundled
    // except workerd builtins
    external: [],

    // Mark Node.js builtins that workerd supports
    // (with nodejs_compat flag, many are available)
    // But the agent shouldn't use them — it should use the bindings

    plugins: [
      workspaceResolvePlugin(sourceRoot, graph),
      // Shim or error on disallowed imports
      workerdGuardPlugin(),
    ],

    define: {
      "process.env.NODE_ENV": '"production"',
    },
  });
}
```

#### Manifest extension

Agents declare their target runtime in `package.json`:

```json
{
  "name": "@workspace-agents/my-agent",
  "natstack": {
    "type": "agent",
    "runtime": "workerd"
  }
}
```

The default `"runtime"` is `"node"` for backward compatibility. The build system reads this to choose the build strategy. Discovery (`agentDiscovery.ts`) passes it through so `agentHost.ts` knows which host to use.

#### The guard plugin

A critical esbuild plugin that prevents user agents from importing Node.js modules:

```typescript
function workerdGuardPlugin(): esbuild.Plugin {
  return {
    name: "workerd-guard",
    setup(build) {
      // Block direct Node.js imports that agents shouldn't use
      const blocked = [
        "child_process", "cluster", "dgram",
        "fs", "fs/promises",
        "http", "https", "http2",
        "net", "tls",
        "os", "process",
        "worker_threads",
      ];

      for (const mod of blocked) {
        build.onResolve({ filter: new RegExp(`^(node:)?${mod}$`) }, () => ({
          errors: [{
            text: `Import of "${mod}" is not allowed in workerd agents. ` +
                  `Use env.STORAGE for persistence, env.PUBSUB for messaging, ` +
                  `or env.AI for model access.`,
          }],
        }));
      }
    },
  };
}
```

This provides **build-time enforcement** of the sandbox boundary. Even if workerd would polyfill `node:fs`, we want user agents to not use it — they should go through the capability bindings.

### Agent runtime for workerd

#### The workerd-compatible runtime entry point

Today, `runAgent()` in `agent-runtime/src/runtime.ts` assumes IPC channels, RPC bridges, and direct pubsub WebSocket connections. For workerd, we need a new entry point:

```typescript
// workspace/packages/agent-runtime/src/workerd/runtime.ts

export async function runWorkerdAgent<S extends AgentState>(
  AgentClass: new () => Agent<S>,
  env: WorkerdEnv
): Promise<void> {
  const agent = new AgentClass();

  // Create workerd-specific adapters
  const storage = new WorkerdStorage(env.STORAGE);
  const eventBus = new WorkerdEventBus(env.PUBSUB);
  const ai = new WorkerdAiProvider(env.AI);
  const log = new WorkerdLogger(env.HOST);

  // Create runtime context (same interface as Electron)
  const ctx = createRuntimeContext({
    agentId: env.AGENT_ID,
    channel: env.CHANNEL,
    handle: env.HANDLE,
    config: JSON.parse(env.CONFIG),
    storage,
    eventBus,
    ai,
    log,
    mode: "workerd",
  });

  // Inject context (same as Electron runtime does)
  const agentInternal = agent as unknown as AgentRuntimeInjection<S>;
  agentInternal.ctx = ctx;

  // Load state, call onWake, enter event loop
  // ... same lifecycle as Electron runtime, but using workerd adapters
}
```

#### The workerd agent entry point pattern

User agents would look nearly identical to today:

```typescript
// workspace/agents/my-agent/index.ts
import { Agent, runWorkerdAgent } from "@workspace/agent-runtime";
import type { EventStreamItem } from "@workspace/agentic-messaging";

interface MyState {
  messageCount: number;
}

class MyAgent extends Agent<MyState> {
  state: MyState = { messageCount: 0 };

  async onWake() {
    this.log.info("Agent starting");
  }

  async onEvent(event: EventStreamItem) {
    if (event.type === "message" && event.kind !== "replay") {
      this.setState({ messageCount: this.state.messageCount + 1 });
      await this.client.send(`Message #${this.state.messageCount}`);
    }
  }

  async onSleep() {
    this.log.info("Agent shutting down");
  }
}

// Entry point: export a fetch handler for workerd
export default {
  async fetch(request: Request, env: WorkerdEnv) {
    // Dispatch based on request path
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      await runWorkerdAgent(MyAgent, env);
      return new Response("ok");
    }

    if (url.pathname === "/event") {
      const event = await request.json();
      // Route to running agent instance
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};
```

Wait — this doesn't work cleanly. workerd workers are request-driven, not long-running processes. The agent model assumes a long-running process with an event loop. We need to reconcile these models.

### The lifecycle problem: request-driven vs long-running

This is the core design tension.

**Current model**: Agents are long-running processes. `runAgent()` starts, connects to pubsub, enters `for await (const event of client.events())`, and runs until shutdown. State is in-memory between events.

**workerd model**: Workers handle individual requests. They start, process a request, and may be evicted. There's no persistent event loop between requests.

#### Option 1: Durable Object as the agent

Use a Durable Object to maintain long-lived state and potentially a WebSocket connection:

```typescript
export class AgentDO {
  private agent: Agent;
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    // Restore agent from persisted state
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/event") {
      const event = await request.json();
      await this.agent.onEvent(event);
      return new Response("ok");
    }

    if (url.pathname === "/init") {
      await this.agent.onWake();
      return new Response("ok");
    }
  }

  // WebSocket support for event streaming
  async webSocketMessage(ws: WebSocket, message: string) {
    const event = JSON.parse(message);
    await this.agent.onEvent(event);
  }
}
```

**Pros**: Natural fit for stateful, long-lived entities. DO storage for state persistence. WebSocket hibernation for efficient event delivery. Aligns with the existing `RuntimeMode = "durable-object"` abstraction.

**Cons**: Adds complexity. Miniflare's DO support requires specific configuration. DOs have different lifecycle semantics than processes (alarm-based eviction, no graceful shutdown signal).

#### Option 2: Push-driven worker with in-memory state

The host pushes events to the worker via `dispatchFetch()`. The worker maintains state in module-level variables (global scope persists between requests in the same isolate):

```typescript
// Module-level state persists between requests
let agent: Agent | null = null;
let initialized = false;

export default {
  async fetch(request: Request, env: Env) {
    if (!initialized) {
      agent = new MyAgent();
      // ... init, load state, onWake
      initialized = true;
    }

    const url = new URL(request.url);

    if (url.pathname === "/event") {
      const event = await request.json();
      await agent.onEvent(event);
      return new Response("ok");
    }

    if (url.pathname === "/shutdown") {
      await agent.onSleep();
      // ... flush state
      return new Response("ok");
    }
  },
};
```

**Pros**: Simpler. Module-level globals persist across requests in the same isolate. Host controls lifecycle explicitly via HTTP. No DO complexity.

**Cons**: No guarantee of isolate persistence (workerd can evict and recreate). State must be restored on every potential cold start. Less natural than the event loop model.

In practice, with miniflare running locally, isolate eviction is not an issue — the isolate persists for the lifetime of the miniflare instance. This makes Option 2 viable for local use.

#### Option 3: Hybrid — push-driven with DO for state only

Use a simple worker for event processing but back state persistence with a DO's SQLite:

```typescript
// Worker handles events
let agent: Agent | null = null;

export default {
  async fetch(request: Request, env: Env) {
    if (!agent) {
      agent = await initAgent(env);
    }

    const event = await request.json();
    await agent.onEvent(event);

    // State changes are saved via env.STORAGE binding
    // which goes to host-side SQLite
    return new Response("ok");
  },
};
```

This is essentially Option 2 with the storage binding going to host-side SQLite rather than DO storage. The simplest approach.

#### Recommendation: Option 2 (push-driven worker) for local miniflare

For the local miniflare use case, Option 2 is the right choice:

- Module-level state persists reliably (no eviction in local miniflare)
- Host drives lifecycle via HTTP (`/init`, `/event`, `/shutdown`)
- State persistence goes through the `STORAGE` service binding to host-side SQLite
- No DO complexity
- Clean mapping to the existing `Agent` base class lifecycle

The host's event delivery loop looks like:

```typescript
// In WorkerdHost (Node.js side)
async deliverEvent(agentId: string, event: EventStreamItem) {
  const workerUrl = this.getWorkerUrl(agentId);
  await fetch(`${workerUrl}/event`, {
    method: "POST",
    body: JSON.stringify(event),
  });
}
```

The pubsub client lives on the host side (Node.js), subscribes to the channel's events, and pushes each event to the workerd agent via HTTP.

### What agents can and cannot do

#### Capabilities granted (via bindings)

| Capability | Binding | Interface |
|-----------|---------|-----------|
| Send messages | `PUBSUB` | `EventBus.send()`, `.update()`, `.complete()` |
| Call tools | `PUBSUB` | `EventBus.callMethod()` |
| Discover tools | `PUBSUB` | `EventBus.discoverMethodDefs()` |
| Persist state | `STORAGE` | `StorageApi.exec()`, `.run()`, `.get()`, `.query()` |
| AI model access | `AI` | `AiProvider.streamText()`, `.listRoles()` |
| Logging | `HOST` | `AgentLogger.info()`, `.warn()`, `.error()` |
| Lifecycle | `HOST` | Ready signal, state save, settings |
| Roster | `PUBSUB` | `EventBus.roster`, `.onRoster()` |
| Settings | `PUBSUB` | `EventBus.getSettings()`, `.updateSettings()` |

#### Capabilities denied (by sandbox)

| Capability | Why blocked |
|-----------|------------|
| Filesystem access | No `fs` binding. Storage only via `STORAGE` |
| Process spawning | No `child_process`. Compute only within isolate |
| Arbitrary network | No `globalOutbound` unless explicitly configured |
| Native modules | workerd V8 isolate, no N-API |
| Host process access | No IPC, no shared memory |
| Other agents' state | Each agent gets its own scoped `STORAGE` |

#### Optional capabilities (configurable)

Some capabilities could be gated on agent manifest declarations:

```json
{
  "natstack": {
    "type": "agent",
    "runtime": "workerd",
    "capabilities": {
      "network": true,
      "ai": true,
      "storage": true
    }
  }
}
```

If `"network": false`, the agent doesn't get a `globalOutbound` service — all `fetch()` calls fail. If `"ai": false`, no `AI` binding is provided. This lets users install agents with clear capability declarations.

### What about agent-patterns?

The `@workspace/agent-patterns` library is the critical bridge. Today it provides:

- `discoverPubsubToolsForMode()` — discovers tools from pubsub
- `toClaudeMcpTools()` / `toCodexMcpTools()` / `toAiSdkTools()` — converts to SDK format
- `createCanUseToolGate()` — approval logic
- `createMessageQueue()` — serialized event processing
- `createSettingsManager()` — user preferences
- `createMissedContextManager()` — reconnection handling
- `createContextTracker()` — token usage tracking

Most of these are pure JavaScript with no Node.js dependencies. They work against the `EventBus` interface, not raw pubsub WebSockets. **They should work in workerd unchanged**, as long as the `EventBus` implementation (the `WorkerdEventBus` adapter) correctly implements the interface.

The one exception is `@workspace/ai` which uses `setRpc()` to wire up AI streaming through the RPC bridge. For workerd, this would need a workerd-compatible AI adapter that goes through the `AI` service binding instead.

### The pubsub-chat-responder as the template

`pubsub-chat-responder` is the ideal first agent to port to workerd. It:

- Uses `@workspace/ai` for model access (abstracted, not SDK-specific)
- Uses `@workspace/agent-patterns` for tool discovery, approval, queuing
- Has **no Node.js-specific imports** (no `child_process`, `fs`, etc.)
- Is a complete, production-quality agent with tool support, settings, interrupts

Porting it to workerd would validate the entire stack:

1. Build system produces a workerd-compatible bundle
2. `WorkerdEventBus` correctly implements `EventBus`
3. `WorkerdStorage` correctly implements `StorageApi`
4. `WorkerdAiProvider` correctly implements `AiProvider`
5. `agent-patterns` works unchanged in workerd
6. Event delivery via HTTP works reliably
7. Settings and state persistence round-trip correctly

### Detailed implementation plan

#### Phase 1: Infrastructure

1. **Add miniflare dependency** to the project.
2. **Create `WorkerdHost`** (`src/main/workerdHost.ts`):
   - Manages a single miniflare instance
   - Provides `spawn(agentId, bundlePath, config)` matching AgentHost's interface
   - Manages service binding functions (PUBSUB, STORAGE, AI, HOST)
   - Handles agent lifecycle (init, event delivery, shutdown)
3. **Create workerd adapter package** (`workspace/packages/agent-runtime/src/workerd/`):
   - `WorkerdEventBus` — implements `EventBus` via PUBSUB binding
   - `WorkerdStorage` — implements `StorageApi` via STORAGE binding
   - `WorkerdAiProvider` — implements `AiProvider` via AI binding
   - `WorkerdLogger` — implements `AgentLogger` via HOST binding
   - `runWorkerdAgent()` — entry point for workerd agents

#### Phase 2: Build system

4. **Add `buildWorkerdAgent()`** to `builder.ts`:
   - `platform: "neutral"`, `target: "esnext"`, `format: "esm"`
   - workerd-specific conditions in exports resolution
   - Guard plugin blocking disallowed Node.js imports
   - Wraps output in workerd-compatible fetch handler shell
5. **Extend manifest** with `runtime: "workerd" | "node"` field
6. **Update `agentDiscovery.ts`** to surface runtime target
7. **Update `agentHost.ts`** to route to `WorkerdHost` for workerd agents

#### Phase 3: Agent runtime

8. **Create workerd entry point wrapper**:
   - The build output wraps the agent's code in a fetch handler
   - Handles `/init`, `/event`, `/shutdown` routes
   - Lazy-initializes the agent on first request
9. **Implement the adapter classes** with full EventBus compliance
10. **Validate `agent-patterns` works** in workerd by running `pubsub-chat-responder` in the new runtime

#### Phase 4: Move builtins

11. **Move Claude Code responder** to `src/agents/claude-code-responder/`
12. **Move Codex responder** to `src/agents/codex-responder/`
13. **Add esbuild entry points** to `build.mjs`
14. **Register builtins** in `agentHost.ts`
15. **Remove originals** from `workspace/agents/`

#### Phase 5: Hardening

16. **Outbound network control** — configure `outboundService` to audit/block agent network requests
17. **Resource monitoring** — track agent CPU/memory via external means (cgroups if containerized)
18. **Error isolation** — agent crashes don't affect the miniflare instance or other agents
19. **Hot reload** — file watcher triggers rebuild + `mf.setOptions()` for live development

### Open questions

1. **Single vs multiple miniflare instances?**
   - Single instance (all agents in one workerd process): simpler, shared overhead, but one agent's crash could affect others.
   - Multiple instances (one per agent): stronger isolation, but more memory/process overhead.
   - Recommendation: Start with single instance, separate if stability issues arise.

2. **Event delivery guarantee semantics?**
   - At-most-once (current model): agent checkpoints events, replays from checkpoint on restart.
   - At-least-once: host retries delivery on failure.
   - The host-side pubsub client + checkpoint model works the same regardless. The workerd agent just needs to maintain its checkpoint in `STORAGE`.

3. **How to handle agent tool approval UI?**
   - The `createCanUseToolGate()` pattern works via pubsub messages (sends approval prompt to panel, waits for response). This goes through the `PUBSUB` binding — no special workerd adaptation needed.

4. **npm dependencies for user agents?**
   - Currently handled by `externalDeps.ts` which runs `npm install`. For workerd agents, dependencies must be bundled into the worker (no `node_modules` at runtime). The esbuild bundle step already handles this — all deps are bundled. External deps installation still needed for the build step, just not at runtime.

5. **Can we run builtin agents and workerd agents simultaneously?**
   - Yes. `AgentHost` routes to either `ProcessAdapter` (builtins) or `WorkerdHost` (workerd agents) based on the manifest's `runtime` field. They coexist on the same pubsub channels.

6. **WebSocket for event delivery?**
   - Miniflare function-valued service bindings use HTTP Request/Response. WebSocket upgrade may not be supported. Needs experimental validation. If it works, it's the ideal transport. If not, long-polling is fine.

7. **What about the AI streaming path?**
   - The `AiProvider.streamText()` returns a `ReadableStream` of events. The `AI` service binding handler starts a streaming AI call and returns the stream as the HTTP response body. The workerd adapter reads the stream. This should work — miniflare supports streaming responses.

---

## Summary

The two-tier architecture maps cleanly onto the existing abstractions:

| Layer | Builtin Agents | User Agents |
|-------|---------------|-------------|
| **Runtime** | Node.js (full access) | workerd (sandboxed) |
| **Spawn** | `ProcessAdapter.fork()` | `WorkerdHost.spawn()` |
| **EventBus** | WebSocket `AgenticClient` | HTTP `WorkerdEventBus` |
| **Storage** | RPC `ElectronStorage` | HTTP `WorkerdStorage` |
| **AI** | RPC `RpcAiProvider` | HTTP `WorkerdAiProvider` |
| **Build** | `build.mjs` (static) | V2 `buildWorkerdAgent()` |
| **Discovery** | Static registration | Filesystem scan |
| **Agent code** | `src/agents/` | `workspace/agents/` |
| **Base class** | `Agent<TState>` | `Agent<TState>` (same) |

The `RuntimeContext` abstraction (`StorageApi`, `EventBus`, `AiProvider`) was designed for exactly this scenario. The `pubsub-chat-responder` agent already works against these abstractions without Node.js dependencies, making it the ideal validation target.

The biggest implementation effort is the `WorkerdHost` and the service binding handlers. The agent-side adapters are thin wrappers. The build system changes are moderate. The builtin agent migration is straightforward.

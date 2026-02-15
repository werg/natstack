# Design Space: Two-Tier Agent Architecture

## Overview

This document explores the design for restructuring NatStack's agent system into two tiers:

1. **Builtin agents** — Claude Code and Codex responders move out of `workspace/` into the core app, running as privileged Node.js processes with full system access. These keep the existing long-running process model.

2. **User-authored agents** — A completely new request-based runtime using workerd (via miniflare), designed ground-up for the workerd execution model rather than porting the existing `Agent<TState>` / `onWake`/`onEvent`/`onSleep` abstraction.

---

## Part 1: Moving Claude/Codex to Builtin

### What "builtin" means

Today, Claude Code and Codex responders live in `workspace/agents/` alongside user-authored agents like `test-echo` and `pubsub-chat-responder`. They're discovered by `agentDiscovery.ts` scanning that directory, built by the V2 build system with esbuild targeting `node20`, and spawned as `utilityProcess`/`child_process` forks by `agentHost.ts`.

Making them "builtin" means:

1. **Source moves from `workspace/agents/` to `src/`** — they become part of the core application, not workspace-level code. They're compiled as part of the main build (`build.mjs`), not by the V2 build system.

2. **No longer discovered dynamically** — The host knows about them statically. They're registered at startup, not discovered.

3. **Spawned differently** — They can be spawned directly by the host with richer initialization, without the generic `AgentInitConfig` protocol.

4. **Full Node.js access is explicit and expected** — `child_process`, `fs`, `http`, native modules. This is not a sandbox escape — it's the intended runtime.

### Architectural changes

#### Build system

Currently: `workspace/agents/claude-code-responder/` → V2 build system → `{userData}/builds/{key}/bundle.mjs` → spawned by agentHost.

Proposed: `src/agents/claude-code-responder/` → `build.mjs` esbuild → `dist/agents/claude-code-responder.mjs` → spawned by agentHost directly.

```
build.mjs targets (new):
  dist/agents/claude-code.mjs  ← builtin Claude agent
  dist/agents/codex.mjs        ← builtin Codex agent
```

#### Agent host

```typescript
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
```

#### What stays the same

Builtin agents still extend `Agent<TState>`, connect to pubsub, use the RPC bridge for database and AI. Same `ProcessAdapter` spawning. The only change is where the bundle comes from and how it's discovered.

#### Migration path

1. Copy agent source from `workspace/agents/{claude-code,codex}-responder/` to `src/agents/`.
2. Add esbuild entry points to `build.mjs`.
3. Register builtins in `agentHost.ts` with static manifests.
4. Update `agentDiscovery.ts` to skip builtin agent IDs.
5. Remove originals from `workspace/agents/`.
6. Move SDK dependencies to root `package.json`.

---

## Part 2: Request-Based User Agent Runtime

### Why not port the existing model

The current `Agent<TState>` model is a **long-running process abstraction**:

- `onWake()` → startup
- `for await (const event of client.events())` → persistent event loop
- `onEvent()` → handler called within a persistent context
- `onSleep()` → shutdown
- In-memory state between events
- Background monitoring loops (interrupt handler, heartbeats)
- Message queue with pause/resume/drain

This model fights workerd's grain. workerd workers are request-driven: receive a request, do work, return a response. Between requests, there's no persistent event loop, no background monitoring, no guaranteed in-memory state.

More fundamentally, the existing model makes the **agent the orchestrator** — it owns the pubsub connection, the message queue, the AI calls, the tool execution, the state, the settings, everything. The host just spawns it and provides an RPC bridge.

The new model **inverts this**: the host is the orchestrator. The agent is a pure computation unit.

### The inversion

```
CURRENT MODEL:
  Host spawns agent → agent connects to pubsub → agent runs event loop
  Agent owns: pubsub client, queue, settings, state, AI calls, tool execution
  Host provides: RPC bridge, database, AI handler

NEW MODEL:
  Host owns pubsub → host receives event → host dispatches to agent as request
  Host owns: pubsub client, queue, settings persistence, state persistence,
             conversation history, tool discovery, lifecycle
  Agent owns: what to do with a message (pure computation)
```

### What the host manages

The host-side **AgentManager** (running in Node.js) takes over all infrastructure:

| Concern | Current owner | New owner |
|---------|--------------|-----------|
| Pubsub connection | Agent (WebSocket client) | Host |
| Message queue | Agent (`createMessageQueue`) | Host |
| Settings load/save | Agent (`createSettingsManager`) | Host |
| State persistence | Agent runtime (`createStateStore`) | Host |
| Conversation history | Agent (in-memory or replay) | Host |
| Tool discovery | Agent (`discoverPubsubToolsForMode`) | Host |
| Checkpoint tracking | Agent runtime | Host |
| Interrupt/abort | Agent (`createInterruptController`) | Host |
| Typing/thinking indicators | Agent (`createTrackerManager`) | Host (partially) |

### What the agent does

The agent receives a **fully-formed request** and returns a **stream of actions**:

```
REQUEST (host → agent):
  {
    message: { content, attachments, sender, id },
    conversation: Message[],
    settings: { model, temperature, ... },
    tools: ToolDefinition[],
    state: AgentState,
  }

RESPONSE (agent → host, streaming):
  A stream of action events the host executes against pubsub
```

### The agent API

#### Minimal agent

```typescript
import { defineAgent } from "@natstack/agent";

export default defineAgent({
  async onMessage(message, ctx) {
    const text = await ctx.ai.generate({
      model: ctx.settings.model ?? "fast",
      prompt: message.content,
    });
    ctx.send(text);
  },
});
```

#### Agent with streaming

```typescript
import { defineAgent } from "@natstack/agent";

export default defineAgent({
  async onMessage(message, ctx) {
    const reply = ctx.reply();

    for await (const chunk of ctx.ai.stream({
      model: ctx.settings.model ?? "smart",
      messages: [
        ...ctx.conversation,
        { role: "user", content: message.content },
      ],
    })) {
      if (chunk.type === "text") {
        reply.write(chunk.text);
      }
    }

    reply.end();
  },
});
```

#### Agent with tools

```typescript
import { defineAgent } from "@natstack/agent";

export default defineAgent({
  async onMessage(message, ctx) {
    const reply = ctx.reply();
    let step = 0;
    const maxSteps = ctx.settings.maxSteps ?? 5;
    const messages = [...ctx.conversation, { role: "user", content: message.content }];

    while (step < maxSteps) {
      const stream = ctx.ai.stream({
        model: ctx.settings.model ?? "smart",
        messages,
        tools: ctx.tools,
      });

      const toolCalls = [];

      for await (const event of stream) {
        switch (event.type) {
          case "text":
            reply.write(event.text);
            break;
          case "thinking":
            reply.thinking(event.text);
            break;
          case "tool-call":
            reply.action(event.tool, event.args);
            toolCalls.push(event);
            break;
          case "tool-result":
            reply.actionComplete();
            break;
        }
      }

      if (toolCalls.length === 0) break;

      // Tool calls and results are already in messages (managed by ctx.ai)
      step++;
    }

    reply.end();
  },
});
```

#### Agent with state

```typescript
import { defineAgent } from "@natstack/agent";

export default defineAgent({
  async onMessage(message, ctx) {
    const count = ctx.state.messageCount ?? 0;
    ctx.setState({ messageCount: count + 1 });
    ctx.send(`Message #${count + 1}: ${message.content}`);
  },
});
```

#### Agent that provides tools to the channel

```typescript
import { defineAgent } from "@natstack/agent";

export default defineAgent({
  // Tools this agent provides (registered by host as pubsub methods)
  tools: {
    search_knowledge: {
      description: "Search the agent's knowledge base",
      parameters: {
        query: { type: "string", description: "Search query" },
      },
      execute: async (args, ctx) => {
        // Agent-specific logic
        const results = await searchIndex(args.query, ctx.state);
        return { results };
      },
    },
  },

  async onMessage(message, ctx) {
    // Normal message handling...
  },
});
```

### The `ctx` object

The context passed to the agent on each request:

```typescript
interface AgentContext {
  // === The incoming message ===
  message: {
    id: string;
    content: string;
    attachments: Attachment[];
    sender: { id: string; name: string; type: string };
  };

  // === Conversation history ===
  // Pre-assembled by the host from pubsub replay
  conversation: Message[];

  // === Settings (loaded by host from pubsub session) ===
  settings: Record<string, unknown>;

  // === Available tools (discovered by host from channel) ===
  tools: ToolDefinition[];

  // === Agent state (loaded by host from storage) ===
  state: Record<string, unknown>;

  // === AI access (via service binding) ===
  ai: {
    stream(options: StreamOptions): AsyncIterable<StreamEvent>;
    generate(options: GenerateOptions): Promise<string>;
  };

  // === Reply helpers (write to response stream) ===
  reply(): ReplyStream;
  send(content: string): void;

  // === State mutation ===
  setState(partial: Record<string, unknown>): void;

  // === Abort signal (fires when user interrupts) ===
  signal: AbortSignal;

  // === Logging ===
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

interface ReplyStream {
  write(text: string): void;
  thinking(text: string): void;
  action(toolName: string, args: unknown): void;
  actionComplete(): void;
  end(): void;
}
```

### The `defineAgent()` contract

```typescript
interface AgentDefinition {
  // Handle an incoming user message
  onMessage(message: IncomingMessage, ctx: AgentContext): Promise<void>;

  // Optional: tools this agent provides to the channel
  tools?: Record<string, ToolProvider>;

  // Optional: settings schema (host renders the UI)
  settings?: SettingsSchema;

  // Optional: lifecycle hooks
  onInit?(ctx: InitContext): Promise<void>;
  onShutdown?(ctx: ShutdownContext): Promise<void>;
}

function defineAgent(definition: AgentDefinition): WorkerdExport;
```

### How `defineAgent()` maps to a workerd fetch handler

`defineAgent()` returns a workerd-compatible module export. The build system wraps this into a fetch handler:

```typescript
// What defineAgent() produces internally
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/message": {
        const payload = await request.json();
        const ctx = createContext(payload, env, request.signal);

        await definition.onMessage(payload.message, ctx);

        // Return accumulated state changes
        return Response.json({
          stateChanges: ctx._stateChanges,
        });
      }

      case "/tool": {
        const { tool, args } = await request.json();
        const handler = definition.tools?.[tool];
        if (!handler) return new Response("not found", { status: 404 });
        const result = await handler.execute(args, createToolContext(env));
        return Response.json(result);
      }

      case "/init": {
        if (definition.onInit) {
          await definition.onInit(createInitContext(env));
        }
        return new Response("ok");
      }

      case "/shutdown": {
        if (definition.onShutdown) {
          await definition.onShutdown(createShutdownContext(env));
        }
        return new Response("ok");
      }

      default:
        return new Response("not found", { status: 404 });
    }
  },
};
```

### Service bindings and the capability surface

#### The AI binding (streaming)

The most complex binding. The agent calls `ctx.ai.stream()`, which internally does:

```typescript
// Agent-side (in workerd)
async function* streamAi(env: Env, options: StreamOptions): AsyncGenerator<StreamEvent> {
  const response = await env.AI.fetch("http://host/stream", {
    method: "POST",
    body: JSON.stringify(options),
  });

  // Read NDJSON stream from response body
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        yield JSON.parse(line) as StreamEvent;
      }
    }
  }
}
```

```typescript
// Host-side (Node.js service binding)
createAiBinding() {
  return async (request: Request) => {
    const options = await request.json();

    // Start streaming AI call
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        // Use AIHandler to stream
        for await (const event of aiHandler.streamEvents(options)) {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };
}
```

The AI streaming response flows back through the service binding as an NDJSON stream. miniflare supports streaming responses through the loopback — the workerd agent reads chunks as they arrive.

#### The CHANNEL binding (pubsub operations)

Replaces the direct pubsub client. Each operation is a service binding call.

```typescript
// Agent-side (in workerd)
class ChannelClient {
  constructor(private binding: Fetcher) {}

  async send(content: string, options?: { replyTo?: string }) {
    const res = await this.binding.fetch("http://host/send", {
      method: "POST",
      body: JSON.stringify({ content, ...options }),
    });
    return res.json() as Promise<{ messageId: string }>;
  }

  async update(id: string, text: string) {
    await this.binding.fetch("http://host/update", {
      method: "POST",
      body: JSON.stringify({ id, text }),
    });
  }

  async complete(id: string) {
    await this.binding.fetch("http://host/complete", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const res = await this.binding.fetch("http://host/call-tool", {
      method: "POST",
      body: JSON.stringify({ name, args }),
    });
    return res.json();
  }
}
```

```typescript
// Host-side (Node.js)
createChannelBinding(client: AgenticClient) {
  return async (request: Request) => {
    const url = new URL(request.url);
    const body = await request.json();

    switch (url.pathname) {
      case "/send":
        return Response.json(await client.send(body.content, body));
      case "/update":
        await client.update(body.id, body.text);
        return new Response("ok");
      case "/complete":
        await client.complete(body.id);
        return new Response("ok");
      case "/call-tool": {
        // Look up the tool provider, call the method, wait for result
        const handle = client.callMethod(
          body.providerId ?? findToolProvider(body.name),
          body.name,
          body.args,
        );
        const result = await handle.result;
        return Response.json(result.content);
      }
    }
  };
}
```

In miniflare, service binding calls go through a loopback server **in the same Node.js process**. This is IPC, not network I/O. The overhead per call is low hundreds of microseconds — perfectly acceptable for pubsub updates arriving at the rate of AI token generation (~20-50ms between deltas).

#### The TOOLS binding (tool approval + execution)

Tool execution may require user approval. This is handled by the host:

```typescript
// Host-side
createToolsBinding(client: AgenticClient, panel: Participant) {
  return async (request: Request) => {
    const { name, args } = await request.json();

    // Check approval level
    const gate = getApprovalGate(agentId);
    const { allow } = await gate.canUseTool(name, args);

    if (!allow) {
      // Show approval prompt to user via pubsub
      const result = await showPermissionPrompt(client, panel.id, name, args);
      if (!result.allow) {
        return Response.json({ error: "denied" }, { status: 403 });
      }
    }

    // Execute tool via pubsub method call
    const handle = client.callMethod(findToolProvider(name), name, args);
    const result = await handle.result;
    return Response.json(result.content);
  };
}
```

The agent doesn't know about approval flows. It calls `ctx.tools.execute("search", { query: "..." })`. If approval is needed, the host handles the UI interaction transparently. The service binding call blocks until the tool returns (or is denied).

#### The HOST binding (lifecycle, state, logging)

```typescript
createHostBinding(agentId: string) {
  return async (request: Request) => {
    const url = new URL(request.url);
    const body = await request.json();

    switch (url.pathname) {
      case "/log":
        logForAgent(agentId, body.level, body.message);
        return new Response("ok");
      case "/state":
        await persistState(agentId, body.state);
        return new Response("ok");
    }
  };
}
```

### How the reply stream works

`ctx.reply()` returns a `ReplyStream` that wraps pubsub operations behind a clean interface. Each method translates to a CHANNEL service binding call:

```typescript
// Agent-side implementation (in workerd)
function createReplyStream(channel: ChannelClient, replyTo: string): ReplyStream {
  let messageId: string | null = null;

  return {
    async write(text: string) {
      if (!messageId) {
        const result = await channel.send("", { replyTo });
        messageId = result.messageId;
      }
      await channel.update(messageId, text);
    },

    async thinking(text: string) {
      // Send as ephemeral typing indicator with thinking content type
      await channel.send(text, {
        replyTo,
        contentType: "thinking",
        persist: false,
      });
    },

    async action(toolName: string, args: unknown) {
      await channel.send(JSON.stringify({ tool: toolName, args }), {
        replyTo,
        contentType: "action",
        persist: false,
      });
    },

    async actionComplete() {
      await channel.send("", {
        replyTo,
        contentType: "action-complete",
        persist: false,
      });
    },

    async end() {
      if (messageId) {
        await channel.complete(messageId);
      }
    },
  };
}
```

### How tools consumed by the agent work

The host discovers tools before dispatching a request, and passes them as part of the context. The `ctx.ai.stream()` integration handles tool execution inline:

```typescript
// Agent-side AI stream with tool support (in workerd)
async function* streamWithTools(
  ai: Fetcher,
  tools: Fetcher,
  options: StreamOptions & { tools: ToolDefinition[] }
): AsyncGenerator<StreamEvent> {
  const messages = [...options.messages];

  for (let step = 0; step < (options.maxSteps ?? 1); step++) {
    // Call AI with current messages
    const response = await ai.fetch("http://host/stream", {
      method: "POST",
      body: JSON.stringify({ ...options, messages }),
    });

    const toolCalls: ToolCall[] = [];

    // Yield events from this step
    for await (const event of parseNdjson(response.body)) {
      yield event;

      if (event.type === "tool-call") {
        toolCalls.push(event);
      }
    }

    if (toolCalls.length === 0) break;

    // Execute tool calls via TOOLS binding (host handles approval)
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const res = await tools.fetch("http://host/execute", {
          method: "POST",
          body: JSON.stringify({ name: tc.tool, args: tc.args }),
        });

        if (!res.ok) {
          const error = await res.json();
          yield { type: "tool-result", id: tc.id, result: error, isError: true };
          return { id: tc.id, result: error, isError: true };
        }

        const result = await res.json();
        yield { type: "tool-result", id: tc.id, result };
        return { id: tc.id, result };
      })
    );

    // Add to conversation for next step
    messages.push({
      role: "assistant",
      content: toolCalls.map(tc => ({ type: "tool-call", ...tc })),
    });
    messages.push({
      role: "tool",
      content: results.map(r => ({ type: "tool-result", ...r })),
    });
  }
}
```

### Interruption model

The host owns interruption. When the user clicks "pause" or "stop":

1. Host receives the pause event via pubsub
2. Host aborts the in-flight request to the agent by aborting the `dispatchFetch()` call
3. The `request.signal` in the agent's fetch handler fires
4. The agent's `ctx.signal` (which is `request.signal`) aborts any in-flight `env.AI.fetch()` calls
5. The AI stream terminates, the agent's handler returns early
6. Host cleans up (completes any pending messages, persists state)

```typescript
// Host-side dispatch with interrupt support
class AgentManager {
  private abortControllers = new Map<string, AbortController>();

  async dispatchMessage(agentId: string, message: IncomingMessage) {
    const controller = new AbortController();
    this.abortControllers.set(message.id, controller);

    try {
      const response = await mf.dispatchFetch(`http://agent/message`, {
        method: "POST",
        body: JSON.stringify({
          message,
          conversation: this.getConversation(agentId),
          settings: await this.getSettings(agentId),
          tools: this.getDiscoveredTools(agentId),
          state: await this.getState(agentId),
        }),
        signal: controller.signal,
      });

      // Process response (state changes, etc.)
      const result = await response.json();
      if (result.stateChanges) {
        await this.persistState(agentId, result.stateChanges);
      }
    } finally {
      this.abortControllers.delete(message.id);
    }
  }

  interrupt(messageId: string) {
    this.abortControllers.get(messageId)?.abort();
  }
}
```

The agent doesn't need `createInterruptController()` or background monitoring loops. It just checks `ctx.signal.aborted` or passes `ctx.signal` to AI calls.

### Settings: declarative, not procedural

Currently, agents implement settings as a pubsub method (`settings`) with custom form-building logic in the handler. The new model makes settings declarative in the manifest:

```json
{
  "natstack": {
    "type": "agent",
    "runtime": "workerd",
    "displayName": "My Smart Agent",
    "settings": {
      "model": {
        "type": "select",
        "label": "Model",
        "options": "$roles",
        "default": "fast"
      },
      "temperature": {
        "type": "number",
        "label": "Temperature",
        "min": 0,
        "max": 2,
        "step": 0.1,
        "default": 0.7
      },
      "maxSteps": {
        "type": "number",
        "label": "Max Tool Steps",
        "min": 1,
        "max": 20,
        "default": 5
      }
    }
  }
}
```

The host renders the settings UI using this schema. `$roles` is a special token that expands to the available AI model roles at runtime. Settings are loaded by the host and passed as `ctx.settings` in every request. The agent never touches pubsub session storage directly.

### Message queue: host-owned

The host serializes requests to each agent. If a second message arrives while the first is being processed, the host queues it and shows a queue position indicator (same typing tracker pattern, but driven by the host).

```typescript
// Host-side queue management
class AgentQueue {
  private queue: QueuedMessage[] = [];
  private processing: boolean = false;

  async enqueue(message: IncomingMessage) {
    this.queue.push({ message, receivedAt: Date.now() });
    this.updateQueueIndicators();

    if (!this.processing) {
      this.processNext();
    }
  }

  private async processNext() {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    const item = this.queue.shift()!;
    this.updateQueueIndicators();

    try {
      await this.manager.dispatchMessage(this.agentId, item.message);
    } catch (err) {
      // Handle error, send error message to channel
    }

    // Check for interleave: if queue has items and agent supports it,
    // batch them into the next request
    this.processNext();
  }

  private updateQueueIndicators() {
    // Update typing indicators for queued messages
    for (let i = 0; i < this.queue.length; i++) {
      this.showQueuePosition(this.queue[i].message.id, i);
    }
  }
}
```

The agent never sees the queue. It processes one message at a time. If interleaving is desired (merging pending messages between AI steps), the host handles it by batching messages in the request.

### Build system

#### New build target

```typescript
async function buildWorkerdAgent(node: GraphNode, ev: string, ...): Promise<BuildArtifacts> {
  return esbuild.build({
    entryPoints: [entryPoint],
    platform: "neutral",
    target: "esnext",
    format: "esm",
    bundle: true,
    splitting: false,
    outfile: "bundle.mjs",
    conditions: ["workerd", "worker", "import", "default"],
    external: [],
    plugins: [
      workspaceResolvePlugin(sourceRoot, graph),
      workerdGuardPlugin(), // Errors on child_process, fs, http, etc.
    ],
  });
}
```

#### Guard plugin

Build-time enforcement of the sandbox boundary:

```typescript
function workerdGuardPlugin(): esbuild.Plugin {
  return {
    name: "workerd-guard",
    setup(build) {
      const blocked = [
        "child_process", "cluster", "dgram", "dns",
        "fs", "fs/promises",
        "http", "https", "http2",
        "net", "tls",
        "os", "worker_threads",
      ];

      for (const mod of blocked) {
        build.onResolve({ filter: new RegExp(`^(node:)?${mod}$`) }, () => ({
          errors: [{
            text: `Import of "${mod}" is not allowed in workerd agents. ` +
                  `Use ctx.ai for model access, ctx.reply() for messaging, ` +
                  `and ctx.state for persistence.`,
          }],
        }));
      }
    },
  };
}
```

#### Manifest extension

```json
{
  "natstack": {
    "type": "agent",
    "runtime": "workerd",
    "capabilities": ["ai", "storage"]
  }
}
```

### The `@natstack/agent` package

A new, minimal package that user agents import. It provides `defineAgent()` and the type definitions. This package has **no Node.js dependencies** — it's pure TypeScript types and a thin wrapper.

```
workspace/packages/natstack-agent/
├── package.json
├── src/
│   ├── index.ts          # defineAgent(), types
│   ├── context.ts        # AgentContext, ReplyStream
│   ├── ai.ts             # AI stream wrapper
│   └── channel.ts        # Channel client wrapper
```

The package exports:
- `defineAgent(definition)` — creates the workerd fetch handler
- Type definitions for `AgentContext`, `ReplyStream`, `StreamEvent`, etc.
- Helper utilities for common patterns (conversation formatting, etc.)

This replaces `@workspace/agent-runtime` for user agents. Builtin agents continue using `@workspace/agent-runtime`.

### What happens to `@workspace/agent-patterns`

Most patterns are absorbed by the host or become unnecessary:

| Pattern | Fate |
|---------|------|
| `createMessageQueue` | **Absorbed by host** — `AgentQueue` |
| `createSettingsManager` | **Absorbed by host** — declarative settings in manifest |
| `createInterruptController` | **Absorbed by host** — `AbortController` on dispatch |
| `createTrackerManager` | **Split** — host handles indicators, agent has `reply.thinking()` etc. |
| `createContextTracker` | **Absorbed by host** — tracks usage from AI binding responses |
| `createMissedContextManager` | **Absorbed by host** — assembles conversation in request |
| `discoverPubsubToolsForMode` | **Absorbed by host** — discovers before dispatch |
| `toAiSdkTools` / adapters | **Unnecessary** — host converts tools to a simple format |
| `createCanUseToolGate` | **Absorbed by host** — gate lives in TOOLS binding |
| `createResponseManager` | **Replaced by** `ctx.reply()` |
| `createStandardTools` | **Absorbed by host** — `set_title` as a default tool |
| `findPanelParticipant` | **Absorbed by host** — host knows the panel |

The `@workspace/agent-patterns` package stays for builtin agents. User agents don't need it.

### The WorkerdHost

```typescript
import { Miniflare } from "miniflare";

class WorkerdHost {
  private mf: Miniflare;
  private agents = new Map<string, AgentInstance>();

  async start() {
    this.mf = new Miniflare({
      compatibilityDate: "2025-09-15",
      compatibilityFlags: ["nodejs_compat"],
      workers: [],
    });
    await this.mf.ready;
  }

  async spawnAgent(agentId: string, bundlePath: string, config: SpawnConfig) {
    const instance = new AgentInstance(agentId, config);

    // Connect to pubsub on behalf of the agent
    const client = await connect({
      serverUrl: config.pubsubUrl,
      token: config.pubsubToken,
      channel: config.channel,
      handle: config.handle,
      name: config.manifest.displayName,
      type: "agent",
    });

    instance.client = client;
    instance.queue = new AgentQueue(instance);

    // Subscribe to events and route to queue
    for await (const event of client.events({ targetedOnly: true })) {
      if (event.type === "message" && event.kind !== "replay") {
        instance.queue.enqueue(event);
      }
    }

    // Rebuild miniflare with new worker
    await this.mf.setOptions({
      workers: [
        ...this.currentWorkerConfigs(),
        {
          name: `agent-${agentId}-${config.channel}`,
          modules: true,
          scriptPath: bundlePath,
          serviceBindings: {
            AI: this.createAiBinding(instance),
            CHANNEL: this.createChannelBinding(instance),
            TOOLS: this.createToolsBinding(instance),
            HOST: this.createHostBinding(instance),
          },
          bindings: {
            AGENT_ID: agentId,
            SETTINGS: JSON.stringify(await instance.loadSettings()),
          },
        },
      ],
    });

    this.agents.set(agentId, instance);
  }

  // Dispatch a message to the agent (called by AgentQueue)
  async dispatchMessage(instance: AgentInstance, message: IncomingMessage) {
    const response = await this.mf.dispatchFetch(
      `http://agent-${instance.agentId}-${instance.channel}/message`,
      {
        method: "POST",
        body: JSON.stringify({
          message: {
            id: message.id,
            content: message.content,
            attachments: message.attachments,
            sender: instance.client.roster[message.senderId],
          },
          conversation: instance.getConversationHistory(),
          settings: instance.settings,
          tools: instance.discoveredTools,
          state: instance.state,
        }),
      }
    );

    const result = await response.json();
    if (result.stateChanges) {
      instance.applyStateChanges(result.stateChanges);
    }
  }
}
```

### Comparison: current vs. new agent code

#### Current pubsub-chat-responder (883 lines)

The current agent handles:
- Pubsub connection options and event filtering
- Settings manager initialization and loading
- Interrupt controller and queue wiring
- Message queue with heartbeats and queue position tracking
- Missed context manager for reconnection
- Context tracker for token usage
- Tool discovery and conversion to AI SDK format
- Approval gate with permission prompts
- Agentic loop with multi-step tool execution
- Tracker management (typing, thinking, action)
- Conversation history assembly
- Image attachment processing
- Error handling and cleanup
- Message interleaving between steps
- Shutdown and drain logic

#### Equivalent workerd agent (~80 lines)

```typescript
import { defineAgent } from "@natstack/agent";

export default defineAgent({
  settings: {
    model: { type: "select", options: "$roles", default: "fast" },
    temperature: { type: "number", min: 0, max: 2, default: 0.7 },
    maxSteps: { type: "number", min: 1, max: 20, default: 5 },
    maxOutputTokens: { type: "number", min: 256, max: 8192, default: 1024 },
    thinkingBudget: { type: "number", min: 0, max: 32000, default: 0 },
  },

  async onMessage(message, ctx) {
    const reply = ctx.reply();
    const messages = [...ctx.conversation, { role: "user", content: message.content }];
    const maxSteps = ctx.settings.maxSteps ?? 5;

    for (let step = 0; step < maxSteps; step++) {
      if (ctx.signal.aborted) break;

      const stream = ctx.ai.stream({
        model: ctx.settings.model ?? "fast",
        messages,
        tools: ctx.tools.length > 0 ? ctx.tools : undefined,
        maxOutputTokens: ctx.settings.maxOutputTokens,
        temperature: ctx.settings.temperature,
        thinking: ctx.settings.thinkingBudget > 0
          ? { budgetTokens: ctx.settings.thinkingBudget }
          : undefined,
        signal: ctx.signal,
      });

      let hasToolCalls = false;

      for await (const event of stream) {
        switch (event.type) {
          case "text":
            reply.write(event.text);
            break;
          case "thinking":
            reply.thinking(event.text);
            break;
          case "tool-call":
            reply.action(event.tool, event.args);
            hasToolCalls = true;
            break;
          case "tool-result":
            reply.actionComplete();
            break;
        }
      }

      if (!hasToolCalls) break;
      // ctx.ai.stream handles adding tool calls/results to messages
    }

    reply.end();
  },
});
```

883 lines → ~80 lines. The reduction comes from the host absorbing infrastructure.

### Capabilities matrix

| Capability | Binding | Blocked | Notes |
|-----------|---------|---------|-------|
| AI model access | `AI` | | Streaming via NDJSON |
| Send/update messages | `CHANNEL` | | Pubsub operations |
| Tool execution | `TOOLS` | | Host handles approval |
| State persistence | `HOST` | | Read/write via service binding |
| Logging | `HOST` | | Forwarded to host logger |
| Filesystem | | `fs`, `child_process` | Build-time + runtime blocked |
| Network | | `fetch` (configurable) | `outboundService` can block |
| Process spawning | | `child_process` | V8 isolate, impossible |
| Native modules | | N-API | V8 isolate, impossible |

### Runtime architecture (final)

```
┌─────────────────────────────────────────────────────────────────────┐
│  NatStack Main Process (Node.js)                                    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  AgentHost                                                   │   │
│  │                                                              │   │
│  │  Builtin Agents (Node.js)    User Agents (workerd)           │   │
│  │  ┌─────────────────────┐     ┌──────────────────────────┐   │   │
│  │  │ Claude Code          │     │ WorkerdHost               │   │   │
│  │  │ (child_process.fork) │     │                           │   │   │
│  │  │ Full Node.js access  │     │ ┌──────────────────────┐ │   │   │
│  │  │ Own pubsub client    │     │ │  Miniflare            │ │   │   │
│  │  │ Own queue/state      │     │ │  ┌────────┐ ┌──────┐ │ │   │   │
│  │  └─────────────────────┘     │ │  │Agent A │ │Agt B │ │ │   │   │
│  │  ┌─────────────────────┐     │ │  │(isolate)│ │(iso.)│ │ │   │   │
│  │  │ Codex                │     │ │  └────────┘ └──────┘ │ │   │   │
│  │  │ (child_process.fork) │     │ └──────────────────────┘ │   │   │
│  │  │ Full Node.js access  │     │                           │   │   │
│  │  │ Own pubsub client    │     │ Per-agent on host side:   │   │   │
│  │  │ Own queue/state      │     │  • Pubsub client          │   │   │
│  │  └─────────────────────┘     │  • Message queue           │   │   │
│  │                               │  • Settings manager        │   │   │
│  │                               │  • State store             │   │   │
│  │                               │  • Tool discovery          │   │   │
│  │                               │  • Approval gate           │   │   │
│  │                               │  • Context tracker         │   │   │
│  │                               └──────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌────────────┐  ┌──────────────────┐  ┌──────────────────────┐   │
│  │ PubSub     │  │ Build System V2  │  │ Database Manager     │   │
│  │ Server     │  │                  │  │ (better-sqlite3)     │   │
│  └────────────┘  └──────────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Open questions

1. **Conversation history assembly** — How much history does the host pass? All of it? A window? Does the agent control this via settings? Does the host truncate to fit context windows?

2. **Agent-to-agent communication** — If two user agents are on the same channel, can one call the other's tools? The host would need to route tool calls between agents. Since the host owns both pubsub clients, this is possible but adds complexity.

3. **Long-running tool calls** — Some tools take a long time (e.g., running tests). The `TOOLS.fetch()` call blocks until the tool returns. workerd has request timeouts. May need configurable timeouts or a heartbeat mechanism.

4. **setOptions() restart cost** — `mf.setOptions()` restarts the entire workerd process when adding/removing agents. For hot reload of a single agent, this means all agents restart. May need per-agent miniflare instances, or live with the restart cost during development.

5. **State size** — How much state can an agent accumulate? The host loads it fully on each request. Large state could be expensive. May need a split: small "hot" state passed in request, larger state accessible via `HOST` binding on demand.

6. **Image/attachment handling** — Currently, agents access attachments via pubsub. In the request model, the host would need to serialize attachment data into the request (potentially large). May need a separate attachment binding for lazy loading.

7. **Multiple message types** — The current `onEvent()` handles all event types (messages, method calls, roster changes, etc.). The new model only has `onMessage()`. Other event types would either be handled by the host or need additional handler hooks (e.g., `onRosterChange()`). For V1, `onMessage()` is likely sufficient.

8. **Concurrency** — Should agents handle multiple messages concurrently? The current queue enforces serial processing. The host queue does the same. But some agents might benefit from concurrent handling (e.g., a search agent that doesn't accumulate conversation state).

### Implementation phases

#### Phase 1: `@natstack/agent` package + build target
- Create the `@natstack/agent` package with `defineAgent()` and types
- Add `buildWorkerdAgent()` to the V2 build system
- Implement the guard plugin
- Extend manifest with `runtime: "workerd"`

#### Phase 2: WorkerdHost
- Create `WorkerdHost` with miniflare management
- Implement service bindings (AI, CHANNEL, TOOLS, HOST)
- Implement `AgentQueue` for message serialization
- Route in `AgentHost` based on manifest runtime

#### Phase 3: Test agent
- Create a simple test agent using `defineAgent()`
- Validate the full stack: build → deploy → receive message → stream AI → reply

#### Phase 4: Move builtins
- Move Claude Code and Codex to `src/agents/`
- Register as builtins in `AgentHost`
- Remove from `workspace/agents/`

#### Phase 5: Port pubsub-chat-responder
- Rewrite as a workerd agent using `defineAgent()`
- Validate feature parity (tools, settings, streaming, interrupts)
- This becomes the reference implementation for user agents

#### Phase 6: Hardening
- Outbound network control
- Hot reload
- Error isolation
- Resource monitoring
- Developer experience (error messages, debugging)

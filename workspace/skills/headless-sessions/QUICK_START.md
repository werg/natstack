# Quick Start

## 1. One-liner: HeadlessSession with Agent

The simplest way to run a headless agentic session with eval support:

```typescript
import { HeadlessSession } from "@workspace/agentic-session";
import { createNodeSandboxConfig } from "@workspace/agentic-session";

const session = await HeadlessSession.createWithAgent({
  config: { serverUrl: pubsubUrl, token, clientId: "my-harness" },
  sandbox: createNodeSandboxConfig(rpcClient),
  rpcCall: (t, m, ...a) => rpcClient.call(t, m, ...a),
  source: "agent-worker",
  className: "AiChatWorker",
  contextId: myContextId,
});

// Send a message and wait for the agent's response
await session.send("Calculate the first 10 fibonacci numbers using eval");
const response = await session.waitForAgentMessage({ timeout: 30_000 });
console.log(response.content);

// Clean up
await session.close();
```

This automatically:
- Creates a unique channel and subscribes the DO agent
- Configures full-auto approval (no UI needed)
- Registers eval and set_title methods on the client
- Creates a ScopeManager for persistent scope across eval calls
- Uses a headless system prompt (no inline_ui/feedback references)

## 2. Two-step: Create then Connect

For more control over channel/subscription setup:

```typescript
import { HeadlessSession } from "@workspace/agentic-session";
import { subscribeHeadlessAgent } from "@workspace/agentic-session";

// Create session
const session = HeadlessSession.create({
  config: { serverUrl: pubsubUrl, token, clientId: "my-harness" },
  sandbox: createNodeSandboxConfig(rpcClient),
});

// Subscribe agent separately
await subscribeHeadlessAgent({
  rpcCall: (t, m, ...a) => rpcClient.call(t, m, ...a),
  source: "agent-worker",
  className: "AiChatWorker",
  objectKey: "my-specific-do",
  channelId: "my-channel",
  contextId: myContextId,
});

// Connect (auto-creates ScopeManager, registers eval/set_title)
await session.connect("my-channel", { contextId: myContextId });
```

## 3. SessionManager Directly (no headless defaults)

For maximum control — no defaults, no convenience wrappers:

```typescript
import { SessionManager } from "@workspace/agentic-core";

const manager = new SessionManager({
  config: { serverUrl: pubsubUrl, token, clientId: "raw-client" },
});

await manager.connect("existing-channel", {
  methods: { /* your custom methods */ },
  contextId: myContextId,
});

// Subscribe to events
manager.on("messagesChanged", (msgs) => console.log("Messages:", msgs.length));
manager.on("connectionChanged", (connected) => console.log("Connected:", connected));

await manager.send("Hello from headless");
await manager.close();
```

## 4. Messaging Only (no eval)

When you don't need eval/scope — just messaging:

```typescript
const session = await HeadlessSession.createWithAgent({
  config: { serverUrl: pubsubUrl, token, clientId: "messaging-only" },
  // No sandbox → no eval, toolAllowlist is ["set_title"] only
  rpcCall: (t, m, ...a) => rpcClient.call(t, m, ...a),
  source: "agent-worker",
  className: "AiChatWorker",
  contextId: myContextId,
});
```

The headless prompt automatically adjusts — it won't mention eval, and the harness config restricts the agent to set_title only.

## 5. Worker/DO Context

From inside a Durable Object or worker:

```typescript
import { createWorkerSandboxConfig } from "@workspace/agentic-session";

// rpc is available in the worker runtime
const sandbox = createWorkerSandboxConfig(rpc);

const session = await HeadlessSession.createWithAgent({
  config: { serverUrl: pubsubUrl, token, clientId: `worker-${objectKey}` },
  sandbox,
  rpcCall: (t, m, ...a) => rpc.call(t, m, ...a),
  source: "agent-worker",
  className: "AiChatWorker",
  contextId,
});
```

## SandboxConfig Factories

| Factory | Context | db.open behavior |
|---------|---------|-----------------|
| `createPanelSandboxConfig(rpc, db)` | Panel (browser) | Direct DB handle from panel runtime |
| `createWorkerSandboxConfig(rpc)` | Worker/DO | RPC handle → DbHandle proxy (exec/run/get/query/close via RPC) |
| `createNodeSandboxConfig(rpcClient)` | Node.js server | RPC handle → DbHandle proxy (same as worker) |

All three route `loadImport` through `build.getBuild` / `build.getBuildNpm` RPC calls.

# @natstack/rpc

Unified RPC bridge for NatStack panels, workers, and shell. This package provides the core communication layer that enables all parts of the application to call methods and emit events using a consistent API.

## Installation

```bash
pnpm add @natstack/rpc
```

## Overview

The RPC system has three main components:

1. **RpcBridge** - The high-level API for making calls and handling events
2. **RpcTransport** - Abstraction for the underlying message delivery mechanism
3. **Handler Registry** - Utility for routing messages to handlers

## Quick Start

```typescript
import { createRpcBridge, createHandlerRegistry } from "@natstack/rpc";

// 1. Create a transport (platform-specific)
const registry = createHandlerRegistry();
const transport = {
  async send(targetId, message) {
    // Send message to target via your platform's IPC mechanism
  },
  onMessage: registry.onMessage,
  onAnyMessage: registry.onAnyMessage,
};

// 2. Create the bridge
const rpc = createRpcBridge({
  selfId: "panel:my-panel",
  transport,
  callTimeoutMs: 30000,
});

// 3. Expose methods that others can call
rpc.expose({
  greet: (name: string) => `Hello, ${name}!`,
  async fetchData(id: string) {
    return await database.get(id);
  },
});

// 4. Call methods on other endpoints
const result = await rpc.call<string>("panel:other", "greet", "World");

// 5. Emit events
await rpc.emit("panel:other", "data-updated", { id: "123" });

// 6. Listen for events
const unsub = rpc.onEvent("data-updated", (fromId, payload) => {
  console.log(`Got update from ${fromId}:`, payload);
});
```

## API Reference

### `createRpcBridge(config)`

Create an RPC bridge instance.

```typescript
interface RpcBridgeConfig {
  /** Unique ID for this endpoint (e.g., "panel:abc" or "worker:xyz") */
  selfId: string;
  /** Transport implementation for message delivery */
  transport: RpcTransport;
  /** Timeout for regular RPC calls in ms (default: 30000) */
  callTimeoutMs?: number;
  /** Timeout for AI-related calls in ms (default: 300000) */
  aiCallTimeoutMs?: number;
}
```

Returns an `RpcBridge` with these methods:

#### `rpc.expose(methods)`

Register methods that can be called by other endpoints.

```typescript
rpc.expose({
  methodName: (arg1, arg2) => result,
  asyncMethod: async (arg) => await doWork(arg),
});
```

#### `rpc.call<T>(targetId, method, ...args)`

Call a method on another endpoint. Returns a promise that resolves with the result or rejects on error/timeout.

```typescript
const result = await rpc.call<User>("panel:auth", "getUser", userId);
```

#### `rpc.emit(targetId, event, payload)`

Send a one-way event to another endpoint.

```typescript
await rpc.emit("panel:dashboard", "refresh", { reason: "data-changed" });
```

#### `rpc.onEvent(event, listener)`

Listen for events from any endpoint. Returns an unsubscribe function.

```typescript
const unsub = rpc.onEvent("refresh", (fromId, payload) => {
  console.log(`Refresh requested by ${fromId}`);
});

// Later: stop listening
unsub();
```

### `createHandlerRegistry(options?)`

Create a handler registry for routing incoming messages.

```typescript
const registry = createHandlerRegistry({ context: "worker" });

// Use in your transport
const transport = {
  onMessage: registry.onMessage,
  onAnyMessage: registry.onAnyMessage,
  // ...
};

// Deliver messages from your platform's IPC
ipc.on("message", (sourceId, message) => {
  registry.deliver(sourceId, message);
});
```

### Endpoint ID Helpers

```typescript
import { panelId, workerId, parseEndpointId } from "@natstack/rpc";

panelId("abc");        // "panel:abc"
workerId("xyz");       // "worker:xyz"

parseEndpointId("panel:abc");  // { type: "panel", id: "abc" }
parseEndpointId("worker:xyz"); // { type: "worker", id: "xyz" }
```

## Transport Implementation

The `RpcTransport` interface must be implemented for your platform:

```typescript
interface RpcTransport {
  /** Send a message to a target endpoint */
  send(targetId: string, message: RpcMessage): Promise<void>;

  /** Listen for messages from a specific source */
  onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void;

  /** Listen for messages from any source */
  onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void;
}
```

### Example: Worker Transport

```typescript
import { createHandlerRegistry, type RpcTransport } from "@natstack/rpc";

export function createWorkerTransport(): RpcTransport {
  const registry = createHandlerRegistry({ context: "worker" });

  // Hook into worker's message receiver
  globalThis.__rpcReceive = (fromId, message) => {
    registry.deliver(fromId, message);
  };

  return {
    async send(targetId, message) {
      __rpcSend(targetId, message);
    },
    onMessage: registry.onMessage,
    onAnyMessage: registry.onAnyMessage,
  };
}
```

## Message Protocol

The RPC system uses three message types:

### Request

```typescript
{
  type: "request",
  requestId: "uuid",
  fromId: "panel:sender",
  method: "methodName",
  args: [arg1, arg2]
}
```

### Response

```typescript
// Success
{ type: "response", requestId: "uuid", result: value }

// Error
{ type: "response", requestId: "uuid", error: "error message" }
```

### Event

```typescript
{
  type: "event",
  fromId: "panel:sender",
  event: "eventName",
  payload: data
}
```

## Usage in NatStack

### Panels

Panels access the RPC bridge via `@natstack/runtime`:

```typescript
import { rpc } from "@natstack/runtime";
await rpc.call("main", "bridge.createChild", spec);
```

### Workers

Workers also import from `@natstack/runtime`:

```typescript
import { rpc } from "@natstack/runtime";
await rpc.call("main", "db.open", "mydb");
```

### Shell

The shell renderer uses RPC to communicate with main process services:

```typescript
import { rpc } from "@natstack/runtime";

// Call main process services
const info = await rpc.call<AppInfo>("main", "app.getInfo");
const tree = await rpc.call<Panel[]>("main", "panel.getTree");

// Subscribe to events
await rpc.call("main", "events.subscribe", "panel-tree-updated");

// Listen for events
rpc.onEvent("event:panel-tree-updated", (fromId, payload) => {
  console.log("Panel tree updated:", payload);
});
```

The shell uses the same `@natstack/runtime` package. Environment detection (`__natstackKind === "shell"`) selects the shell transport which routes calls through `shell-rpc:call`.

All three consumers (panels, workers, shell) use identical APIs - the transport implementation handles platform differences.

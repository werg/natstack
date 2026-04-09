# Chat API

The `chat` object enables sandbox code (eval) and components (inline_ui, feedback_custom) to interact with the conversation.

## Access

- **Eval code**: `chat` is pre-injected as a binding variable
- **Inline UI components**: received as `{ props, chat }` prop
- **Feedback components**: received as `{ onSubmit, onCancel, onError, chat }` prop

## Interface

```typescript
interface ChatSandboxValue {
  /** Publish an event to the channel */
  publish(eventType: string, payload: unknown, options?: { persist?: boolean }): Promise<unknown>;

  /** Call a method on a channel participant */
  callMethod(participantId: string, method: string, args: unknown): Promise<unknown>;

  /** Current context ID */
  contextId: string;

  /** Current channel ID */
  channelId: string | null;

  /** RPC bridge — call any server/main service */
  rpc: { call: (target: string, method: string, ...args: unknown[]) => Promise<unknown> };
}
```

## chat.publish

Send events to the PubSub channel. All participants (panels, agents) receive them.

### Send a message

```typescript
await chat.publish("message", { content: "Hello from sandbox!" });
```

The message appears in the conversation. UUIDs are auto-generated if not provided. The message will appear as sent by the panel (the "user" side).

### Options

```typescript
await chat.publish("message", { content: "..." }, { persist: true });  // default: persisted
await chat.publish("message", { content: "..." }, { persist: false }); // ephemeral
```

## chat.callMethod

Call a registered method on a specific channel participant. Blocks until the method returns.

```typescript
// Call a method on an agent
const result = await chat.callMethod("agent-participant-id", "someMethod", { arg1: "value" });
```

This is useful for inline UI components that need to trigger agent-side behavior directly.

## chat.rpc

Full RPC bridge to all server and main-process services. Same as `rpc` from `@workspace/runtime`, but available in components that don't import the runtime.

```typescript
// Filesystem
const content = await chat.rpc.call("main", "fs.readFile", "/src/index.ts", "utf-8");

// Database
const handle = await chat.rpc.call("main", "db.open", "my-data");
const rows = await chat.rpc.call("main", "db.query", handle, "SELECT * FROM items");

// Build
const build = await chat.rpc.call("main", "build.getBuild", "panels/my-app");

// Browser data
const browsers = await chat.rpc.call("main", "browser-data.detectBrowsers");

// Workers
const instances = await chat.rpc.call("main", "workerd.listInstances");
```

## chat.contextId / chat.channelId

Read-only identifiers for the current panel context and PubSub channel.

```typescript
console.log("Context:", chat.contextId);   // e.g., "ctx-tree-new-abc123"
console.log("Channel:", chat.channelId);   // e.g., "chat-504fef6a"
```

## Sender Identity

Messages sent via `chat.publish` appear as coming from the **panel** (the user), not the agent. This is because the panel's PubSub client is the sender. If you need messages to appear differently, include sender info in the payload:

```typescript
await chat.publish("message", {
  content: "Deployment started",
  metadata: { source: "inline_ui", widget: "deploy-button" }
});
```

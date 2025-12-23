# @natstack/agentic-messaging

Agentic messaging protocol and SDK over `@natstack/pubsub`. Enables tool discovery, invocation, and streaming results between distributed participants.

## Installation

```bash
pnpm add @natstack/agentic-messaging
```

## Quick Start

```typescript
import { connect } from "@natstack/agentic-messaging";
import { z } from "zod";

// Connect as a tool provider
const client = connect(serverUrl, token, {
  channel: "my-channel",
  metadata: { name: "My Worker", type: "worker" },
  tools: {
    greet: {
      description: "Say hello",
      parameters: z.object({ name: z.string() }),
      execute: async (args) => `Hello, ${args.name}!`,
    },
  },
});

await client.ready();
```

## Overview

This package builds on `@natstack/pubsub` to provide:

- **Message consumers** - Send/receive chat-like messages with streaming support
- **Tool providers** - Advertise and execute tools with automatic dispatch
- **Tool users** - Discover and invoke tools on other participants

A single participant can act as any combination of these roles.

## Connecting

```typescript
import { connect, type AgenticClient } from "@natstack/agentic-messaging";

const client = connect(serverUrl, token, {
  // Required
  channel: "my-channel",
  metadata: { name: "My Agent", type: "agent" },

  // Optional: tools this participant provides
  tools: { /* ... */ },

  // Optional: replay messages since this ID
  sinceId: 12345,

  // Optional: auto-reconnect on disconnect
  reconnect: true,  // or { delayMs: 1000, maxDelayMs: 30000, maxAttempts: 10 }

  // Optional: for echo suppression
  clientId: "my-client-id",
  skipOwnMessages: true,
});

await client.ready();
```

## Messaging API

### Sending Messages

```typescript
// Send a simple message
const messageId = await client.send("Hello, world!");

// Send with options
const id = await client.send("Check this out", {
  replyTo: previousMessageId,
  persist: true,  // default
  attachment: imageBytes,
  contentType: "image/png",
});
```

### Streaming Messages

```typescript
// Start a message
const id = await client.send("Thinking", { persist: false });

// Stream updates
await client.update(id, "...");
await client.update(id, " more content");

// Mark complete
await client.complete(id);

// Or mark as error
await client.error(id, "Something went wrong", "internal-error");
```

### Receiving Events

```typescript
// Unified event stream for all incoming data
for await (const event of client.events()) {
  switch (event.type) {
    case "message":
      console.log(`New message: ${event.content}`);
      if (event.attachment) {
        // Handle binary attachment
      }
      break;

    case "update-message":
      console.log(`Update to ${event.id}: ${event.content}`);
      if (event.complete) console.log("Message complete");
      break;

    case "error":
      console.error(`Error on ${event.id}: ${event.error}`);
      break;

    case "tool-call":
      console.log(`Tool call: ${event.toolName} from ${event.senderId}`);
      break;

    case "tool-result":
      console.log(`Tool result for ${event.callId}: ${event.content}`);
      break;

    case "presence":
      console.log(`${event.senderId} ${event.action}ed`);
      break;
  }
}

// Filter to only receive targeted messages (for agents)
for await (const event of client.events({ targetedOnly: true })) {
  // Only yields message events where this client is in the `at` field
}
```

## Tool Provider API

Tools are declared at connection time and automatically executed when called:

```typescript
import { z } from "zod";

const client = connect(serverUrl, token, {
  channel: "tools-channel",
  metadata: { name: "Tool Provider", type: "worker" },
  tools: {
    search: {
      description: "Search for files",
      parameters: z.object({
        pattern: z.string().describe("Glob pattern"),
        maxResults: z.number().int().positive().default(100),
      }),
      returns: z.array(z.string()),  // optional
      timeout: 30000,  // suggested timeout in ms
      streaming: true,

      async execute(args, context) {
        // Access execution context
        const { callId, callerId, signal } = context;

        // Stream partial results
        for await (const result of performSearch(args.pattern)) {
          if (signal.aborted) break;
          await context.stream(result);
        }

        // Report progress
        await context.progress(50);

        // Return final result
        return results;
      },
    },

    generateImage: {
      description: "Generate an image",
      parameters: z.object({ prompt: z.string() }),

      async execute(args, context) {
        const imageData = await generate(args.prompt);

        // Return result with binary attachment
        return context.resultWithAttachment(
          { width: 512, height: 512 },
          imageData,
          { contentType: "image/png" }
        );
      },
    },
  },
});
```

### ToolExecutionContext

```typescript
interface ToolExecutionContext {
  callId: string;              // Unique call identifier
  callerId: string;            // ID of the calling participant
  signal: AbortSignal;         // Aborted when caller cancels

  stream(content: unknown): Promise<void>;
  streamWithAttachment(content: unknown, attachment: Uint8Array, options?: { contentType?: string }): Promise<void>;
  resultWithAttachment<T>(content: T, attachment: Uint8Array, options?: { contentType?: string }): ToolResultWithAttachment<T>;
  progress(percent: number): Promise<void>;
}
```

## Tool User API

### Discovering Tools

```typescript
// Get all tools from all participants
const allTools = client.discoverToolDefs();

// Get tools from a specific participant
const providerTools = client.discoverToolDefsFrom(providerId);

// Each discovered tool includes:
interface DiscoveredTool {
  providerId: string;
  providerName: string;
  name: string;
  description?: string;
  parameters: JsonSchema;
  returns?: JsonSchema;
  streaming: boolean;
  timeout?: number;
}
```

### Calling Tools

```typescript
const result = client.callTool(providerId, "search", { pattern: "*.ts" }, {
  signal: abortController.signal,  // optional
  timeoutMs: 60000,                // optional, overrides advertised timeout
  validateArgs: searchArgsSchema,  // optional Zod schema
});

// Wait for final result
const value = await result.result;
console.log(value.content);
if (value.attachment) {
  // Handle binary attachment
}

// Or stream partial results
for await (const chunk of result.stream) {
  console.log("Chunk:", chunk.content);
  if (chunk.progress !== undefined) {
    console.log(`Progress: ${chunk.progress}%`);
  }
}

// Cancel if needed
await result.cancel();

// Check status
console.log(result.complete, result.isError);
```

### AI Integration

Use `createToolsForAgentSDK` to collect tools in a format ready for LLM tool use:

```typescript
import { createToolsForAgentSDK } from "@natstack/agentic-messaging";

// Get tools for AI SDK - creates stable, prefixed tool names
const { definitions, execute } = createToolsForAgentSDK(client, {
  namePrefix: "pubsub",  // Optional: defaults to "pubsub"
});

// Use with your AI library
const response = await ai.generateText({
  model: "smart",
  messages: conversation,
  tools,
});
```

## Roster & Presence

```typescript
// Current roster
const participants = client.roster;

for (const [id, participant] of Object.entries(participants)) {
  console.log(`${participant.metadata.name} (${participant.metadata.type})`);
  if (participant.metadata.tools) {
    console.log(`  Tools: ${participant.metadata.tools.map(t => t.name).join(", ")}`);
  }
}

// Listen for roster changes
const unsubscribe = client.onRoster((update) => {
  console.log("Roster updated:", Object.keys(update.participants));
});
```

## Connection Management

```typescript
// Check connection status
console.log(client.connected, client.reconnecting);

// Wait for ready (replay complete)
await client.ready(30000);  // timeout in ms

// Event handlers
client.onError((error) => console.error("Error:", error));
client.onDisconnect(() => console.log("Disconnected"));
client.onReconnect(() => console.log("Reconnected"));

// Close connection
client.close();

// Access underlying pubsub client (escape hatch)
client.pubsub.publish("custom-type", { data: "raw" });
```

## Error Handling

```typescript
import { AgenticError, ValidationError } from "@natstack/agentic-messaging";

try {
  const result = await client.callTool(providerId, "search", args).result;
} catch (error) {
  if (error instanceof AgenticError) {
    switch (error.code) {
      case "tool-not-found":
      case "provider-not-found":
      case "provider-offline":
      case "execution-error":
      case "timeout":
      case "cancelled":
      case "validation-error":
      case "connection-error":
        // Handle specific error
        break;
    }
  }
}

// Validation errors during send/receive
client.onError((error) => {
  if (error instanceof ValidationError) {
    console.warn(`Invalid ${error.direction} message:`, error.details);
  }
});
```

## Protocol Messages

All messages are validated using Zod schemas. The protocol uses these message types:

| Type | Purpose |
|------|---------|
| `message` | New chat message |
| `update-message` | Update to existing message (streaming) |
| `error` | Error on a message |
| `tool-call` | Tool invocation request |
| `tool-result` | Tool result (can stream) |
| `tool-cancel` | Cancel a tool call |

## Design Principles

1. **Validated protocol** - All messages validated at send and receive time
2. **Presence-based discovery** - Tools advertised via roster metadata
3. **Streaming-first** - Tool results can stream incrementally
4. **Correlation-based** - Parallel execution via call ID correlation
5. **Persistent by default** - Tool calls and results persisted for replay
6. **Binary attachments** - Native binary support without base64 overhead

## TypeScript Types

```typescript
// Re-exported for convenience
export {
  AgenticClient,
  AgenticParticipantMetadata,
  AgenticError,
  AgenticErrorCode,
  ValidationError,
  ConnectOptions,
  ToolDefinition,
  ToolExecutionContext,
  ToolCallResult,
  ToolResultValue,
  ToolResultChunk,
  DiscoveredTool,
  IncomingEvent,
  IncomingMessage,
  IncomingNewMessage,
  IncomingUpdateMessage,
  IncomingErrorMessage,
  IncomingToolCall,
  IncomingToolResult,
  IncomingPresenceEvent,
  EventFilterOptions,
} from "@natstack/agentic-messaging";
```

## Dependencies

- `@natstack/pubsub` - Transport layer
- `zod` - Runtime validation
- `zod-to-json-schema` - Convert Zod to JSON Schema for metadata

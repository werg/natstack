# @natstack/agentic-messaging

Agentic messaging protocol and SDK over `@natstack/pubsub`. Enables method discovery, invocation, and streaming results between distributed participants.

## Installation

```bash
pnpm add @natstack/agentic-messaging
```

## Quick Start

```typescript
import { connect } from "@natstack/agentic-messaging";
import { z } from "zod";

// Connect as a method provider
const client = await connect({
  serverUrl,
  token,
  channel: "my-channel",
  handle: "my-worker",
  name: "My Worker",
  type: "worker",
  methods: {
    greet: {
      description: "Say hello",
      parameters: z.object({ name: z.string() }),
      execute: async (args) => `Hello, ${args.name}!`,
    },
  },
});
```

## Overview

This package builds on `@natstack/pubsub` to provide:

- **Message consumers** - Send/receive chat-like messages with streaming support
- **Method providers** - Advertise and execute methods with automatic dispatch
- **Method users** - Discover and invoke methods on other participants

A single participant can act as any combination of these roles.

## Connecting

```typescript
import { connect, type AgenticClient } from "@natstack/agentic-messaging";

const client = await connect({
  // Required
  serverUrl,
  token,
  channel: "my-channel",
  handle: "my-agent",
  name: "My Agent",
  type: "agent",

  // Optional: methods this participant provides
  methods: { /* ... */ },

  // Optional: session persistence
  workspaceId: "my-workspace",

  // Optional: replay behavior ("collect" | "stream" | "skip")
  replayMode: "collect",

  // Optional: auto-reconnect on disconnect
  reconnect: true,  // or { delayMs: 1000, maxDelayMs: 30000, maxAttempts: 10 }

  // Optional: for echo suppression
  clientId: "my-client-id",
  skipOwnMessages: true,
});
```

## Messaging API

### Sending Messages

`send()` returns both the client-generated message ID and the server-assigned pubsub ID (undefined for ephemeral messages).

```typescript
// Send a simple message
const { messageId, pubsubId } = await client.send("Hello, world!");

// Send with options
const { messageId: replyId } = await client.send("Check this out", {
  replyTo: previousMessageId,
  persist: true,  // default
  attachments: [{ id: "img_1", data: imageBytes, mimeType: "image/png" }],
});
```

### Streaming Messages

`update()`, `complete()`, and `error()` return the pubsub ID for the persisted update (or undefined if not persisted).

```typescript
// Start a message
const { messageId } = await client.send("Thinking", { persist: false });

// Stream updates
await client.update(messageId, "...");
await client.update(messageId, " more content");

// Mark complete
await client.complete(messageId);

// Or mark as error
await client.error(messageId, "Something went wrong", "internal-error");
```

### Receiving Events

```typescript
// Unified event stream for all incoming data
for await (const event of client.events()) {
  switch (event.type) {
    case "message":
      console.log(`New message: ${event.content}`);
      if (event.attachments) {
        // Handle binary attachments
      }
      break;

    case "update-message":
      console.log(`Update to ${event.id}: ${event.content}`);
      if (event.complete) console.log("Message complete");
      break;

    case "error":
      console.error(`Error on ${event.id}: ${event.error}`);
      break;

    case "method-call":
      console.log(`Method call: ${event.methodName} from ${event.senderId}`);
      break;

    case "method-result":
      console.log(`Method result for ${event.callId}: ${event.content}`);
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

// Include replay or ephemeral events if desired
for await (const event of client.events({ includeReplay: true, includeEphemeral: true })) {
  // Replay events are either aggregated (collect) or raw (stream)
}
```

## Method Provider API

Methods are declared at connection time and automatically executed when called:

```typescript
import { z } from "zod";

const client = await connect({
  serverUrl,
  token,
  channel: "methods-channel",
  handle: "method-provider",
  name: "Method Provider",
  type: "worker",
  methods: {
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

        // Return result with binary attachments
        return context.resultWithAttachments(
          { width: 512, height: 512 },
          [{ id: "img_1", data: imageData, mimeType: "image/png" }]
        );
      },
    },
  },
});
```

### MethodExecutionContext

```typescript
interface MethodExecutionContext {
  callId: string;              // Unique call identifier
  callerId: string;            // ID of the calling participant
  signal: AbortSignal;         // Aborted when caller cancels

  stream(content: unknown): Promise<void>;
  streamWithAttachments(content: unknown, attachments: Attachment[], options?: { contentType?: string }): Promise<void>;
  resultWithAttachments<T>(content: T, attachments: Attachment[], options?: { contentType?: string }): MethodResultWithAttachments<T>;
  progress(percent: number): Promise<void>;
}
```

### Streaming Method Patterns

#### Progress Reporting

```typescript
methods: {
  analyze: {
    description: "Analyze a large dataset",
    parameters: z.object({ datasetId: z.string() }),
    streaming: true,
    async execute(args, ctx) {
      const chunks = await loadDataset(args.datasetId);
      const results = [];

      for (let i = 0; i < chunks.length; i++) {
        if (ctx.signal.aborted) break;

        // Report progress as percentage
        await ctx.progress(Math.round((i / chunks.length) * 100));

        results.push(await processChunk(chunks[i]));
      }

      return { results, total: results.length };
    },
  },
}
```

#### Streaming Partial Results

```typescript
methods: {
  search: {
    description: "Search files with streaming results",
    parameters: z.object({ pattern: z.string() }),
    streaming: true,
    async execute(args, ctx) {
      const matches = [];

      for await (const file of globStream(args.pattern)) {
        if (ctx.signal.aborted) break;

        // Stream each result as it's found
        await ctx.stream({ file, found: true });
        matches.push(file);
      }

      // Final result includes all matches
      return { matches, count: matches.length };
    },
  },
}
```

#### Binary Attachments

```typescript
methods: {
  screenshot: {
    description: "Take a screenshot",
    parameters: z.object({ selector: z.string().optional() }),
    async execute(args, ctx) {
      const imageBuffer = await captureScreen(args.selector);

      // Return metadata with binary attachments
      return ctx.resultWithAttachments(
        { width: 1920, height: 1080, format: "png" },
        [{ id: "img_1", data: imageBuffer, mimeType: "image/png" }]
      );
    },
  },

  streamImages: {
    description: "Generate images progressively",
    parameters: z.object({ prompts: z.array(z.string()) }),
    streaming: true,
    async execute(args, ctx) {
      const results = [];

      for (const prompt of args.prompts) {
        if (ctx.signal.aborted) break;

        const image = await generateImage(prompt);

        // Stream each image with its binary data
        await ctx.streamWithAttachments(
          { prompt, index: results.length },
          [{ id: `img_${results.length + 1}`, data: image, mimeType: "image/png" }]
        );

        results.push(prompt);
      }

      return { generated: results.length };
    },
  },
}
```

#### Handling Cancellation

```typescript
methods: {
  longRunning: {
    description: "A cancellable long-running task",
    parameters: z.object({ iterations: z.number() }),
    streaming: true,
    async execute(args, ctx) {
      const results = [];

      for (let i = 0; i < args.iterations; i++) {
        // Check for cancellation before each step
        if (ctx.signal.aborted) {
          // Return partial results on cancellation
          return {
            results,
            cancelled: true,
            completedIterations: i
          };
        }

        await ctx.progress(Math.round((i / args.iterations) * 100));
        results.push(await doWork(i));
      }

      return { results, cancelled: false, completedIterations: args.iterations };
    },
  },
}
```

## Method User API

### Discovering Methods

```typescript
// Get all methods from all participants
const allMethods = client.discoverMethodDefs();

// Get methods from a specific participant
const providerMethods = client.discoverMethodDefsFrom(providerId);

// Each discovered method includes:
interface DiscoveredMethod {
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

### Calling Methods

```typescript
const result = client.callMethod(providerId, "search", { pattern: "*.ts" }, {
  signal: abortController.signal,  // optional
  timeoutMs: 60000,                // optional, overrides advertised timeout
  validateArgs: searchArgsSchema,  // optional Zod schema
});

// Wait for final result
const value = await result.result;
console.log(value.content);
if (value.attachments) {
  // Handle binary attachments
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
  if (participant.metadata.methods) {
    console.log(`  Methods: ${participant.metadata.methods.map(m => m.name).join(", ")}`);
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

// connect() resolves after initial replay completes

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
  const result = await client.callMethod(providerId, "search", args).result;
} catch (error) {
  if (error instanceof AgenticError) {
    switch (error.code) {
      case "method-not-found":
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

## Utility Functions

### Schema Conversion

Convert between JSON Schema and Zod for tool interoperability:

```typescript
import { jsonSchemaToZod, jsonSchemaToZodRawShape } from "@natstack/agentic-messaging";

// Convert JSON Schema to Zod schema
const zodSchema = jsonSchemaToZod(jsonSchema);

// Convert to raw shape for z.object()
const shape = jsonSchemaToZodRawShape(jsonSchema);
const schema = z.object(shape);
```

### Message Targeting

Check if a message is targeted at a specific participant:

```typescript
import { isMessageTargetedAt } from "@natstack/agentic-messaging";

for await (const event of client.events()) {
  if (event.type === "message") {
    const isForMe = isMessageTargetedAt(event, client.clientId, "my-handle");
    if (isForMe) {
      // Handle targeted message
    }
  }
}
```

### Execution Pause/Resume

For agents that support pausing mid-execution:

```typescript
import { createPauseMethodDefinition, createInterruptHandler } from "@natstack/agentic-messaging";

const client = await connect({
  // ...
  methods: {
    pause: createPauseMethodDefinition(async () => {
      // Called when pause is requested
    }),
  },
});

// In your message handler
const handler = createInterruptHandler({
  client,
  messageId: incomingMessage.id,
  onPause: async (reason) => {
    console.log(`Paused: ${reason}`);
    // Stop current processing
  },
});

void handler.monitor(); // Start monitoring in background
```

## Protocol Messages

All messages are validated using Zod schemas. The protocol uses these message types:

| Type | Purpose |
|------|---------|
| `message` | New chat message |
| `update-message` | Update to existing message (streaming) |
| `error` | Error on a message |
| `method-call` | Method invocation request |
| `method-result` | Method result (can stream) |
| `method-cancel` | Cancel a method call |
| `execution-pause` | Pause/interrupt agent execution |

## Design Principles

1. **Validated protocol** - All messages validated at send and receive time
2. **Presence-based discovery** - Methods advertised via roster metadata
3. **Streaming-first** - Method results can stream incrementally
4. **Correlation-based** - Parallel execution via call ID correlation
5. **Persistent by default** - Method calls and results persisted for replay
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
  MethodDefinition,
  MethodExecutionContext,
  MethodCallHandle,
  MethodResultValue,
  MethodResultChunk,
  DiscoveredMethod,
  IncomingEvent,
  IncomingMessage,
  IncomingNewMessage,
  IncomingUpdateMessage,
  IncomingErrorMessage,
  IncomingMethodCall,
  IncomingMethodResult,
  IncomingPresenceEvent,
  EventFilterOptions,
} from "@natstack/agentic-messaging";
```

## Dependencies

- `@natstack/pubsub` - Transport layer
- `zod` - Runtime validation
- `zod-to-json-schema` - Convert Zod to JSON Schema for metadata

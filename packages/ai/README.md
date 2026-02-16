# @workspace/ai

Unified AI SDK for NatStack panels and workers. This package provides a `streamText` API that is compatible with the [Vercel AI SDK](https://ai-sdk.dev/) patterns while working identically for all model types, including standard chat completions (Anthropic, OpenAI, etc.) and Claude Code models.

## Installation

```bash
pnpm add @workspace/ai
```

## Quick Start

```typescript
import { streamText, tool, getRoles } from "@workspace/ai";
import { z } from "zod";

// Get available model roles
const roles = await getRoles();
console.log(roles.fast.displayName); // e.g., "Claude Haiku 4.5"

// Define tools with Zod schemas (Vercel AI SDK compatible)
const tools = {
  get_weather: tool({
    description: "Get weather for a location",
    parameters: z.object({
      city: z.string().describe("City name"),
    }),
    execute: async ({ city }) => ({ temperature: 72, city }),
  }),
};

// Stream with callbacks
const result = streamText({
  model: "fast",
  messages: [{ role: "user", content: "What's the weather in NYC?" }],
  tools,
  onChunk: (chunk) => console.log("Chunk:", chunk.type),
  onFinish: (result) => console.log("Done!", result.text),
});

// Multiple ways to consume the stream:
// 1. AsyncIterable
for await (const event of result) {
  if (event.type === "text-delta") process.stdout.write(event.text);
}

// 2. Text-only stream
for await (const text of result.textStream) {
  process.stdout.write(text);
}

// 3. Await final values
const finalText = await result.text;
const allToolCalls = await result.toolCalls;
```

## Vercel AI SDK Compatibility

This package implements patterns from the Vercel AI SDK to minimize migration effort:

### Compatible Features

| Feature | Vercel AI SDK | @workspace/ai |
|---------|--------------|--------------|
| `tool()` helper | ✅ | ✅ |
| Zod schema support | ✅ | ✅ |
| `onChunk` callback | ✅ | ✅ |
| `onFinish` callback | ✅ | ✅ |
| `onStepFinish` callback | ✅ | ✅ |
| `onError` callback | ✅ | ✅ |
| `textStream` | ✅ | ✅ |
| `fullStream` | ✅ | ✅ |
| `result.text` promise | ✅ | ✅ |
| `result.toolCalls` promise | ✅ | ✅ |
| `result.usage` promise | ✅ | ✅ |

### Key Differences

#### 1. Model Selection via Roles

Instead of importing provider-specific models, you reference models by **role name**:

```typescript
// Vercel AI SDK
import { anthropic } from "@ai-sdk/anthropic";
const result = streamText({ model: anthropic("claude-3-5-sonnet") });

// @workspace/ai
const result = streamText({ model: "fast" }); // Role name
```

Standard roles:
- `smart` - Best quality model
- `fast` - Fastest model
- `cheap` - Most cost-effective model
- `coding` - Optimized for code tasks

You can also use full model IDs: `anthropic:claude-haiku-4-5-20251001`

#### 2. Server-Side Agent Loop

The tool-calling loop runs server-side automatically. Tool `execute` callbacks run panel-side via IPC:

```typescript
// No manual loop needed - maxSteps controls iterations
const result = streamText({
  model: "smart",
  messages: [...],
  tools: { ... },
  maxSteps: 5, // Max tool-use iterations (default: 10)
});
```

#### 3. JSON Schema for Parameters

While we support Zod via the `tool()` helper, you can also use JSON Schema directly:

```typescript
// With tool() helper and Zod
const weatherTool = tool({
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ temp: 72 }),
});

// Or with JSON Schema directly
const tools = {
  weather: {
    description: "Get weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    execute: async ({ city }) => ({ temp: 72 }),
  },
};
```

## API Reference

### `streamText(options)`

Stream text generation with optional tool support.

```typescript
function streamText(options: StreamTextOptions): StreamTextResult;

interface StreamTextOptions {
  /** Model role ("fast", "smart", etc.) or full ID */
  model: string;

  /** Conversation messages */
  messages: Message[];

  /** Tools with execute callbacks */
  tools?: Record<string, ToolDefinition>;

  /** Max agent loop iterations (default: 10) */
  maxSteps?: number;

  /** System prompt (prepended as system message) */
  system?: string;

  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;

  /** Max output tokens */
  maxOutputTokens?: number;

  /** Temperature (0-1) */
  temperature?: number;

  // Callbacks (Vercel AI SDK compatible)
  onChunk?: (chunk: StreamEvent) => void | Promise<void>;
  onFinish?: (result: StreamTextFinishResult) => void | Promise<void>;
  onStepFinish?: (step: StepFinishResult) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}
```

### `StreamTextResult`

The result object provides multiple ways to consume the stream:

```typescript
interface StreamTextResult extends AsyncIterable<StreamEvent> {
  /** Full stream of all events */
  fullStream: AsyncIterable<StreamEvent>;

  /** Stream of text deltas only */
  textStream: AsyncIterable<string>;

  /** Promise resolving to full text */
  text: Promise<string>;

  /** Promise resolving to all tool calls */
  toolCalls: Promise<Array<{ toolCallId: string; toolName: string; args: unknown }>>;

  /** Promise resolving to all tool results */
  toolResults: Promise<Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }>>;

  /** Promise resolving to finish reason */
  finishReason: Promise<"stop" | "tool-calls" | "length" | "error">;

  /** Promise resolving to token usage */
  usage: Promise<{ promptTokens: number; completionTokens: number } | undefined>;

  /** Promise resolving to total steps */
  totalSteps: Promise<number>;
}
```

### `tool(input)`

Create a tool definition with Zod schema support:

```typescript
import { tool } from "@workspace/ai";
import { z } from "zod";

const myTool = tool({
  description: "Tool description",
  parameters: z.object({
    arg1: z.string().describe("First argument"),
    arg2: z.number().optional(),
  }),
  execute: async ({ arg1, arg2 }) => {
    return { result: arg1, count: arg2 ?? 0 };
  },
});
```

### `generateText(options)`

Non-streaming convenience wrapper:

```typescript
const { text, toolCalls, toolResults, usage, finishReason } = await generateText({
  model: "fast",
  messages: [{ role: "user", content: "Hello!" }],
});
```

### `getRoles()`

Get available model roles:

```typescript
const roles = await getRoles();
// roles.smart, roles.fast, roles.cheap, roles.coding
```

### `clearRoleCache()`

Clear cached role configuration:

```typescript
clearRoleCache();
```

## Stream Events

```typescript
type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "step-finish"; stepNumber: number; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "finish"; totalSteps: number; usage?: { promptTokens: number; completionTokens: number } }
  | { type: "error"; error: Error };
```

## Message Types

```typescript
// System message
{ role: "system", content: "You are a helpful assistant." }

// User message (string)
{ role: "user", content: "Hello!" }

// User message (with file)
{
  role: "user",
  content: [
    { type: "text", text: "What's in this image?" },
    { type: "file", mimeType: "image/png", data: uint8Array },
  ]
}

// Assistant message
{ role: "assistant", content: "Hello! How can I help?" }

// Assistant message with tool calls
{
  role: "assistant",
  content: [
    { type: "text", text: "Let me check." },
    { type: "tool-call", toolCallId: "abc", toolName: "weather", args: { city: "NYC" } },
  ]
}

// Tool result message
{
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "abc", toolName: "weather", result: { temp: 72 } },
  ]
}
```

## Claude Code Models

Claude Code models work identically to standard models:

```typescript
const result = streamText({
  model: "claude-code:sonnet", // or "claude-code:opus", "claude-code:haiku"
  messages: [{ role: "user", content: "What time is it?" }],
  tools: {
    get_time: tool({
      parameters: z.object({}),
      execute: async () => ({ time: new Date().toISOString() }),
    }),
  },
});
```

Your code doesn't need to know whether it's using Claude Code or a standard model.

## Complete Example

```typescript
import { streamText, tool, getRoles } from "@workspace/ai";
import { z } from "zod";

// Define tools
const tools = {
  get_time: tool({
    description: "Get current date and time",
    parameters: z.object({}),
    execute: async () => ({
      time: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  }),
  calculate: tool({
    description: "Evaluate a math expression",
    parameters: z.object({
      expression: z.string().describe("Math expression like '2 + 2'"),
    }),
    execute: async ({ expression }) => {
      const result = Function(`return (${expression})`)();
      return { expression, result };
    },
  }),
};

// Chat with callbacks
async function chat(userMessage: string) {
  const result = streamText({
    model: "fast",
    system: "You are a helpful assistant with access to tools.",
    messages: [{ role: "user", content: userMessage }],
    tools,
    maxSteps: 5,
    onChunk: (chunk) => {
      if (chunk.type === "text-delta") {
        process.stdout.write(chunk.text);
      }
    },
    onStepFinish: (step) => {
      if (step.toolCalls.length > 0) {
        console.log(`\n[Step ${step.stepNumber}: ${step.toolCalls.length} tool calls]`);
      }
    },
    onFinish: (result) => {
      console.log(`\n[Done: ${result.totalSteps} steps, ${result.usage?.completionTokens} tokens]`);
    },
  });

  // Wait for completion
  await result.text;
}

// Usage
await chat("What time is it?");
await chat("Calculate 15 * 23 + 7");
```

## Cancellation

```typescript
const controller = new AbortController();

const result = streamText({
  model: "fast",
  messages: [...],
  abortSignal: controller.signal,
});

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

try {
  for await (const event of result) { ... }
} catch (error) {
  if (error.name === "AbortError") {
    console.log("Cancelled");
  }
}
```

## Workers

The same API works in workers (and panels) via `@workspace/ai`:

```typescript
import { ai, tool } from "@workspace/ai";
// Identical API to panels
```

## Configuration

Model roles are configured in `~/.config/natstack/config.yml`:

```yaml
models:
  smart: anthropic:claude-sonnet-4-20250514
  fast: anthropic:claude-haiku-4-5-20251001
  cheap: anthropic:claude-haiku-4-5-20251001
  coding: claude-code:sonnet
```

API keys in `~/.config/natstack/.secrets.yml`:

```yaml
ANTHROPIC_API_KEY: sk-ant-...
OPENAI_API_KEY: sk-...
```

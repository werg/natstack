# AI Integration

Use `@workspace/runtime` for streaming text generation with tool calling.

## Simple Streaming

```tsx
import { ai } from "@workspace/runtime";

const stream = ai.streamText({
  model: "fast",
  system: "You are helpful.",
  messages: [{ role: "user", content: "Hello!" }],
});

for await (const event of stream) {
  if (event.type === "text-delta") {
    process.stdout.write(event.text);
  }
}
```

## Tool Calling

```tsx
import { ai } from "@workspace/runtime";
import { tool } from "@natstack/ai";
import { z } from "@workspace/runtime";

const tools = {
  get_time: tool({
    description: "Get current time",
    parameters: z.object({}),
    execute: async () => ({ time: new Date().toISOString() }),
  }),
  calculate: tool({
    description: "Evaluate math expression",
    parameters: z.object({
      expression: z.string().describe("Math expression like '2+2'"),
    }),
    execute: async ({ expression }) => ({
      result: new Function(`return (${expression})`)(),
    }),
  }),
};

const stream = ai.streamText({
  model: "fast",
  system: "Use tools when helpful.",
  messages,
  tools,
  maxSteps: 5,
});

for await (const event of stream) {
  switch (event.type) {
    case "text-delta":
      console.log(event.text);
      break;
    case "tool-call":
      console.log(`Calling ${event.toolName}:`, event.args);
      break;
    case "tool-result":
      console.log(`Result:`, event.result);
      break;
    case "finish":
      console.log(`Done in ${event.totalSteps} steps`);
      break;
  }
}
```

## Available Roles

```typescript
const roles = await ai.listRoles();
// { fast: { displayName: "...", modelId: "..." }, smart: {...}, ... }
```

## Browser Automation

Control browser panels with Playwright:

```typescript
import { chromium } from "playwright-core";
import { createBrowserChild } from "@workspace/runtime";

const browser = await createBrowserChild("https://example.com");
const cdpUrl = await browser.getCdpEndpoint();

const conn = await chromium.connectOverCDP(cdpUrl);
const page = conn.contexts()[0].pages()[0];

await page.click(".button");
await page.fill("input[name=search]", "query");
const text = await page.textContent(".result");

// Navigation
await browser.navigate("https://other.com");
await browser.goBack();
await browser.reload();
```

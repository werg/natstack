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

Control browser panels via Playwright over CDP. Browser automation is available in Electron mode only.

### Creating a Browser Panel

From panel code, use `window.open` with an external URL. The host intercepts this and creates a browser panel:

```typescript
// Opens a browser child panel navigated to the URL
window.open("https://example.com");
```

### Getting the CDP Endpoint

The browser panel's CDP endpoint is accessible via the `browser` RPC service. You need the browser panel's ID (returned as a child ID):

```typescript
import { rpc } from "@workspace/runtime";

// Get the CDP WebSocket endpoint for a browser panel
const cdpUrl = await rpc.call("main", "browser.getCdpEndpoint", browserId);
```

### Connecting Playwright

Once you have the CDP endpoint, connect Playwright:

```typescript
import { chromium } from "playwright-core";
import { rpc } from "@workspace/runtime";

// 1. Get CDP endpoint for the browser panel
const cdpUrl = await rpc.call("main", "browser.getCdpEndpoint", browserId);

// 2. Connect Playwright to the running browser
const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
const page = context.pages()[0];

// 3. Interact with the page
await page.click(".search-button");
await page.fill("input[name=query]", "NatStack");
await page.waitForSelector(".results");
const text = await page.textContent(".results .first");

// 4. Clean up
await browser.close();
```

### Browser Navigation via RPC

You can also control navigation directly via the `browser` RPC service:

```typescript
import { rpc } from "@workspace/runtime";

await rpc.call("main", "browser.navigate", browserId, "https://other-site.com");
await rpc.call("main", "browser.goBack", browserId);
await rpc.call("main", "browser.goForward", browserId);
await rpc.call("main", "browser.reload", browserId);
await rpc.call("main", "browser.stop", browserId);
```

### Browser Service Methods

| Method | Args | Description |
|--------|------|-------------|
| `browser.getCdpEndpoint` | `(browserId)` | Get CDP WebSocket URL |
| `browser.navigate` | `(browserId, url)` | Load a URL |
| `browser.goBack` | `(browserId)` | Navigate back |
| `browser.goForward` | `(browserId)` | Navigate forward |
| `browser.reload` | `(browserId)` | Reload page |
| `browser.stop` | `(browserId)` | Stop loading |

**Security:** Panels can only control browser panels they own. Calling `getCdpEndpoint` for a browser you don't own throws an access denied error.



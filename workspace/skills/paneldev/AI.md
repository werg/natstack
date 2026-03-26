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

Create and control browser panels via Playwright/CDP. Works in both Electron and headless (with extension) modes.

### Quick pattern

```typescript
import { createBrowserPanel, openExternal } from "@workspace/runtime";

// Create a browser panel and get a Playwright page
const handle = await createBrowserPanel("https://example.com", { focus: true });
const page = await handle.page();

// Interact
await page.fill("input[name=query]", "NatStack");
await page.click(".search-button");
const text = await page.evaluate(() =>
  document.querySelector(".results .first")?.textContent
);

// Navigate via handle (doesn't need Playwright)
await handle.navigate("https://other.com");
await handle.goBack();
await handle.reload();
await handle.close();

// Open in system browser (no automation)
await openExternal("https://docs.example.com");
```

### Fire-and-forget (window.open)

In Electron mode, `window.open("https://...")` also creates browser panels. Discover the child via event:

```typescript
import { onChildCreated, getBrowserHandle } from "@workspace/runtime";

onChildCreated(({ childId, url }) => {
  const handle = getBrowserHandle(childId);
  // handle.page(), handle.navigate(), etc.
});
window.open("https://example.com");
```

### BrowserHandle Methods

| Method | Description |
|--------|-------------|
| `page()` | Connect Playwright, return page for automation |
| `navigate(url)` | Load a URL |
| `goBack()` | Navigate back |
| `goForward()` | Navigate forward |
| `reload()` | Reload page |
| `stop()` | Stop loading |
| `close()` | Close browser panel |

**Security:** Panels can only control browser panels they own.



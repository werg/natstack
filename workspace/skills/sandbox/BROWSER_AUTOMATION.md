# Browser Automation

Automate browser panels with Playwright-style page control. Open a URL, get a page handle, and interact — click, fill forms, evaluate JS, take screenshots.

## REPL Scope: Open Once, Reuse Across Calls

The primary pattern: open a browser panel once, store the handle in `scope`, and reuse it across multiple eval calls.

```
// Call 1: Open browser panel once, store in scope
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";
  scope.browser = await createBrowserPanel("https://example.com");
  scope.page = await scope.browser.page();
  console.log("Opened:", await scope.page.title());
`, timeout: 30000 })

// Call 2: Reuse — no new panel, same page
eval({ code: `
  await scope.page.click("button.login");
  await scope.page.fill('input[name="email"]', "user@example.com");
  await scope.page.click('button[type="submit"]');
  await scope.page.waitForSelector(".dashboard");
  console.log("Logged in!");
`, timeout: 30000 })

// Call 3: Continue with same page
eval({ code: `
  scope.results = await scope.page.evaluate(() =>
    Array.from(document.querySelectorAll(".item")).map(el => el.textContent)
  );
  console.log("Scraped", scope.results.length, "items");
`, timeout: 30000 })
```

Two lines to get started:
1. `scope.browser = await createBrowserPanel(url)` — opens a browser panel, stores handle in scope
2. `scope.page = await scope.browser.page()` — connects Playwright via CDP, stores page in scope

All subsequent eval calls reuse `scope.page` directly — no re-creation needed.

## Reconnection After Panel Reload

On panel reload, `scope.browser.id` survives serialization (it's a string) even though methods like `scope.browser.page` and `scope.browser.navigate` are lost (functions aren't serializable). Reconnect using the surviving ID:

```
eval({ code: `
  import { getBrowserHandle } from "@workspace/runtime";
  scope.browser = getBrowserHandle(scope.browser.id);  // id survived serialization
  scope.page = await scope.browser.page();
  console.log("Reconnected:", await scope.page.title());
`, timeout: 30000 })
```

No need for a separate `scope.browserId` — per-property serialization means `scope.browser.id` and `scope.browser.title` survive even though the methods are lost.

## Page API Reference

```typescript
scope.browser = await createBrowserPanel("https://example.com");
scope.page = await scope.browser.page();
```

### Navigation

```typescript
await scope.page.goto(url)                              // navigate (waits for load)
await scope.page.goto(url, { waitUntil: "networkidle" }) // wait for network quiet
await scope.page.goto(url, { waitUntil: "domcontentloaded" })
await scope.page.goto(url, { timeout: 10000 })          // custom timeout
scope.page.url()                                         // current URL (sync)
await scope.page.title()                                 // page title
await scope.page.content()                               // full HTML source
```

### Interaction

```typescript
await scope.page.click("button.submit")
await scope.page.fill('input[name="email"]', "user@example.com")
await scope.page.type('input[name="search"]', "query")  // types character by character
```

### DOM Queries

```typescript
await scope.page.waitForSelector(".loaded")              // wait for element to appear
await scope.page.waitForSelector(".modal", { timeout: 5000 })
await scope.page.querySelector(".result")                // check if element exists
```

### Evaluate JavaScript in Page

The most powerful method — run arbitrary JS in the page context:

```typescript
// Get text content
const text = await scope.page.evaluate(() => document.querySelector("h1")?.textContent);

// Get multiple elements
const items = await scope.page.evaluate(() =>
  Array.from(document.querySelectorAll(".item")).map(el => ({
    title: el.querySelector("h3")?.textContent,
    href: el.querySelector("a")?.getAttribute("href"),
  }))
);

// Pass arguments
const text = await scope.page.evaluate(
  (sel) => document.querySelector(sel)?.textContent,
  ".my-class"
);

// Interact with the page
await scope.page.evaluate(() => {
  document.querySelector("form")?.submit();
});
```

### Screenshots

```typescript
const screenshot = await scope.page.screenshot();                    // PNG Uint8Array
const full = await scope.page.screenshot({ fullPage: true });
const jpeg = await scope.page.screenshot({ format: "jpeg", quality: 80 });
```

### Close

```typescript
await scope.page.close()      // close the page
await scope.browser.close()   // close the browser panel
```

### BrowserHandle Methods

The handle also has direct navigation methods (no Playwright needed):

| Method | Description |
|--------|-------------|
| `handle.page()` | Connect Playwright, return page |
| `handle.navigate(url)` | Load a URL |
| `handle.goBack()` | Navigate back |
| `handle.goForward()` | Navigate forward |
| `handle.reload()` | Reload page |
| `handle.stop()` | Stop loading |
| `handle.close()` | Close browser panel |

## Examples

### Multi-Step Workflow: Scrape + Process

```
// Step 1: Open and navigate
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";
  scope.browser = await createBrowserPanel("https://news.ycombinator.com");
  scope.page = await scope.browser.page();
  console.log("Opened HN");
`, timeout: 30000 })

// Step 2: Scrape data
eval({ code: `
  scope.stories = await scope.page.evaluate(() =>
    Array.from(document.querySelectorAll(".titleline > a")).map(el => ({
      title: el.textContent,
      href: el.getAttribute("href"),
    }))
  );
  console.log("Scraped", scope.stories.length, "stories");
`, timeout: 30000 })

// Step 3: Process results (scope.stories persists!)
eval({ code: `
  const top5 = scope.stories.slice(0, 5);
  console.log("Top 5:", JSON.stringify(top5, null, 2));
  return top5;
`, timeout: 10000 })
```

### Login Flow Across Multiple Calls

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";
  scope.browser = await createBrowserPanel("https://example.com/login");
  scope.page = await scope.browser.page();
`, timeout: 30000 })

eval({ code: `
  await scope.page.fill('input[name="email"]', 'user@example.com');
  await scope.page.fill('input[name="password"]', 'secret');
  await scope.page.click('button[type="submit"]');
  await scope.page.waitForSelector(".dashboard");
  console.log("Logged in, now at:", scope.page.url());
`, timeout: 30000 })

eval({ code: `
  // Still logged in — same page, same session
  scope.dashboardData = await scope.page.evaluate(() =>
    document.querySelector(".stats")?.textContent
  );
  console.log("Dashboard:", scope.dashboardData);
`, timeout: 30000 })
```

### Combined: Import Cookies + Authenticate

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";
  import { browserData } from "@workspace/panel-browser";

  // Step 1: Import cookies from Chrome
  const browsers = await browserData.detectBrowsers();
  const chrome = browsers.find(b => b.name === "chrome");
  if (chrome) {
    await browserData.startImport({
      browser: "chrome",
      profile: chrome.profiles[0] ?? chrome.dataDir,
      dataTypes: ["cookies"],
    });
    console.log("Cookies imported and synced to browser session");
  }

  // Step 2: Open browser — now has imported cookies
  scope.browser = await createBrowserPanel("https://github.com");
  scope.page = await scope.browser.page();

  const title = await scope.page.title();
  console.log("Page title:", title);

  // Check if logged in
  const isLoggedIn = await scope.page.evaluate(() =>
    document.querySelector("img.avatar") !== null
  );
  console.log(isLoggedIn ? "Logged in!" : "Not logged in");
`, timeout: 60000 })
```

### Inline UI: Browser Control Panel

> **Defensive coding:** This example uses `props.startUrl`. Always default: `const startUrl = props?.startUrl ?? "https://example.com"` to handle cases where the caller omits the prop.

```
inline_ui({
  code: `
import { useState, useRef } from "react";
import { Button, Flex, Text, TextField, Box, Badge } from "@radix-ui/themes";
import { createBrowserPanel } from "@workspace/runtime";

export default function BrowserController({ props, chat }) {
  const [url, setUrl] = useState(props.startUrl || "https://example.com");
  const [status, setStatus] = useState("disconnected");
  const [pageTitle, setPageTitle] = useState("");
  const handleRef = useRef(null);
  const pageRef = useRef(null);

  const handleConnect = async () => {
    setStatus("connecting...");
    const handle = await createBrowserPanel(url);
    handleRef.current = handle;
    const page = await handle.page();
    pageRef.current = page;
    setStatus("connected");
    setPageTitle(await page.title());
  };

  const handleNavigate = async () => {
    if (!pageRef.current) return;
    await pageRef.current.goto(url);
    setPageTitle(await pageRef.current.title());
  };

  const handleScrape = async () => {
    if (!pageRef.current) return;
    const text = await pageRef.current.evaluate(() => document.body.innerText);
    chat.publish("message", { content: "Page text (" + text.length + " chars):\\n" + text.slice(0, 500) });
  };

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2" align="center">
        <TextField.Root value={url} onChange={e => setUrl(e.target.value)} style={{ flex: 1 }} />
        {status === "disconnected"
          ? <Button size="1" onClick={handleConnect}>Open</Button>
          : <Button size="1" onClick={handleNavigate}>Go</Button>}
        <Button size="1" variant="soft" onClick={handleScrape} disabled={!pageRef.current}>Scrape</Button>
      </Flex>
      <Flex gap="2" align="center">
        <Badge color={status === "connected" ? "green" : "gray"}>{status}</Badge>
        {pageTitle && <Text size="1" color="gray">{pageTitle}</Text>}
      </Flex>
    </Flex>
  );
}`,
  props: { startUrl: "https://example.com" }
})
```

## Tips

- **Use `scope` for all browser handles and pages** — they persist across eval calls, so you don't need to re-create them.
- **Use `page.evaluate()` for complex DOM queries** — it's more reliable than individual selector methods and gives you full DOM API access.
- **Use `page.goto(url, { waitUntil: "networkidle" })` for SPAs** — waits for AJAX requests to finish.
- **Use `page.waitForSelector()` before interacting** — ensures elements exist before clicking/filling.
- **Pass `timeout: 60000` for slow pages** — the default eval timeout may be too short for pages that load slowly.
- **Imported cookies are auto-synced** — if you imported browser data via the browser-import skill, browser panels will have those cookies available automatically.
- **After reload, reconnect via `scope.browser.id`** — the ID survives serialization, so you can reconnect without re-opening the panel.

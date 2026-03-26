# Browser Automation

Automate browser panels with Playwright-style page control. Open a URL, get a page handle, and interact — click, fill forms, evaluate JS, take screenshots.

## Quick Start

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";

  const handle = await createBrowserPanel("https://example.com");
  const page = await handle.page();

  const title = await page.title();
  console.log("Title:", title);

  const heading = await page.evaluate(() => document.querySelector("h1")?.textContent);
  console.log("H1:", heading);
`, timeout: 30000 })
```

Two lines to get a controllable page:
1. `createBrowserPanel(url)` — opens a browser panel, returns a `BrowserHandle`
2. `handle.page()` — connects Playwright via CDP, returns a `Page`

## Page API Reference

```typescript
const handle = await createBrowserPanel("https://example.com");
const page = await handle.page();
```

### Navigation

```typescript
await page.goto(url)                              // navigate (waits for load)
await page.goto(url, { waitUntil: "networkidle" }) // wait for network quiet
await page.goto(url, { waitUntil: "domcontentloaded" })
await page.goto(url, { timeout: 10000 })          // custom timeout
page.url()                                         // current URL (sync)
await page.title()                                 // page title
await page.content()                               // full HTML source
```

### Interaction

```typescript
await page.click("button.submit")
await page.fill('input[name="email"]', "user@example.com")
await page.type('input[name="search"]', "query")  // types character by character
```

### DOM Queries

```typescript
await page.waitForSelector(".loaded")              // wait for element to appear
await page.waitForSelector(".modal", { timeout: 5000 })
await page.querySelector(".result")                // check if element exists
```

### Evaluate JavaScript in Page

The most powerful method — run arbitrary JS in the page context:

```typescript
// Get text content
const text = await page.evaluate(() => document.querySelector("h1")?.textContent);

// Get multiple elements
const items = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".item")).map(el => ({
    title: el.querySelector("h3")?.textContent,
    href: el.querySelector("a")?.getAttribute("href"),
  }))
);

// Pass arguments
const text = await page.evaluate(
  (sel) => document.querySelector(sel)?.textContent,
  ".my-class"
);

// Interact with the page
await page.evaluate(() => {
  document.querySelector("form")?.submit();
});
```

### Screenshots

```typescript
const screenshot = await page.screenshot();                    // PNG Uint8Array
const full = await page.screenshot({ fullPage: true });
const jpeg = await page.screenshot({ format: "jpeg", quality: 80 });
```

### Close

```typescript
await page.close()    // close the page
await handle.close()  // close the browser panel
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

### Scrape a Page

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";

  const handle = await createBrowserPanel("https://news.ycombinator.com");
  const page = await handle.page();

  await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded" });
  const titles = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".titleline > a")).map(el => ({
      title: el.textContent,
      href: el.getAttribute("href"),
    }))
  );
  console.log("Top stories:", JSON.stringify(titles.slice(0, 5), null, 2));
  return titles;
`, timeout: 30000 })
```

### Fill and Submit a Form

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";

  const handle = await createBrowserPanel("https://example.com/login");
  const page = await handle.page();

  await page.fill('input[name="email"]', 'user@example.com');
  await page.fill('input[name="password"]', 'secret');
  await page.click('button[type="submit"]');

  // Wait for navigation to complete
  await page.waitForSelector(".dashboard");
  console.log("Logged in, now at:", page.url());
`, timeout: 30000 })
```

### Take a Screenshot

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";

  const handle = await createBrowserPanel("https://example.com");
  const page = await handle.page();

  const screenshot = await page.screenshot({ fullPage: true });
  console.log("Screenshot taken:", screenshot.length, "bytes");
  return screenshot;
`, timeout: 30000 })
```

### Inline UI: Browser Control Panel

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
  const handle = await createBrowserPanel("https://github.com");
  const page = await handle.page();

  const title = await page.title();
  console.log("Page title:", title);

  // Check if logged in
  const isLoggedIn = await page.evaluate(() =>
    document.querySelector("img.avatar") !== null
  );
  console.log(isLoggedIn ? "Logged in!" : "Not logged in");
`, timeout: 60000 })
```

## Tips

- **Use `page.evaluate()` for complex DOM queries** — it's more reliable than individual selector methods and gives you full DOM API access.
- **Use `page.goto(url, { waitUntil: "networkidle" })` for SPAs** — waits for AJAX requests to finish.
- **Use `page.waitForSelector()` before interacting** — ensures elements exist before clicking/filling.
- **Pass `timeout: 60000` for slow pages** — the default eval timeout may be too short for pages that load slowly.
- **Imported cookies are auto-synced** — if you imported browser data via the browser-import skill, browser panels will have those cookies available automatically.

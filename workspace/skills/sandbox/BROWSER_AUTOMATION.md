# Browser Automation

Full Playwright-based browser automation via `@workspace/playwright-client`. Open browser panels, connect via CDP, and control pages programmatically — navigate, query DOM, take screenshots, fill forms, click elements.

## Setup

```typescript
import { createBrowserPanel } from "@workspace/runtime";
import { connect } from "@workspace/playwright-client";
```

1. **Open a browser panel** — `createBrowserPanel(url)` returns a `BrowserHandle`
2. **Get the CDP endpoint** — `handle.getCdpEndpoint()` returns a WebSocket URL
3. **Connect Playwright** — `connect(wsEndpoint, "chromium", {})` returns a `Browser`
4. **Use the Playwright API** — pages, locators, screenshots, etc.

## Quick Start (Eval)

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";
  import { connect } from "@workspace/playwright-client";

  // Open a browser panel
  const handle = await createBrowserPanel("https://example.com");
  const wsEndpoint = await handle.getCdpEndpoint();

  // Connect Playwright
  const browser = await connect(wsEndpoint, "chromium", {});
  const contexts = browser.contexts();
  const page = contexts[0]?.pages()[0];

  if (page) {
    // Get page title
    const title = await page.title();
    console.log("Title:", title);

    // Get page content
    const text = await page.locator("h1").textContent();
    console.log("H1:", text);
  }
`, timeout: 30000 })
```

## Playwright API Reference

### Browser

```typescript
const browser = await connect(wsEndpoint, "chromium", {});
browser.contexts()              // BrowserContext[]
browser.isConnected()           // boolean
browser.close()                 // Promise<void>
```

### BrowserContext

```typescript
const context = browser.contexts()[0];
context.pages()                 // Page[]
context.newPage()               // Promise<Page>
context.cookies(urls?)          // Promise<Cookie[]>
context.addCookies(cookies)     // Promise<void>
context.clearCookies()          // Promise<void>
context.close()                 // Promise<void>
```

### Page

```typescript
const page = context.pages()[0];

// Navigation
page.goto(url, options?)        // Promise<Response | null>
page.goBack(options?)           // Promise<Response | null>
page.goForward(options?)        // Promise<Response | null>
page.reload(options?)           // Promise<Response | null>
page.url()                      // string
page.title()                    // Promise<string>

// Content
page.content()                  // Promise<string> — full HTML
page.textContent(selector)      // Promise<string | null>
page.innerHTML(selector)        // Promise<string>

// Screenshots
page.screenshot(options?)       // Promise<Buffer>
// options: { path?, fullPage?, clip?, type?: "png"|"jpeg", quality? }

// Interaction
page.click(selector, options?)
page.fill(selector, value)
page.type(selector, text, options?)
page.press(selector, key)
page.check(selector)
page.uncheck(selector)
page.selectOption(selector, values)
page.hover(selector)

// Waiting
page.waitForSelector(selector, options?)
page.waitForURL(url, options?)
page.waitForLoadState(state?)    // "load" | "domcontentloaded" | "networkidle"
page.waitForTimeout(ms)

// Evaluation
page.evaluate(fn, arg?)         // Promise<T> — run JS in page context
page.evaluateHandle(fn, arg?)   // Promise<JSHandle>

// Locators (recommended over raw selectors)
page.locator(selector)          // Locator
page.getByText(text)            // Locator
page.getByRole(role, options?)  // Locator
page.getByLabel(text)           // Locator
page.getByPlaceholder(text)     // Locator
page.getByTestId(testId)        // Locator

// Events
page.on("response", handler)
page.on("request", handler)
page.on("console", handler)
page.on("dialog", handler)
```

### Locator

```typescript
const loc = page.locator("button.submit");

loc.click(options?)
loc.fill(value)
loc.textContent()               // Promise<string | null>
loc.innerText()                 // Promise<string>
loc.innerHTML()                 // Promise<string>
loc.getAttribute(name)          // Promise<string | null>
loc.isVisible()                 // Promise<boolean>
loc.isEnabled()                 // Promise<boolean>
loc.count()                     // Promise<number>
loc.first()                     // Locator
loc.last()                      // Locator
loc.nth(index)                  // Locator
loc.filter(options)             // Locator — { hasText?, has? }
loc.screenshot(options?)        // Promise<Buffer>
loc.waitFor(options?)           // Promise<void>
```

## Examples

### Scrape a Page

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";
  import { connect } from "@workspace/playwright-client";

  const handle = await createBrowserPanel("https://news.ycombinator.com");
  const browser = await connect(await handle.getCdpEndpoint(), "chromium", {});
  const page = browser.contexts()[0]?.pages()[0];

  if (page) {
    await page.waitForLoadState("domcontentloaded");
    const titles = await page.locator(".titleline > a").evaluateAll(
      els => els.map(el => ({ title: el.textContent, href: el.href }))
    );
    console.log("Top stories:", JSON.stringify(titles.slice(0, 5), null, 2));
    return titles;
  }
`, timeout: 30000 })
```

### Fill and Submit a Form

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";
  import { connect } from "@workspace/playwright-client";

  const handle = await createBrowserPanel("https://example.com/login");
  const browser = await connect(await handle.getCdpEndpoint(), "chromium", {});
  const page = browser.contexts()[0]?.pages()[0];

  if (page) {
    await page.waitForLoadState("networkidle");
    await page.fill('input[name="email"]', 'user@example.com');
    await page.fill('input[name="password"]', 'secret');
    await page.click('button[type="submit"]');
    await page.waitForURL("**/dashboard**");
    console.log("Logged in, now at:", page.url());
  }
`, timeout: 30000 })
```

### Take a Screenshot

```
eval({ code: `
  import { createBrowserPanel, fs } from "@workspace/runtime";
  import { connect } from "@workspace/playwright-client";

  const handle = await createBrowserPanel("https://example.com");
  const browser = await connect(await handle.getCdpEndpoint(), "chromium", {});
  const page = browser.contexts()[0]?.pages()[0];

  if (page) {
    await page.waitForLoadState("networkidle");
    const screenshot = await page.screenshot({ fullPage: true });
    await fs.writeFile("/tmp/screenshot.png", screenshot);
    console.log("Screenshot saved to /tmp/screenshot.png");
  }
`, timeout: 30000 })
```

### Inline UI: Browser Control Panel

```
inline_ui({
  code: `
import { useState, useRef } from "react";
import { Button, Flex, Text, TextField, Box, Badge } from "@radix-ui/themes";
import { createBrowserPanel } from "@workspace/runtime";
import { connect } from "@workspace/playwright-client";

export default function BrowserController({ props, chat }) {
  const [url, setUrl] = useState(props.startUrl || "https://example.com");
  const [status, setStatus] = useState("disconnected");
  const [pageTitle, setPageTitle] = useState("");
  const browserRef = useRef(null);
  const pageRef = useRef(null);

  const handleConnect = async () => {
    setStatus("connecting...");
    const handle = await createBrowserPanel(url);
    const wsEndpoint = await handle.getCdpEndpoint();
    const browser = await connect(wsEndpoint, "chromium", {});
    browserRef.current = browser;
    const page = browser.contexts()[0]?.pages()[0];
    pageRef.current = page;
    setStatus("connected");
    if (page) setPageTitle(await page.title());
  };

  const handleNavigate = async () => {
    if (!pageRef.current) return;
    await pageRef.current.goto(url);
    setPageTitle(await pageRef.current.title());
  };

  const handleScrape = async () => {
    if (!pageRef.current) return;
    const text = await pageRef.current.locator("body").innerText();
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
  import { createBrowserPanel, rpc } from "@workspace/runtime";
  import { connect } from "@workspace/playwright-client";
  import { createBrowserDataApi } from "@workspace/panel-browser";

  // Step 1: Import cookies from Chrome
  const browserData = createBrowserDataApi(rpc);
  const browsers = await browserData.detectBrowsers();
  const chrome = browsers.find(b => b.name === "chrome");
  if (chrome) {
    await browserData.startImport({
      browser: "chrome",
      profilePath: chrome.profiles[0]?.path ?? chrome.dataDir,
      dataTypes: ["cookies"],
    });
    // Sync to browser session
    await browserData.syncCookiesToSession("github.com");
    console.log("Cookies synced");
  }

  // Step 2: Open browser — now has GitHub cookies
  const handle = await createBrowserPanel("https://github.com");
  const browser = await connect(await handle.getCdpEndpoint(), "chromium", {});
  const page = browser.contexts()[0]?.pages()[0];

  if (page) {
    await page.waitForLoadState("networkidle");
    const title = await page.title();
    console.log("Page title:", title);
    // Check if logged in
    const avatar = await page.locator('img.avatar').count();
    console.log(avatar > 0 ? "Logged in!" : "Not logged in");
  }
`, timeout: 60000 })
```

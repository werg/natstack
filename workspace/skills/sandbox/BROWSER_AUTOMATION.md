# CDP Panel Automation

Automate panels with Playwright-style CDP page control. Open a URL or target an existing panel, get a page handle, and interact — click, fill forms, evaluate JS, take screenshots.

## REPL Scope: Open Once, Reuse Across Calls

The primary pattern: open a browser panel once, store the handle in `scope`, and reuse it across multiple eval calls.

```
// Call 1: Open browser panel once, store in scope
eval({ code: `
  import { openPanel } from "@workspace/runtime";
  scope.browser = await openPanel("https://example.com");
  scope.page = await scope.browser.cdp.lightweightPage();
  console.log("Opened:", await scope.page.title());
`
})

// Call 2: Reuse — no new panel, same page
eval({ code: `
  await scope.page.click("button.login");
  await scope.page.fill('input[name="email"]', "user@example.com");
  await scope.page.click('button[type="submit"]');
  await scope.page.waitForSelector(".dashboard");
  console.log("Logged in!");
`
})

// Call 3: Continue with same page
eval({ code: `
  scope.results = await scope.page.evaluate(() =>
    Array.from(document.querySelectorAll(".item")).map(el => el.textContent)
  );
  console.log("Scraped", scope.results.length, "items");
`
})
```

Two lines to get started:

1. `scope.browser = await openPanel(url)` — opens a browser panel, stores handle in scope; may prompt on first structural use
2. `scope.page = await scope.browser.cdp.lightweightPage()` — connects the lightweight CDP client, stores page in scope

All subsequent eval calls reuse `scope.page` directly — no re-creation needed.
Do not call `openPanel()` or `handle.cdp.lightweightPage()` repeatedly for the
same target. Repeated opens create duplicate panels; repeated CDP client calls
create duplicate CDP connections.

## Cleanup Ownership

Agents own the panels they open. For temporary browser panels used for
diagnostics, scraping, setup, or tests, close the panel when finished:

```ts
import { openPanel } from "@workspace/runtime";

let browser;
try {
  browser = await openPanel("https://example.com", { focus: true });
  const page = await browser.cdp.lightweightPage();
  await page.waitForSelector("body");
  scope.result = await page.title();
} finally {
  await browser?.close().catch((err) => console.warn("panel cleanup failed", err));
}
```

Keep a panel open only when the user explicitly asked to inspect it or continue
using it, or the workflow explicitly needs it across follow-up calls. If a
workflow spans multiple eval calls, store one handle in `scope` and close it in
a final cleanup call when the workflow is done:

```ts
await scope.browser?.close();
delete scope.browser;
delete scope.page;
```

When a page or browser object exposes its own `close()` method, call it before
closing the panel. The reliable cleanup primitive is still `handle.close()`,
because it tears down the panel and its associated CDP target. Do not leave
throwaway `about:blank`, URL, or diagnostic panels behind.

## Reconnection After Panel Reload

On panel reload, `scope.browser.id` survives serialization (it's a string) even though handle methods like `scope.browser.cdp.lightweightPage` and `scope.browser.cdp.navigate` are lost (functions aren't serializable). Reconnect using the surviving ID:

```
eval({ code: `
  import { getPanelHandle } from "@workspace/runtime";
  scope.browser = getPanelHandle(scope.browser.id);  // id survived serialization
  scope.page = await scope.browser.cdp.lightweightPage();
  console.log("Reconnected:", await scope.page.title());
`
})
```

No need for a separate `scope.browserId` — per-property serialization means `scope.browser.id` and `scope.browser.title` survive even though the methods are lost.

## Page API Reference

```typescript
scope.browser = await openPanel("https://example.com");
scope.page = await scope.browser.cdp.lightweightPage();
```

Choose one named CDP client explicitly:

- `await handle.cdp.lightweightPage()` loads the standalone
  `@workspace/cdp-client` internally. Use this as the default for eval
  diagnostics and simple panel inspection; do not import the CDP client package
  directly.
- `await playwrightPage(handle)` from `@workspace/playwright-automation` loads
  vendored full Playwright through `@workspace/playwright-core`. It is a heavy
  opt-in client. Use it for UI tests, browser workflows, login flows, and tasks
  that need its fuller locator/wait surface.

There is no runtime compatibility shim and no silent fallback between clients.
Inline eval snippets that use full Playwright should pass
`imports: { "@workspace/playwright-automation": "latest" }`; source-file code
should declare the package dependency. Deliberately switch to
`handle.cdp.lightweightPage()` only when the smaller API is sufficient. There
is no `handle.cdp.page()` alias.

API scope:

| Client          | Entry point                                                      | Scope                                                                                                                                                                                              | Use when                                                                               |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Lightweight CDP | `handle.cdp.lightweightPage()`                                   | Small CDP wrapper for basic `goto`, `click`, `fill`, `evaluate`, `waitForSelector`, `screenshot`, console event capture, DOM `inspect(selector)`, and simple locator helpers                       | Default eval diagnostics and intentionally constrained contexts                        |
| Full Playwright | `playwrightPage(handle)` from `@workspace/playwright-automation` | Fuller Playwright-style page/locator surface: `url`, `title`, `goto`, `locator`, locator `click/fill/innerText/textContent/count`, `waitForSelector`, `waitForLoadState`, `evaluate`, `screenshot` | UI tests, browser workflows, login flows, anything where robust selectors/waits matter |

Historical console diagnostics are not a CDP page feature. CDP console events
only include messages after the client connects. For "something already went
wrong in this panel" debugging, use the host-captured history:

```ts
const history = await handle.cdp.consoleHistory({ limit: 200, errorLimit: 100 });
console.log(history.errors.map((entry) => entry.message));
console.log(history.dropped); // visible overflow counts, not silent truncation
```

`history.entries` is the recent general console buffer. `history.errors` is a
separate error-only buffer so noisy normal logs do not evict historical errors.
Each entry includes `timestamp`, `level`, `message`, `line`, `sourceId`, and
`url`. Use `page.consoleEvents()` on the lightweight page only for live events
captured after the CDP connection is established.

For broad post-mortem panel debugging, prefer the unified bundle:

```ts
const diagnostics = await handle.diagnostics({ limit: 200, errorLimit: 100 });
console.log(diagnostics.info);
console.log(diagnostics.consoleHistory.errors);
```

The same historical capture includes renderer lifecycle failures such as
`render-process-gone`, failed main-frame loads, and unresponsive renderer
events.

Do not import full Playwright in panel code just to inspect or automate a panel.
Use `await handle.cdp.lightweightPage()` for routine inspection, or import
`playwrightPage` from `@workspace/playwright-automation` only when the fuller
client is needed.

`page.url()` follows the Playwright shape. Use
`await scope.page.evaluate(() => location.href)` only when you need the page to
compute a URL after client-side routing. Panel handles expose target RPC under
`.call` and automation under `.cdp`; `handle.click(selector)` is a Playwright
convenience wrapper for `handle.cdp.click(selector)`.
Use `await parent.getInfo()` for handle metadata; top-level runtime `getInfo()`
describes the current runtime, not arbitrary handles.

### Navigation

```typescript
await scope.page.goto(url); // navigate (waits for load)
await scope.page.goto(url, { waitUntil: "networkidle" }); // wait for network quiet
await scope.page.goto(url, { waitUntil: "domcontentloaded" });
await scope.page.goto(url);
await scope.page.evaluate(() => location.href); // current URL
await scope.page.title(); // page title
await scope.page.content(); // full HTML source
```

### Interaction

```typescript
await scope.page.click("button.submit");
await scope.page.fill('input[name="email"]', "user@example.com");
await scope.page.type('input[name="search"]', "query"); // types character by character
```

### DOM Queries

```typescript
await scope.page.waitForSelector(".loaded"); // wait for element to appear
await scope.page.waitForSelector(".modal");
await scope.page.querySelector(".result"); // check if element exists
await scope.page.locator(".result").count(); // count matches
await scope.page.locator(".result").innerText(); // visible text
await scope.page.locator(".result").textContent(); // raw text content
await scope.page.waitForLoadState("networkidle"); // wait for load lifecycle
```

### Evaluate JavaScript in Page

The most powerful method — run arbitrary JS in the page context:

```typescript
// Get text content
const text = await scope.page.evaluate(() => document.querySelector("h1")?.textContent);

// Get multiple elements
const items = await scope.page.evaluate(() =>
  Array.from(document.querySelectorAll(".item")).map((el) => ({
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
const screenshot = await scope.page.screenshot(); // PNG Uint8Array
const full = await scope.page.screenshot({ fullPage: true });
const jpeg = await scope.page.screenshot({ format: "jpeg", quality: 80 });
```

### Close

```typescript
await scope.page.close?.(); // close the CDP page/client if available
await scope.browser.close(); // close the browser panel
```

### PanelHandle Methods

The handle also has direct navigation methods (no Playwright needed):

| Method                                             | Description                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `playwrightPage(handle)`                           | Load full Playwright CDP client and return the page                      |
| `handle.cdp.lightweightPage()`                     | Load the smaller CDP wrapper and return the page                         |
| `handle.cdp.consoleHistory({ limit, errorLimit })` | Read host-captured historical console logs and the separate error buffer |
| `handle.click(selector)`                           | Convenience wrapper for `handle.cdp.click(selector)`                     |
| `handle.cdp.navigate(url)`                         | Load a URL                                                               |
| `handle.cdp.goBack()`                              | Navigate back                                                            |
| `handle.cdp.goForward()`                           | Navigate forward                                                         |
| `handle.cdp.reload()`                              | Reload page                                                              |
| `handle.cdp.stop()`                                | Stop loading                                                             |
| `handle.close()`                                   | Close browser panel                                                      |

## Examples

### Multi-Step Workflow: Scrape + Process

```
// Step 1: Open and navigate
eval({ code: `
  import { openPanel } from "@workspace/runtime";
  scope.browser = await openPanel("https://news.ycombinator.com");
  scope.page = await scope.browser.cdp.lightweightPage();
  console.log("Opened HN");
`
})

// Step 2: Scrape data
eval({ code: `
  scope.stories = await scope.page.evaluate(() =>
    Array.from(document.querySelectorAll(".titleline > a")).map(el => ({
      title: el.textContent,
      href: el.getAttribute("href"),
    }))
  );
  console.log("Scraped", scope.stories.length, "stories");
`
})

// Step 3: Process results (scope.stories persists!)
eval({ code: `
  const top5 = scope.stories.slice(0, 5);
  console.log("Top 5:", JSON.stringify(top5, null, 2));
  return top5;
`
})
```

### Login Flow Across Multiple Calls

```
eval({ code: `
  import { openPanel } from "@workspace/runtime";
  scope.browser = await openPanel("https://example.com/login");
  scope.page = await scope.browser.cdp.lightweightPage();
`
})

eval({ code: `
  await scope.page.fill('input[name="email"]', 'user@example.com');
  await scope.page.fill('input[name="password"]', 'secret');
  await scope.page.click('button[type="submit"]');
  await scope.page.waitForSelector(".dashboard");
  console.log("Logged in, now at:", await scope.page.evaluate(() => location.href));
`
})

eval({ code: `
  // Still logged in — same page, same session
  scope.dashboardData = await scope.page.evaluate(() =>
    document.querySelector(".stats")?.textContent
  );
  console.log("Dashboard:", scope.dashboardData);
`
})
```

### Combined: Import Cookies + Authenticate

```
eval({ code: `
  import { openPanel } from "@workspace/runtime";
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
  scope.browser = await openPanel("https://github.com");
  scope.page = await scope.browser.cdp.lightweightPage();

  const title = await scope.page.title();
  console.log("Page title:", title);

  // Check if logged in
  const isLoggedIn = await scope.page.evaluate(() =>
    document.querySelector("img.avatar") !== null
  );
  console.log(isLoggedIn ? "Logged in!" : "Not logged in");
`
})
```

### Inline UI: Browser Control Panel

> **Defensive coding:** This example uses `props.startUrl`. Always default: `const startUrl = props?.startUrl ?? "https://example.com"` to handle cases where the caller omits the prop.

```
inline_ui({
  code: `
import { useState, useRef } from "react";
import { Button, Flex, Text, TextField, Box, Badge } from "@radix-ui/themes";
import { openPanel } from "@workspace/runtime";

export default function BrowserController({ props, chat }) {
  const [url, setUrl] = useState(props.startUrl || "https://example.com");
  const [status, setStatus] = useState("disconnected");
  const [pageTitle, setPageTitle] = useState("");
  const handleRef = useRef(null);
  const pageRef = useRef(null);

  const handleConnect = async () => {
    setStatus("connecting...");
    const handle = await openPanel(url);
    handleRef.current = handle;
    const page = await handle.cdp.lightweightPage();
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
    await chat.send("Page text (" + text.length + " chars):\\n" + text.slice(0, 500));
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
- **Wait on the page condition you need** — eval waits for the automation code to complete, so prefer explicit page state checks over wall-clock limits.
- **Imported cookies are auto-synced** — if you imported browser data via the browser-import skill, browser panels will have those cookies available automatically.
- **After reload, reconnect via `scope.browser.id`** — the ID survives serialization, so you can reconnect without re-opening the panel.

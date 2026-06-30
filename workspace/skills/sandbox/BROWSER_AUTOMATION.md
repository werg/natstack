# CDP Panel Automation

Automate panels with Playwright-style CDP page control. For web browsing or
website automation, open or reuse a dedicated browser panel. Existing workspace
panels, including chat panels, are application surfaces: inspect them when
debugging that app, but do not use them as disposable web pages.

> **Where this runs.** `openPanel`, `panelTree`, and `getPanelHandle` are part
> of the portable runtime surface from `@workspace/runtime`; they work from
> server-side eval, panels, workers, and DOs. The lightweight CDP client is
> workerd-native and runs over a WebSocket to the panel's CDP endpoint, so a
> browser panel opened from eval can be driven there directly. The "Inline UI:
> Browser Control Panel" example below shows the panel/component
> shape; the `eval` snippets show the same page API. (`browserData` from
> `@workspace/panel-browser` is shell-only and not reachable from server-side
> eval.)

## Open Once, Reuse Across Calls (component refs)

The primary pattern: open a browser panel once, hold the handle/page (e.g. in a
component `useRef`/`useState`), and reuse it across interactions — do not
re-open or re-connect for the same target.

```tsx
// Open browser panel once, hold the handle
const handle = await openPanel("https://example.com");
const page = await handle.cdp.lightweightPage();
console.log("Opened:", await page.title());

// Reuse — no new panel, same page
await page.getByRole("button", { name: "Sign in" }).click();
await page.getByLabel("Email").fill("user@example.com");
await page.getByRole("button", { name: "Submit" }).click();
await page.waitForSelector(".dashboard");

const results = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".item")).map((el) => el.textContent)
);
console.log("Scraped", results.length, "items");
```

Two lines to get started:

1. `const handle = await openPanel(url)` — opens a browser panel; may prompt on first structural use
2. `const page = await handle.cdp.lightweightPage()` — connects the lightweight CDP client

Reuse the same `page` for subsequent interactions — do not call `openPanel()` or
`handle.cdp.lightweightPage()` repeatedly for the same target. Repeated opens
create duplicate panels; repeated CDP client calls create duplicate CDP
connections.

## Existing Panels

Use `panelTree` for already-open panels; do not reopen duplicates. Only drive
an existing workspace panel when the task is to inspect or test that panel's
own UI. For arbitrary URLs, login flows, scraping, or browser navigation, use
`openPanel(url)` and hold that browser handle in your component's state.

```ts
import { panelTree } from "@workspace/runtime";

// panelTree is top-level; workspace.panelTree is not available.
const panels = await panelTree.list();
const target = panels.find((handle) => handle.source === "panels/spectrolite");
if (!target) throw new Error("target panel not found");

const page = await target.cdp.lightweightPage();
console.log(await page.title());
```

With a known slot id:

```ts
import { panelTree } from "@workspace/runtime";

const handle = panelTree.get("panel-slot-id");
await handle.refresh(); // hydrates title/source/parent/runtime entity metadata
const page = await handle.cdp.lightweightPage();
```

For RPC or `_agent` calls on unloaded panels, call `await handle.ensureLoaded()`
first. Existing-panel handles are non-owned: do not call `handle.navigate`,
`handle.reload`, or `handle.close` on them unless requested. Do not call
`handle.cdp.navigate(url)` or `page.goto(url)` on the current chat panel, a
parent chat panel, or any workspace panel discovered from `panelTree` unless
the requested task is to replace that exact panel. Open a browser panel for web
navigation instead.

## Panel Ownership

Panels opened by the workflow are owned by it. Hold handles in your component's
state; close temporary owned panels when the workflow is done:

```ts
await browser?.close();
```

Do not close panels discovered with `panelTree.*` unless requested.

## Reconnection by Panel ID

Browser handles and CDP pages are live objects tied to the panel runtime; they
cannot be persisted (the eval `scope` is server-side in your `EvalDO`, and a
panel/component's own state is lost on re-mount or panel reload). What you can
persist is the panel **id** (a string). Re-acquire a handle from a known id with
`getPanelHandle` (or rediscover via `panelTree.list()`) from panel/component
code, then reconnect the CDP page:

```tsx
import { getPanelHandle } from "@workspace/runtime";

const handle = getPanelHandle(savedBrowserId); // panel id survives as a plain string
const page = await handle.cdp.lightweightPage();
console.log("Reconnected:", await page.title());
```

Keep the panel id somewhere durable for the surface you're on (component
props/state, or a value you stash via the channel) rather than relying on a live
handle persisting.

## Page API Reference

Obtain a `page` from a panel handle, then use the methods below.
`handle.cdp.lightweightPage()` returns a Playwright-style page driven by our own
lightweight, workerd-native CDP client (`@workspace/cdp-client`). It is the
single browser-automation surface — there is no separate "full Playwright" tier
to choose, and you do not import or install any `playwright*` package.

```typescript
const browser = await openPanel("https://example.com");
const page = await browser.cdp.lightweightPage();
```

`handle.cdp.lightweightPage()` loads the standalone `@workspace/cdp-client`
internally; do not import that package directly for ordinary page work. There is
no `handle.cdp.page()` alias.

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
`url`. Use `page.consoleEvents()` on the page only for live events captured
after the CDP connection is established.

For broad post-mortem panel debugging, prefer the unified bundle:

```ts
const diagnostics = await handle.diagnostics({ limit: 200, errorLimit: 100 });
console.log(diagnostics.info);
console.log(diagnostics.consoleHistory.errors);
```

The same historical capture includes renderer lifecycle failures such as
`render-process-gone`, failed main-frame loads, and unresponsive renderer
events.

`page.url()` follows the Playwright shape: it returns a string synchronously,
not a `Promise`. Do not `await page.url()` or attach `.then()` / `.catch()` to
it. Use `await page.evaluate(() => location.href)` only when you need the page
to compute a URL after client-side routing. Panel handles expose target RPC
under `.call` and automation under `.cdp`; `handle.click(selector)` is a
Playwright convenience wrapper for `handle.cdp.click(selector)`.
Use `await parent.getInfo()` for handle metadata; the runtime's own
`panel.getInfo()` describes the current runtime, not arbitrary handles.

### Locators

Locators auto-wait — the element is resolved when an action or read runs against
it, so you can build a locator before the element exists.

```typescript
page.locator("css selector");
page.getByRole("button", { name: "Sign in", exact: true });
page.getByText("Welcome");
page.getByLabel("Email");
page.getByPlaceholder("Search");
page.getByTestId("submit");
page.getByAltText("Logo");
page.getByTitle("Close");

// Chaining
page.getByRole("listitem").filter({ hasText: "active" }).nth(2);
page.locator(".row").first();
page.locator(".row").last();
const rows = await page.locator(".row").all();
```

### Navigation

```typescript
await page.goto(url); // navigate (waits for load)
await page.goto(url, { waitUntil: "networkidle" }); // wait for network quiet
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.reload();
await page.goBack();
await page.goForward();
page.url(); // current URL
await page.evaluate(() => location.href); // current URL computed in page context
await page.title(); // page title
await page.content(); // full HTML source
```

### Interaction (auto-wait)

Actions wait for the element to be visible, stable, and enabled before acting.

```typescript
await page.getByRole("button", { name: "Submit" }).click();
await page.locator(".item").dblclick();
await page.locator(".item").hover();
await page.getByLabel("Email").fill("user@example.com");
await page.getByLabel("Search").type("query"); // types character by character
await page.getByLabel("Email").clear();
await page.locator("input").press("Enter");
await page.getByRole("checkbox").check();
await page.getByRole("checkbox").uncheck();
await page.getByRole("checkbox").setChecked(true);
await page.getByLabel("Country").selectOption("US");
await page.locator("input").focus();
await page.locator("input").blur();
await page.locator(".far-below").scrollIntoViewIfNeeded();

// Back-compat string forms
await page.click("button.submit");
await page.fill('input[name="email"]', "user@example.com");
```

### Reads & state

```typescript
await page.locator(".modal").waitFor({ state: "visible" });
await page.locator(".row").count();
await page.locator(".badge").isVisible();
await page.getByRole("checkbox").isChecked();
await page.locator("button").isEnabled();
await page.locator("button").isDisabled();
await page.locator("input").isEditable();
await page.locator("a").getAttribute("href");
await page.locator("input").inputValue();
await page.locator(".title").innerText();
await page.locator(".title").textContent();
await page.locator(".row").allInnerTexts();
await page.locator(".row").allTextContents();
await page.locator(".box").boundingBox();
await page.locator(".box").inspect();
```

### DOM waits

```typescript
await page.waitForSelector(".loaded"); // wait for element to appear
await page.waitForFunction(() => document.readyState === "complete");
await page.waitForLoadState("networkidle"); // wait for load lifecycle
```

### Evaluate JavaScript in Page

The most powerful method — run arbitrary JS in the page context:

```typescript
// Get text content
const text = await page.evaluate(() => document.querySelector("h1")?.textContent);

// Get multiple elements
const items = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".item")).map((el) => ({
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
const screenshot = await page.screenshot(); // PNG Uint8Array
const full = await page.screenshot({ fullPage: true });
const jpeg = await page.screenshot({ format: "jpeg", quality: 80 });
```

### Close

```typescript
await page.close?.(); // close the CDP page/client if available
await browser.close(); // close the browser panel
```

### Not supported

The lightweight client deliberately omits a few full-Playwright features. Out of
scope: file uploads (`setInputFiles`), multiple pages/popups, cross-origin
frames, and full network request interception (`route`). For protocol-level
needs beyond the page surface, use raw `CdpConnection.send` (see below).

### Protocol-level work

For raw CDP, connect to the panel's CDP endpoint and drive the protocol
directly:

```ts
import { CdpConnection } from "@workspace/cdp-client";

const endpoint = await handle.cdp.getCdpEndpoint(); // { wsEndpoint, token }
const c = await CdpConnection.connect(endpoint.wsEndpoint, endpoint.token);

await c.send("Page.navigate", { url: "https://example.com" });
c.on("Page.loadEventFired", () => console.log("loaded"));
```

Use `c.send(method, params)` for CDP commands and `c.on(event, cb)` for CDP
events — the escape hatch for network interception, file inputs, or multi-target
work the page surface does not cover.

### PanelHandle Methods

The handle also has direct navigation methods (no page object needed):

| Method                                             | Description                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `handle.cdp.lightweightPage()`                     | Connect the lightweight CDP client and return the Playwright-style page  |
| `handle.cdp.getCdpEndpoint()`                      | Get `{ wsEndpoint, token }` for raw `CdpConnection.connect`              |
| `handle.cdp.consoleHistory({ limit, errorLimit })` | Read host-captured historical console logs and the separate error buffer |
| `handle.click(selector)`                           | Convenience wrapper for `handle.cdp.click(selector)`                     |
| `handle.cdp.navigate(url)`                         | Load a URL                                                               |
| `handle.cdp.goBack()`                              | Navigate back                                                            |
| `handle.cdp.goForward()`                           | Navigate forward                                                         |
| `handle.cdp.reload()`                              | Reload page                                                              |
| `handle.cdp.stop()`                                | Stop loading                                                             |
| `handle.close()`                                   | Close browser panel                                                      |

## Examples

These examples acquire a panel handle in panel/component code; the
`handle.cdp.lightweightPage()` automation itself also works from server-side
eval once you hold the handle.

### Multi-Step Workflow: Scrape + Process

```tsx
import { openPanel } from "@workspace/runtime";

// Open and navigate
const browser = await openPanel("https://news.ycombinator.com");
const page = await browser.cdp.lightweightPage();

// Scrape data
const stories = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".titleline > a")).map((el) => ({
    title: el.textContent,
    href: el.getAttribute("href"),
  }))
);
console.log("Scraped", stories.length, "stories");

// Process results
const top5 = stories.slice(0, 5);
console.log("Top 5:", JSON.stringify(top5, null, 2));
```

### Login Flow

```tsx
import { openPanel } from "@workspace/runtime";

const browser = await openPanel("https://example.com/login");
const page = await browser.cdp.lightweightPage();

await page.getByLabel("Email").fill("user@example.com");
await page.getByLabel("Password").fill("secret");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForSelector(".dashboard");
console.log("Logged in, now at:", await page.evaluate(() => location.href));

// Still logged in — same page, same session
const dashboardData = await page.evaluate(() =>
  document.querySelector(".stats")?.textContent
);
console.log("Dashboard:", dashboardData);
```

### Combined: Import Cookies + Authenticate

```tsx
import { openPanel } from "@workspace/runtime";
import { browserData } from "@workspace/panel-browser";

// Step 1: Import cookies from Chrome
const browsers = await browserData.detectBrowsers();
const chrome = browsers.find((b) => b.name === "chrome");
if (chrome) {
  await browserData.startImport({
    browser: "chrome",
    profile: chrome.profiles[0] ?? chrome.dataDir,
    dataTypes: ["cookies"],
  });
  console.log("Cookies imported and synced to browser session");
}

// Re-running startImport for the same browser/profile is incremental. It pulls
// new or changed source records without duplicating existing stored data.

// Step 2: Open browser — now has imported cookies
const browser = await openPanel("https://github.com");
const page = await browser.cdp.lightweightPage();

const title = await page.title();
console.log("Page title:", title);

// Check if logged in
const isLoggedIn = await page.evaluate(() =>
  document.querySelector("img.avatar") !== null
);
console.log(isLoggedIn ? "Logged in!" : "Not logged in");
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

- **Acquire or create one handle and reuse it** — `openPanel`/`panelTree`/`getPanelHandle` work from server-side eval, panels, workers, and DOs; once you hold the handle, `handle.cdp.lightweightPage()` drives the browser page.
- **Hold a handle/page in component state and reuse it** — re-open and re-connect only for a new target; reuse the same `page` for follow-up interactions.
- **Prefer locators with auto-wait** — `page.getByRole(...)` / `page.locator(...)` wait for the element automatically; reach for `page.evaluate()` for complex DOM queries that need full DOM API access.
- **Use `page.goto(url, { waitUntil: "networkidle" })` for SPAs** — waits for AJAX requests to finish.
- **Use `page.waitForSelector()` or `locator.waitFor()` before interacting** — ensures elements exist before clicking/filling.
- **Wait on the page condition you need** — prefer explicit page state checks over wall-clock limits.
- **Imported cookies are auto-synced** — if you imported browser data via the browser-import skill, browser panels will have those cookies available automatically.
- **After a reload, reconnect via the saved panel id** — the id is a plain string you can persist; re-acquire the handle with `getPanelHandle(id)` and reconnect the CDP page without re-opening the panel.

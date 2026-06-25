# CDP Panel Automation

CDP automation is available on any panel-tree target through `PanelHandle`.
Use top-level `panelTree` for existing panels; `workspace.panelTree` is not part
of the runtime surface. For web browsing or website automation, open or reuse a
dedicated browser panel. Existing workspace panels, especially chat panels, are
application surfaces: inspect them when that app is the target, but do not use
them as disposable web pages.

```ts
import { openPanel, openExternal } from "@workspace/runtime";

const handle = await openPanel("https://example.com", { focus: true });
const page = await handle.cdp.lightweightPage();

await page.goto("https://example.com");
await page.getByRole("button", { name: "Sign in" }).click();
await page.fill("input[name=query]", "NatStack");
await page.click(".search-button");
await handle.click(".search-button"); // same target, convenience wrapper

await handle.cdp.navigate("https://other.com");
await handle.cdp.goBack();
await handle.cdp.reload();

await openExternal("https://docs.example.com");
```

`handle.cdp.lightweightPage()` returns a Playwright-style page driven by our own
lightweight, workerd-native CDP client (`@workspace/cdp-client`). It is the
single browser-automation surface — there is no separate "full Playwright" tier
to choose. Do not import or install any `playwright*` package; load the page
through `handle.cdp.lightweightPage()` and do not import `@workspace/cdp-client`
directly for ordinary page work.

Use `panelTree.list/roots/children/get` for existing panels. Existing handles
are non-owned: do not call `handle.navigate`, `handle.reload`, or
`handle.close` on them unless requested. Do not call `handle.cdp.navigate(url)`
or `page.goto(url)` on the current chat panel, a parent chat panel, or another
workspace panel unless the requested task is to replace that exact panel. Open a
browser panel for arbitrary URLs, login flows, scraping, and browser navigation.

```ts
// Later, when an owned temporary panel is no longer needed:
await scope.browser?.close();
delete scope.browser;
delete scope.page;
```

Reuse one handle and one CDP page object per workflow; repeated `openPanel()`
calls create duplicate panels, and repeated `handle.cdp.lightweightPage()` calls
create duplicate CDP connections. There is no generic `handle.cdp.page()` alias.

## Where it runs

The lightweight CDP client is workerd-native: it works in panels **and** in
worker/DO/server-side-eval contexts. It runs over a WebSocket to the panel's CDP
endpoint, so any context that holds a panel handle can drive the page —
including server-side `eval`. `openPanel`/`panelTree`/`getPanelHandle` are part
of the portable runtime surface from `@workspace/runtime`, so server-side eval
can create or acquire a panel handle directly before driving CDP automation.

## Page surface

`handle.cdp.lightweightPage()` returns a rich, Playwright-style page. Actions
auto-wait for the element to be visible/stable/enabled before acting.

```ts
const page = await handle.cdp.lightweightPage();

// Locators
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

// Actions (auto-wait)
await page.getByRole("button", { name: "Save" }).click();
await page.locator(".item").dblclick();
await page.locator(".item").hover();
await page.getByLabel("Email").fill("user@example.com");
await page.getByLabel("Email").type("user@example.com");
await page.getByLabel("Email").clear();
await page.locator("input").press("Enter");
await page.getByRole("checkbox").check();
await page.getByRole("checkbox").uncheck();
await page.getByRole("checkbox").setChecked(true);
await page.getByLabel("Country").selectOption("US");
await page.locator("input").focus();
await page.locator("input").blur();
await page.locator(".far-below").scrollIntoViewIfNeeded();

// Reads / state
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

Page-level methods:

```ts
await page.goto("https://example.com");
await page.goto(url, { waitUntil: "networkidle" });
await page.reload();
await page.goBack();
await page.goForward();
await page.title();
page.url(); // string, synchronous like Playwright
await page.content(); // full HTML
await page.evaluate(() => document.title);
await page.screenshot();
await page.waitForSelector(".ready");
await page.waitForLoadState("networkidle");
await page.waitForFunction(() => document.readyState === "complete");
const events = page.consoleEvents(); // live console capture after connect

// Back-compat string forms
await page.click("button.submit");
await page.fill('input[name="email"]', "user@example.com");
```

### Not supported

The lightweight client deliberately omits a few full-Playwright features. These
are out of scope: file uploads (`setInputFiles`), multiple pages/popups,
cross-origin frames, and full network request interception (`route`). For
protocol-level needs beyond the page surface, use raw `CdpConnection.send` (see
below).

## Protocol-level work

For raw CDP, open a connection to the panel's CDP endpoint and drive the
protocol directly:

```ts
import { CdpConnection } from "@workspace/cdp-client";

const endpoint = await handle.cdp.getCdpEndpoint(); // { wsEndpoint, token }
const c = await CdpConnection.connect(endpoint.wsEndpoint, endpoint.token);

await c.send("Page.navigate", { url: "https://example.com" });
c.on("Page.loadEventFired", () => console.log("loaded"));
```

Use `c.send(method, params)` to issue CDP commands and `c.on(event, cb)` to
subscribe to CDP events. This is the escape hatch for anything the page surface
does not cover (network interception, file inputs, multi-target work).

## Console diagnostics

Use historical console diagnostics for post-mortem panel debugging. CDP live
console events start only after a CDP client connects; they cannot recover
earlier errors. The host captures panel console messages from `webContents` as
soon as the target is registered:

```ts
const history = await handle.cdp.consoleHistory({ limit: 200, errorLimit: 100 });
console.log(history.errors);
console.log(history.dropped); // overflow is explicit
```

`history.entries` is the recent general log buffer. `history.errors` is a
separate error-only buffer so high-value errors survive noisy normal logging.
Entries include `timestamp`, `level`, `message`, `line`, `sourceId`, and `url`.
For a single panel-debugging call, use `await handle.diagnostics({ limit: 200,
errorLimit: 100 })`. The bundle includes handle metadata and the same
host-captured console history. Renderer lifecycle failures such as crashes,
failed loads, and unresponsive renderers are recorded in the historical error
buffer with `source: "lifecycle"`.

Use the page object returned by `handle.cdp.lightweightPage()` for automation:

```ts
const page = await handle.cdp.lightweightPage();
console.log(page.url(), await page.title());
await page.locator("button.submit").click();
await page.locator(".status").innerText();
await page.waitForSelector(".ready");
await page.waitForLoadState("networkidle");
```

`page.url()` is a synchronous Playwright-style accessor. Do not `await` it or
attach `.then()` / `.catch()`; use `await page.evaluate(() => location.href)`
only when the URL must be computed inside the page after client-side routing.

`handle.reload()` is panel lifecycle reload for the named panel's renderer; it
does not rebuild code and does not unload the panel's runtime lease. For
Chromium page reloads, use `handle.cdp.reload()`. Reloading the panel currently
executing eval can cancel that eval after the command is sent; run that reload
from a stable/root context when possible.

Tree relationships do not bypass approval. To drive a parent or sibling, obtain
that target's handle and use the same `handle.cdp` namespace:

```ts
import { panelTree } from "@workspace/runtime";

const parent = panelTree.self().parent();
if (parent) await parent.cdp.lightweightPage();

const sibling = panelTree.get("sibling-panel-id");
await sibling.cdp.navigate("https://example.com/status");
```

CDP access transparently loads unloaded targets after approval. Use
`handle.ensureLoaded()` only when you need a live target for RPC or `_agent`
introspection before calling `handle.call`, `handle.snapshot()`, `handle.tree()`,
`handle.state()`, `handle.routes()`, or `handle.setMode()`.

## Methods

| Method                                             | Description                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `handle.cdp.lightweightPage()`                     | Connect the lightweight CDP client and return the Playwright-style page  |
| `handle.cdp.getCdpEndpoint()`                      | Get `{ wsEndpoint, token }` for raw `CdpConnection.connect`              |
| `handle.cdp.consoleHistory({ limit, errorLimit })` | Read host-captured historical console logs and the separate error buffer |
| `handle.diagnostics({ limit, errorLimit })`        | Read handle metadata plus host-captured console/lifecycle diagnostics    |
| `handle.click(selector)`                           | Click in the target panel through CDP                                    |
| `handle.cdp.navigate(url)`                         | Load a URL in the target panel                                           |
| `handle.cdp.goBack()` / `goForward()`              | Chromium history                                                         |
| `handle.cdp.reload()`                              | Chromium page reload                                                     |
| `handle.cdp.stop()`                                | Stop loading                                                             |
| `handle.close()`                                   | Close the panel                                                          |

Opening panels, CDP, and structural operations prompt on first use per requester
entity and target panel/root. Privileged shell/about targets use a severe
danger-tone prompt. The remembered grant does not survive requester navigation.
Panels currently held by mobile/non-CDP hosts reject CDP access instead of being
silently taken over.

Use `openExternal(url)` when the user needs their normal browser profile, password manager, passkeys, or device/browser SSO. `openExternal` is approval-gated.

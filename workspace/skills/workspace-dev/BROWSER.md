# CDP Panel Automation

CDP automation is available on any panel-tree target through `PanelHandle`.
Use top-level `panelTree` for existing panels; `workspace.panelTree` is not part
of the runtime surface. For web browsing or website automation, open or reuse a
dedicated browser panel. Existing workspace panels, especially chat panels, are
application surfaces: inspect them when that app is the target, but do not use
them as disposable web pages.

```ts
import { openPanel, openExternal } from "@workspace/runtime";
import { playwrightPage } from "@workspace/playwright-automation";

const handle = await openPanel("https://example.com", { focus: true });
const page = await playwrightPage(handle);

await page.fill("input[name=query]", "NatStack");
await page.click(".search-button");
await handle.click(".search-button"); // same target, convenience wrapper

await handle.cdp.navigate("https://other.com");
await handle.cdp.goBack();
await handle.cdp.reload();

await openExternal("https://docs.example.com");
```

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
calls create duplicate panels.

Choose one CDP client explicitly. This keeps ordinary panel startup fast while
making the automation surface unambiguous:

- `await handle.cdp.lightweightPage()` loads the standalone
  `@workspace/cdp-client` internally. Use it only when you intentionally want
  the constrained surface; do not import the CDP client package directly.
- `await playwrightPage(handle)` from `@workspace/playwright-automation` loads
  vendored full Playwright through `@workspace/playwright-core`. Use this for UI
  tests, login flows, locators, waits, and screenshots.

There is no runtime compatibility shim and no silent fallback between clients.
Inline eval snippets that use the full client should pass
`imports: { "@workspace/playwright-automation": "latest" }`; source-file code
should declare the package dependency. Deliberately switch to
`handle.cdp.lightweightPage()` only when the smaller API is sufficient. There is
no generic `handle.cdp.page()` alias.

API scope:

| Client          | Entry point                                                      | Scope                                                                                                                                                                                              | Use when                                                                                       |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Full Playwright | `playwrightPage(handle)` from `@workspace/playwright-automation` | Fuller Playwright-style page/locator surface: `url`, `title`, `goto`, `locator`, locator `click/fill/innerText/textContent/count`, `waitForSelector`, `waitForLoadState`, `evaluate`, `screenshot` | UI tests, browser workflows, login flows, anything where robust selectors/waits matter         |
| Lightweight CDP | `handle.cdp.lightweightPage()`                                   | Small CDP wrapper for basic `goto`, `click`, `fill`, `evaluate`, `waitForSelector`, `screenshot`, console event capture, DOM `inspect(selector)`, and simple locator helpers                       | Constrained worker/DO contexts or code paths where you intentionally avoid the vendored client |

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

Use the page object returned by `playwrightPage(handle)` for full Playwright automation:

```ts
import { playwrightPage } from "@workspace/playwright-automation";

const page = await playwrightPage(handle);
console.log(page.url(), await page.title());
await page.locator("button.submit").click();
await page.locator(".status").innerText();
await page.waitForSelector(".ready");
await page.waitForLoadState("networkidle");
```

Do not import full Playwright in panel UI code unless the panel itself is
building an automation tool. For agents and UI workflows, import
`@workspace/playwright-automation` when the full Playwright-style locator/wait
surface is needed. Full Playwright is loaded on demand and is intentionally
heavier than the lightweight client; a load failure should expose the
underlying build/load problem. For quick diagnostics and simple DOM inspection,
`handle.cdp.lightweightPage()` is usually enough.

`handle.reload()` is panel lifecycle reload for the named panel's renderer; it
does not rebuild code and does not unload the panel's runtime lease. For
Chromium page reloads, use `handle.cdp.reload()`. Reloading the panel currently
executing eval can cancel that eval after the command is sent; run that reload
from a stable/root context when possible.

Tree relationships do not bypass approval. To drive a parent or sibling, obtain
that target's handle and use the same `handle.cdp` namespace:

```ts
import { panelTree } from "@workspace/runtime";
import { playwrightPage } from "@workspace/playwright-automation";

const parent = panelTree.self().parent();
if (parent) await playwrightPage(parent);

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
| `playwrightPage(handle)`                           | Load full Playwright CDP client and return the page                      |
| `handle.cdp.lightweightPage()`                     | Load the smaller CDP wrapper and return the page                         |
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

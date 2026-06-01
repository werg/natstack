# CDP Panel Automation

URL panels are opened with the same API as workspace panels. CDP automation is
available on any panel-tree target through the unified `PanelHandle`. In
userland, opening a panel is a structural tree mutation and prompts on first use
per requester entity and parent/root target:

```ts
import { openPanel, openExternal } from "@workspace/runtime";

const handle = await openPanel("https://example.com", { focus: true });
const page = await handle.cdp.playwrightPage();

await page.fill("input[name=query]", "NatStack");
await page.click(".search-button");
await handle.click(".search-button"); // same target, convenience wrapper

await handle.cdp.navigate("https://other.com");
await handle.cdp.goBack();
await handle.cdp.reload();
await handle.close();

await openExternal("https://docs.example.com");
```

Choose one named CDP client explicitly. This keeps ordinary panel startup fast while
making the automation surface unambiguous:

- `await handle.cdp.playwrightPage()` loads vendored
  `@workspace/playwright-core` and gives the fuller Playwright-style API. Use
  this for eval diagnostics, UI tests, login flows, locators, waits, and
  screenshots.
- `await handle.cdp.lightweightPage()` loads the smaller
  `@workspace/playwright-client` wrapper. Use it only when you intentionally
  want the constrained surface.

There is no silent fallback between clients. Some constrained eval/worker/DO
contexts may not expose `@workspace/playwright-core`; in those contexts
`playwrightPage()` fails with an explicit load error. Deliberately switch to
`lightweightPage()` for basic diagnostics, or fix the runtime/build exposure if
the fuller Playwright client is required. There is no generic
`handle.cdp.page()` alias.

API scope:

| Client | Entry point | Scope | Use when |
|--------|-------------|-------|----------|
| Vendored Playwright | `handle.cdp.playwrightPage()` | Fuller Playwright-style page/locator surface: `url`, `title`, `goto`, `locator`, locator `click/fill/innerText/textContent/count`, `waitForSelector`, `waitForLoadState`, `evaluate`, `screenshot` | Eval diagnostics, UI tests, browser workflows, login flows, anything where robust selectors/waits matter |
| Lightweight CDP | `handle.cdp.lightweightPage()` | Small CDP wrapper for basic `goto`, `click`, `fill`, `evaluate`, `waitForSelector`, `screenshot`, console event capture, DOM `inspect(selector)`, and simple locator helpers | Constrained worker/DO contexts or code paths where you intentionally avoid the vendored client |

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

Use the page object returned by `handle.cdp.playwrightPage()` for automation:

```ts
const page = await handle.cdp.playwrightPage();
console.log(page.url(), await page.title());
await page.locator("button.submit").click();
await page.locator(".status").innerText();
await page.waitForSelector(".ready");
await page.waitForLoadState("networkidle");
```

Do not eagerly import `@workspace/playwright-core` in panel UI code unless the
panel itself is building an automation tool. For agents and diagnostics, use
`handle.cdp.playwrightPage()` so the client loads only when CDP is actually
requested.

`handle.reload()` is panel lifecycle reload and tears down the target renderer.
For Chromium page reloads, use `handle.cdp.reload()`. Reloading an ancestor of
the panel currently executing eval can cancel that eval; run ancestor reloads
from a stable/root context when possible.

Tree relationships do not bypass approval. To drive a parent or sibling, obtain
that target's handle and use the same `handle.cdp` namespace:

```ts
import { panelTree } from "@workspace/runtime";

const parent = panelTree.self().parent();
await parent?.cdp.playwrightPage();

const sibling = panelTree.get("sibling-panel-id");
await sibling.cdp.navigate("https://example.com/status");
```

CDP access transparently loads unloaded targets after approval. Use
`handle.ensureLoaded()` only when you need a live target for RPC or `_agent`
introspection before calling `handle.call`, `handle.snapshot()`, `handle.tree()`,
`handle.state()`, `handle.routes()`, or `handle.setMode()`.

## Methods

| Method | Description |
|--------|-------------|
| `handle.cdp.playwrightPage()` | Load vendored Playwright CDP client and return the page |
| `handle.cdp.lightweightPage()` | Load the smaller CDP wrapper and return the page |
| `handle.cdp.consoleHistory({ limit, errorLimit })` | Read host-captured historical console logs and the separate error buffer |
| `handle.diagnostics({ limit, errorLimit })` | Read handle metadata plus host-captured console/lifecycle diagnostics |
| `handle.click(selector)` | Click in the target panel through CDP |
| `handle.cdp.navigate(url)` | Load a URL in the target panel |
| `handle.cdp.goBack()` / `goForward()` | Chromium history |
| `handle.cdp.reload()` | Chromium page reload |
| `handle.cdp.stop()` | Stop loading |
| `handle.close()` | Close the panel |

Opening panels, CDP, and structural operations prompt on first use per requester
entity and target panel/root. Privileged shell/about targets use a severe
danger-tone prompt. The remembered grant does not survive requester navigation.
Panels currently held by mobile/non-CDP hosts reject CDP access instead of being
silently taken over.

Use `openExternal(url)` when the user needs their normal browser profile, password manager, passkeys, or device/browser SSO. `openExternal` is approval-gated.

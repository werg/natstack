# @workspace/cdp-client

A lightweight, **workerd-native** Chrome DevTools Protocol client with a
**Playwright-style `Page`/`Locator` API**, implemented entirely over raw CDP
(`Runtime`/`DOM`/`Input`/`Page` domains) and a single `WebSocket`. No Node
dependencies and no vendored browser bundle, so it runs in panels, workers, and
Durable Objects / server-side `eval` alike.

This is the **single browser-automation surface** in the workspace. There is no
"full Playwright" package — do not install any `playwright*` dependency.

## Getting a page

From any panel handle (panels, workers, server-side eval — anywhere you hold a
handle):

```ts
const page = await handle.cdp.lightweightPage();
await page.goto("https://example.com");
await page.getByRole("button", { name: "Sign in" }).click();
```

For protocol-level work (any CDP domain, raw commands + events):

```ts
import { CdpConnection } from "@workspace/cdp-client";

const { wsEndpoint, token } = await handle.cdp.getCdpEndpoint();
const cdp = await CdpConnection.connect(wsEndpoint, token);
await cdp.send("Network.enable");
const off = cdp.on("Network.responseReceived", (p) => console.log(p));
// ... later: off(); cdp.close();
```

## Locators

Resilient, Playwright-style locators (resolved fresh on every use):

```ts
page.getByRole("button", { name: "Save", exact: true });
page.getByText("Welcome");
page.getByLabel("Email");
page.getByPlaceholder("Search…");
page.getByTestId("submit");
page.getByAltText("Logo");
page.getByTitle("Close");
page.locator("css .selector"); // CSS escape hatch
```

Chain and narrow:

```ts
page.getByRole("listitem").filter({ hasText: "Active" }).first();
page.locator("table").getByRole("row").nth(2).getByRole("cell").last();
const rows = await page.getByRole("row").all(); // Locator[]
```

## Actions (auto-waiting)

Every action **auto-waits** for the element to be present, visible, stable, and
enabled before acting — no manual `waitForSelector` before a click:

```ts
await loc.click(); // also: dblclick, hover
await loc.fill("text"); // also: type, clear, press("Enter")
await loc.check(); // also: uncheck, setChecked(true)
await loc.selectOption("value");
await loc.focus(); // also: blur, scrollIntoViewIfNeeded
```

## Reads & state

```ts
await loc.textContent(); // innerText, inputValue, getAttribute("href")
await loc.count(); // allTextContents, allInnerTexts
await loc.isVisible(); // isChecked, isEnabled, isDisabled, isEditable
await loc.boundingBox();
await loc.inspect(); // { tagName, id, className, text, visible, attributes, boundingBox }
```

## Waiting

```ts
await loc.waitFor({ state: "visible" }); // attached | detached | visible | hidden
await page.waitForLoadState("domcontentloaded");
await page.waitForFunction(() => document.readyState === "complete");
await page.waitForSelector(".ready");
```

## Timeouts

Auto-waiting defaults to **30 s**. Override globally or per call:

```ts
page.setDefaultTimeout(10_000);
await loc.click({ timeout: 2_000 });
```

## Errors

Failures throw a **`CdpError`** whose message names the target locator
(Playwright-style) and the reason, with `.locator` and `.cause` for handling:

```ts
import { CdpError } from "@workspace/cdp-client";

try {
  await page.getByTestId("missing").click();
} catch (e) {
  if (e instanceof CdpError) {
    e.message; // 'not actionable (not found) after 30000ms: getByTestId("missing")'
    e.locator; // 'getByTestId("missing")'
  }
}
```

`locator.toString()` returns the same description, handy for logging.

## Console capture

```ts
page.consoleEvents(); // [{ type, text, args }] captured since connect
page.clearConsoleEvents();
```

## Not supported (use raw `CdpConnection`)

These have no CDP-only path in a connectionless isolate and are intentionally
out of scope:

- **File uploads** (`setInputFiles`)
- **Multiple pages / popups** (single-target by design)
- **Cross-origin frames** (operations target the main frame)
- **Full network request interception** (`route`) — observation via
  `CdpConnection.on("Network.*", …)` works

For anything beyond the `Page`/`Locator` surface, `CdpConnection.send(method,
params)` / `.on(event, cb)` give you the entire CDP protocol.

## Build conditions

`package.json` exports resolve per target — all to the same implementation:

| condition          | entry            |
| ------------------ | ---------------- |
| `worker`/`workerd` | `src/worker.ts`  |
| `natstack-panel`   | `src/browser.ts` |
| `default`          | `src/index.ts`   |

Types are published from `index.d.ts` (kept in sync with `src/worker.ts`).

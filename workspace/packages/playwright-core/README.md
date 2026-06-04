# @workspace/playwright-core

Internal vendored Playwright CDP client used by NatStack browser automation.

This package is not the recommended userland import. Panels, workers, eval
snippets, and skills should import `@workspace/playwright-automation` and call
`playwrightPage(handle)` instead:

```ts
import { openPanel } from "@workspace/runtime";
import { playwrightPage } from "@workspace/playwright-automation";

const handle = await openPanel("https://example.com", { focus: true });
const page = await playwrightPage(handle);

console.log(page.url(), await page.title());
await page.locator("button").click();
```

Inline eval snippets must request the heavy package explicitly:

```ts
eval({
  imports: { "@workspace/playwright-automation": "latest" },
  code: `
    import { panelTree } from "@workspace/runtime";
    import { playwrightPage } from "@workspace/playwright-automation";

    const page = await playwrightPage(panelTree.self());
    return { title: await page.title() };
  `,
});
```

## Package Roles

| Package | Role |
| --- | --- |
| `@workspace/playwright-automation` | Public userland helper. Imports this package and exposes `connectPlaywright(endpoint)` plus `playwrightPage(handle)`. |
| `@workspace/playwright-core` | Internal browser/workerd-compatible CDP client implementation. No browser launching, local process management, CLI, reports, or test runner. |
| `@workspace/playwright-client` | Lightweight runtime-owned CDP wrapper used by `handle.cdp.lightweightPage()`. |

## What This Package Supports

`@workspace/playwright-core` connects to an existing CDP WebSocket endpoint and
drives the already-running page. It is intentionally scoped to browser/workerd
runtime use:

- Connect to an existing CDP target over WebSocket.
- Use the CDP-direct `BrowserImpl`, `BrowserContextImpl`, and `PageImpl`
  implementation.
- Use page helpers such as `url`, `title`, `goto`, `locator`,
  `waitForSelector`, `waitForLoadState`, `evaluate`, and `screenshot`.

It does not support Node-only Playwright features:

- Launching or installing browsers.
- Managing browser child processes.
- Local filesystem artifacts such as traces, videos, reports, or downloads.
- `@playwright/test`, CLI/codegen, Android automation, or Electron app
  launching.

The browser/workerd build stubs Node-only modules such as `fs`,
`child_process`, `net`, `tls`, and `inspector` for Playwright internals. Those
stubs are not a fallback implementation; if a Node-only code path is reached it
throws a clear error.

## Internal Direct Use

Only package internals and tests should import this package directly:

```ts
import { BrowserImpl } from "@workspace/playwright-core";

const browser = await BrowserImpl.connect(endpoint.wsEndpoint, {
  isElectronWebview: true,
  transportOptions: endpoint.token ? { authToken: endpoint.token } : undefined,
});
```

Userland code should prefer:

```ts
import { playwrightPage } from "@workspace/playwright-automation";
```

## Build

```bash
pnpm --filter @workspace/playwright-core build
```

The normal NatStack panel, worker, and library builders also know how to bundle
this package from source when it is pulled in through
`@workspace/playwright-automation`.

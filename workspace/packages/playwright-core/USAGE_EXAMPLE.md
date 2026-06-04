# Playwright Automation Usage

Use `@workspace/playwright-automation` from userland. It imports the vendored
`@workspace/playwright-core` implementation and keeps full Playwright out of the
default runtime bundle.

## Panel Or Eval Usage

```ts
import { openPanel } from "@workspace/runtime";
import { playwrightPage } from "@workspace/playwright-automation";

const handle = await openPanel("https://example.com", { focus: true });
const page = await playwrightPage(handle);

await page.waitForLoadState("domcontentloaded");
console.log(await page.title());
```

For inline eval, request the package explicitly:

```ts
eval({
  imports: { "@workspace/playwright-automation": "latest" },
  code: `
    import { panelTree } from "@workspace/runtime";
    import { playwrightPage } from "@workspace/playwright-automation";

    const page = await playwrightPage(panelTree.self());
    await page.locator("button.submit").click();
    return { title: await page.title() };
  `,
});
```

## Worker Usage

Workers can import the same userland package when their package declares the
dependency:

```ts
import { createWorkerRuntime, type WorkerEnv } from "@workspace/runtime/worker";
import { playwrightPage } from "@workspace/playwright-automation";

export default {
  async fetch(_request: Request, env: WorkerEnv) {
    const runtime = createWorkerRuntime(env);
    const parent = runtime.getParent();
    if (!parent) return new Response("no parent panel", { status: 404 });

    const page = await playwrightPage(parent);
    return Response.json({ title: await page.title() });
  },
};
```

## Connecting From a Raw Endpoint

Use `connectPlaywright(endpoint)` only when you already have a CDP endpoint:

```ts
import { connectPlaywright } from "@workspace/playwright-automation";

const browser = await connectPlaywright({
  wsEndpoint: "ws://127.0.0.1:9222/devtools/page/...",
  token: "optional-natstack-cdp-token",
});

const page = browser.contexts()[0]?.pages()[0];
if (!page) throw new Error("No page found in CDP target");
```

## API Scope

The returned page is the NatStack CDP-direct Playwright-style page. It supports
the browser automation surface we use in panels and workers:

- `url()`, `title()`, `content()`
- `goto(url, options)`
- `locator(selector)`, plus locator `click`, `fill`, `innerText`,
  `textContent`, and `count`
- `click`, `fill`, `type`
- `waitForSelector`, `waitForLoadState`
- `evaluate`
- `screenshot`

This is not upstream `@playwright/test` and it does not launch browsers. It
connects to an existing NatStack/Electron CDP target over WebSocket.

## Internal Core Imports

`@workspace/playwright-core` remains available for package internals and tests:

```ts
import { BrowserImpl } from "@workspace/playwright-core";
```

Do not use that as the documented userland path. Direct imports couple callers
to the vendored implementation and bypass the clearer automation helper API.

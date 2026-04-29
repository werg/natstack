# Browser Automation

Create and control browser panels via Playwright/CDP. Works in both Electron and headless (with extension) modes.

### Quick pattern

```typescript
import { createBrowserPanel, openExternal } from "@workspace/runtime";

// Create a browser panel and get a Playwright page
const handle = await createBrowserPanel("https://example.com", { focus: true });
const page = await handle.page();

// Interact
await page.fill("input[name=query]", "NatStack");
await page.click(".search-button");
const text = await page.evaluate(() =>
  document.querySelector(".results .first")?.textContent
);

// Navigate via handle (doesn't need Playwright)
await handle.navigate("https://other.com");
await handle.goBack();
await handle.reload();
await handle.close();

// Open in system browser (approval-gated, no automation)
await openExternal("https://docs.example.com");

// OAuth authorize URLs can include an expected callback binding.
await openExternal(authorizeUrl, { expectedRedirectUri });
```

### Fire-and-forget (window.open)

In Electron mode, `window.open("https://...")` also creates browser panels. Discover the child via event:

```typescript
import { onChildCreated, getBrowserHandle } from "@workspace/runtime";

onChildCreated(({ childId, url }) => {
  const handle = getBrowserHandle(childId);
  // handle.page(), handle.navigate(), etc.
});
window.open("https://example.com");
```

### BrowserHandle Methods

| Method | Description |
|--------|-------------|
| `page()` | Connect Playwright, return page for automation |
| `navigate(url)` | Load a URL |
| `goBack()` | Navigate back |
| `goForward()` | Navigate forward |
| `reload()` | Reload page |
| `stop()` | Stop loading |
| `close()` | Close browser panel |

**Security:** Panels can only control browser panels they own.

## Internal vs External Links

For workflow UIs, offer both link targets when useful:

- **Internal**: `createBrowserPanel(url, { focus: true })`. Use this when the
  user may want the agent to inspect or automate the page.
- **External**: `openExternal(url)`. Use this when the user needs their normal
  browser profile, password manager, passkeys, or device/browser SSO.

`openExternal` is approval-gated. It can be granted for the session, version,
or repo. Do not bypass it with ad hoc host bridges.


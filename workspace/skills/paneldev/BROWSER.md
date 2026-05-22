# Browser Automation

Browser panels are opened with the same API as workspace panels:

```ts
import { openPanel, openExternal } from "@workspace/runtime";

const handle = await openPanel("https://example.com", { focus: true });
const page = await handle.browser.page();

await page.fill("input[name=query]", "NatStack");
await page.click(".search-button");

await handle.browser.navigate("https://other.com");
await handle.browser.goBack();
await handle.browser.reload();
await handle.close();

await openExternal("https://docs.example.com");
```

`handle.reload()` is panel lifecycle reload. For browser page reloads, use `handle.browser.reload()`.

## Methods

| Method | Description |
|--------|-------------|
| `handle.browser.page()` | Connect Playwright and return the page |
| `handle.browser.navigate(url)` | Load a URL in the browser panel |
| `handle.browser.goBack()` / `goForward()` | Browser history |
| `handle.browser.reload()` | Chromium page reload |
| `handle.browser.stop()` | Stop loading |
| `handle.close()` | Close the panel |

Use `openExternal(url)` when the user needs their normal browser profile, password manager, passkeys, or device/browser SSO. `openExternal` is approval-gated.

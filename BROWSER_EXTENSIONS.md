# Browser Extension

NatStack includes a minimal Chrome extension for CDP (Chrome DevTools Protocol)
relay and native messaging. The extension is **not required** for basic panel
usage -- users navigate directly to panel URLs in their browser.

---

## Overview

The Chrome extension serves two purposes:

1. **CDP Bridge** -- Relays Chrome DevTools Protocol commands between the
   NatStack server and browser tabs, enabling Playwright-based automation.
2. **Native Messaging** -- Allows the server to auto-discover the running
   browser instance via Chrome's native messaging host.

The extension is ~150-360 lines of plain JavaScript with no build step.

---

## Panel Access

Panels are served over HTTP. No extension is needed to view them. Navigate
directly to:

```
http://localhost:{port}/{source}/?contextId={contextId}
```

For example:

```
http://localhost:5173/panels/my-app/?contextId=ctx-abc
```

### Context-Based Isolation

Panels use path-based URLs. The `contextId` query parameter identifies the
storage context used by the host shell and runtime services.

---

## Installing the Chrome Extension

The extension is in the `extension/` directory. It uses Manifest V3 with a
service worker background script.

### Step-by-step

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` directory inside your NatStack checkout
5. The extension appears in your toolbar

### Permissions

The Chrome extension requires:

- `debugger` -- to relay CDP commands via `chrome.debugger`
- `nativeMessaging` -- for server auto-discovery
- `storage` -- to persist settings in `chrome.storage.local`
- Host permissions for `http://localhost/*` and `http://127.0.0.1/*`

---

## How the CDP Bridge Works

The NatStack server can drive browser tabs via Playwright. Instead of launching
a separate browser process, it connects through the extension:

1. Server sends CDP commands to the extension via native messaging.
2. The extension forwards commands to the target tab using `chrome.debugger`.
3. CDP responses and events flow back through the same channel.

This allows the server (and agents) to inspect, interact with, and test panels
running in the user's existing browser session.

### Tab creation via extension

The extension supports creating new tabs on behalf of the server:

- **`open-tab`**: Creates a new tab, attaches the debugger, and registers it with
  the CDP bridge for automation. Used by `createBrowserPanel()` in headless mode.
- **`open-external`**: Creates a new tab without CDP tracking (system browser
  equivalent in headless mode). Used by `openExternal()`.

Both are sent via the `nav:command` protocol. For `open-tab`, the extension
responds with `cdp:register` (not `nav:result`) once the debugger is attached.

---

## What the Server Injects into Panel HTML

When serving a panel to the browser, the server augments the HTML with:

1. **Injected globals** -- `__natstackId`, `__natstackRpcPort`,
   `__natstackRpcToken`, `__natstackStateArgs`, etc. (replacing Electron's
   preload/contextBridge)
2. **Browser transport IIFE** -- creates a WebSocket connection to the RPC
   server using the same protocol as the Electron preload
3. **Context bootstrap script** -- prepares the panel's session and initializes
   the RPC-backed filesystem connection

Panel source code is identical between Electron and browser -- the transport
layer is swapped transparently.

---

## Troubleshooting

### Panels show a blank page or network error

- Verify the server is running with `--serve-panels`
- Check the browser console for CORS or WebSocket errors

### Server won't start

- Run `pnpm server:install` first (compiles better-sqlite3 for system Node)
- Ensure `natstack.yml` exists in the workspace directory
- Check for port conflicts if using a fixed `--panel-port`

### CDP relay not working

- Confirm the extension is loaded and enabled in `chrome://extensions/`
- Check that the native messaging host is installed correctly
- Look for errors in the extension's service worker console
  (click "Inspect views: service worker" on the extension card)

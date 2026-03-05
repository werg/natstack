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
http://{contextSubdomain}.localhost:{port}/{source}/
```

For example:

```
http://ctx-abc.localhost:5173/panels/my-app/
```

### Subdomain-Based Isolation

Each panel runs on its own `*.localhost` subdomain. Modern browsers (Chrome 73+,
Firefox 84+) resolve `*.localhost` to `127.0.0.1` per the WHATWG URL Standard.
Each subdomain gets a distinct browser origin, giving panels:

- Separate **localStorage** and **IndexedDB**
- Separate **cookies** and **service workers**

This mirrors Electron's `persist:{contextId}` partition behavior.

> **Note:** Some corporate DNS configurations may interfere with `*.localhost`
> resolution. If panels fail to load, verify that `*.localhost` resolves to
> `127.0.0.1` in your environment.

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
- Host permissions for `http://*.localhost/*` and `http://127.0.0.1/*`

---

## How the CDP Bridge Works

The NatStack server can drive browser tabs via Playwright. Instead of launching
a separate browser process, it connects through the extension:

1. Server sends CDP commands to the extension via native messaging.
2. The extension forwards commands to the target tab using `chrome.debugger`.
3. CDP responses and events flow back through the same channel.

This allows the server (and agents) to inspect, interact with, and test panels
running in the user's existing browser session.

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
- Ensure `*.localhost` resolves to `127.0.0.1` (default on modern browsers)
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

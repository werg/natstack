# Browser Extensions

NatStack ships browser extensions for Chrome and Firefox that connect to the
headless server and manage panel tabs automatically. This document covers
installation, configuration, and the end-to-end workflow.

---

## Overview

When running NatStack as a headless server (without Electron), the browser
extensions act as the UI coordinator:

1. **Connect** to the server's SSE event stream
2. **Listen** for panel lifecycle events (`panel:created`, `panel:built`, `panel:closed`)
3. **Auto-open** browser tabs for new panels (each on its own `*.localhost` subdomain)
4. **Pre-warm** OPFS storage by loading a hidden init page before the real panel
5. **Auto-close** tabs when panels are destroyed

Panels run in standard browser tabs with full access to NatStack services
(AI, git, build, pubsub, database) via WebSocket RPC — the same protocol
used by the Electron preload.

---

## Prerequisites

Before installing the extension, you need a running headless server.

### 1. Install server native dependencies

```bash
pnpm server:install    # compiles better-sqlite3 for system Node
pnpm build             # builds dist/server.mjs + browser transport + OPFS bootstrap
```

### 2. Start the headless server with panel serving

```bash
node dist/server.mjs \
  --workspace=/path/to/workspace \
  --serve-panels \
  --panel-port=8080
```

The server prints connection details on startup:

```
natstack-server ready:
  Git:       http://127.0.0.1:9001
  PubSub:    ws://127.0.0.1:9002
  RPC:       ws://127.0.0.1:9003
  Panels:    http://127.0.0.1:8080
  Panel API: http://127.0.0.1:8080/api/panels
  Panel SSE: http://127.0.0.1:8080/api/events
  Admin token: <hex string>
```

You'll need two values from this output for the extension:
- **Panels URL** (e.g., `http://127.0.0.1:8080`)
- **Admin token** (the hex string)

### CLI Flags Reference

| Flag | Description | Default |
|------|-------------|---------|
| `--workspace=PATH` | Workspace directory (must contain `natstack.yml`) | *(required)* |
| `--data-dir=PATH` | User data directory (build cache, database) | `~/.config/natstack` |
| `--app-root=PATH` | Application root | `cwd` |
| `--log-level=LEVEL` | Log verbosity | `info` |
| `--serve-panels` | Enable HTTP panel serving for browsers | `false` |
| `--panel-port=PORT` | Port for the panel HTTP server | random |

---

## Installing the Chrome Extension

The Chrome extension is in the `extension/` directory. It uses Manifest V3
with a service worker background script.

### Step-by-step

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` directory inside your NatStack checkout
5. The "NatStack Panel Manager" extension appears in your toolbar

### Configure the extension

1. Click the NatStack extension icon in the toolbar
2. Click **Settings** in the popup footer (or right-click the icon and choose *Options*)
3. Enter the **Server URL** from the server output (e.g., `http://127.0.0.1:8080`)
4. Paste the **Management Token** (the admin token hex string)
5. Optionally toggle:
   - **Auto-open tabs** — automatically opens a new tab when a panel is created
   - **Auto-close tabs** — automatically closes the tab when a panel is destroyed
6. Click **Save**

The extension popup shows a green dot and "Connected" when the SSE stream is active.

### Permissions

The Chrome extension requires:
- `tabs` — to create, focus, and close panel tabs
- `storage` — to persist server URL and token in `chrome.storage.local`
- Host permissions for `http://*.localhost/*` and `http://127.0.0.1/*`

---

## Installing the Firefox Extension

The Firefox extension is in the `extension-firefox/` directory. It uses
Manifest V3 with Firefox's gecko-specific settings.

### Step-by-step

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `extension-firefox/manifest.json` inside your NatStack checkout
4. The "NatStack Panel Manager" extension appears in your toolbar

> **Note:** Temporary add-ons in Firefox are removed when the browser closes.
> For persistent installation, you would need to sign the extension via
> `about:addons` or use `web-ext` for development.

### Configure the extension

Same as Chrome — click the extension icon, go to Settings, enter the server
URL and management token.

### Firefox differences

- No tab grouping support (Chrome-only `tabGroups` API)
- Background script runs as a persistent page (not a service worker)
- Minimum Firefox version: 109.0

---

## How It Works

### Connection Flow

```
Extension                          Server
   |                                  |
   |--- GET /api/events ------------->|  (SSE with Bearer token)
   |<-- event: snapshot --------------|  (current panel state)
   |                                  |
   |<-- event: panel:created ---------|  (new panel, includes initToken)
   |                                  |
   |--- Open hidden tab:              |
   |    {subdomain}.localhost/__init__ |  (pre-warm OPFS)
   |                                  |
   |<-- event: panel:built -----------|  (build complete, URL ready)
   |                                  |
   |--- Open panel tab:               |
   |    {subdomain}.localhost/?token=  |  (full panel)
   |--- Close hidden init tab         |
   |                                  |
   |<-- event: panel:closed ----------|
   |--- Close panel tab               |
```

### Subdomain-Based Isolation

Each panel runs on its own `*.localhost` subdomain (e.g.,
`editor-a4f.localhost:8080`). Modern browsers (Chrome 73+, Firefox 84+)
resolve `*.localhost` to `127.0.0.1` per the WHATWG URL Standard. Each
subdomain gets a distinct browser origin, giving panels:

- Separate **localStorage** and **IndexedDB**
- Separate **Origin Private File System (OPFS)**
- Separate **cookies** and **service workers**

This mirrors Electron's `persist:{contextId}` partition behavior.

### Context Pre-warming

When a `panel:created` event fires, the extension immediately opens a hidden
tab to `{subdomain}.localhost/__init__?token={initToken}`. This init page
runs the OPFS bootstrap script, which:

1. Checks IndexedDB for a `.template-initialized` marker
2. If not initialized, fetches the template spec from `/api/context/template`
3. Clones git repository files into OPFS (up to 6 concurrent fetches)
4. Writes the initialization marker

When the `panel:built` event arrives, the real panel tab opens with OPFS
already populated — no loading delay.

### Authentication

- **Management API** (`/api/panels`, `/api/events`): Bearer token in the
  `Authorization` header
- **Panel tabs**: Token in the URL query string (`?token=...`), exchanged for
  an `HttpOnly` session cookie on first load. Subsequent requests use the
  cookie, keeping URLs clean.

---

## Management API

The panel HTTP server exposes management endpoints on the bare host
(no subdomain):

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /` | none | Index page listing active panels |
| `GET /api/panels` | Bearer token | JSON array of active panels |
| `GET /api/events` | Bearer token | SSE stream of lifecycle events |

### SSE Event Types

| Event | Payload | When |
|-------|---------|------|
| `snapshot` | Full panel list | On initial SSE connection |
| `panel:created` | `{ panelId, title, subdomain, initToken }` | Panel registered (before build) |
| `panel:built` | `{ panelId, title, subdomain, url }` | Panel build complete |
| `panel:closed` | `{ panelId }` | Panel destroyed |
| `panel:build-error` | `{ panelId, error }` | Panel build failed |

### Per-Subdomain API

These endpoints are available on each panel's subdomain (session-cookie auth):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/context/template` | GET | Template spec for OPFS bootstrap |
| `/api/context/snapshot` | GET | Retrieve OPFS snapshot |
| `/api/context/snapshot` | POST | Store OPFS snapshot |
| `/__init__` | GET | Pre-warming init page |

---

## Creating Panels

Panels are created via the WebSocket RPC API using the admin token. The
server doesn't create panels automatically — an RPC client (agent, CLI tool,
or custom script) must request them.

### Example: Creating a Panel via the Admin RPC

```javascript
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:9003");

ws.on("open", () => {
  // Authenticate with admin token
  ws.send(JSON.stringify({
    type: "ws:auth",
    token: "<admin-token-from-server-output>"
  }));

  // Create a panel
  ws.send(JSON.stringify({
    id: 1,
    type: "call",
    service: "bridge",
    method: "createChild",
    args: ["workspace/panels/my-panel", {}]
  }));
});

ws.on("message", (data) => {
  console.log(JSON.parse(data.toString()));
});
```

Once the panel is created, the extension receives the `panel:created` and
`panel:built` SSE events and automatically opens the tab.

---

## Troubleshooting

### Extension shows "Disconnected"

- Verify the server is running with `--serve-panels`
- Check the Server URL in extension settings matches the Panels URL from
  server output (including port)
- Verify the management token is correct (copy-paste from server output)
- Click **Reconnect** in the popup footer

### Panel tabs show "Panel not found" or blank page

- The panel may have been closed on the server side
- Check the browser console for CORS or network errors
- Ensure `*.localhost` resolves to `127.0.0.1` (works by default on modern
  browsers, but some corporate DNS configs may interfere)

### OPFS bootstrap fails

- Check the browser console on the panel tab for error messages
- The git server must be reachable from the browser (default:
  `http://127.0.0.1:{gitPort}`)
- Template repositories must exist in the workspace

### Server won't start

- Run `pnpm server:install` first (compiles better-sqlite3 for system Node)
- Ensure `natstack.yml` exists in the workspace directory
- Check for port conflicts if using `--panel-port` with a fixed port

---

## Architecture Notes

### What's in the Extension

The extensions are plain JavaScript — no build step required. Each contains:

```
extension/                     (or extension-firefox/)
  manifest.json                Manifest V3 config
  background.js                Service worker (Chrome) / background script (Firefox)
  popup.html + popup.js        Toolbar popup showing panel list + connection status
  options.html + options.js    Settings page for server URL + token
```

### What the Server Injects into Panel HTML

When serving a panel to the browser, the server augments the HTML with:

1. **Injected globals** — `__natstackId`, `__natstackRpcPort`, `__natstackRpcToken`,
   `__natstackStateArgs`, etc. (replacing Electron's preload/contextBridge)
2. **Browser transport IIFE** — creates a WebSocket connection to the RPC
   server using the same protocol as the Electron preload
3. **OPFS bootstrap script** — populates the Origin Private File System from
   the context template (git repos cloned into OPFS)

This means panel source code is identical between Electron and browser — the
transport layer is swapped transparently.

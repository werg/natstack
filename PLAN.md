# Plan: Headless Service Architecture

## Objective

Make NatStack fully headless-capable: run all services without Electron, serve
panels to a web browser, and (in a future phase) connect remote headless workers.

---

## Research Findings

The codebase already has strong separation. Key facts:

- **`src/server/index.ts`** runs standalone with build, git, pubsub, AI, DB,
  tokens, agent hosting — all over WebSocket RPC. No Electron imports.
- **`src/server/rpcServer.ts`** is a pure WebSocket server with token auth and
  service dispatch. No Electron dependency.
- **Panels are React apps** that communicate exclusively via WebSocket
  (`src/preload/wsTransport.ts`). They never use Electron IPC directly.
- **`@workspace/runtime`** reads globals from `globalThis.__natstack*` and
  creates a `TransportBridge`. The transport uses browser-native WebSocket.
- **OPFS/ZenFS** for panel filesystem already works in modern browsers.
- **The build system** (`src/server/buildV2/`) outputs standard ESM HTML/JS/CSS.

What's **missing** for headless:
1. No `bridge` service in the server (panel create/close lifecycle)
2. No HTTP serving of panel content (only `natstack-panel://` Electron protocol)
3. No browser-compatible transport injection (currently via Electron preload)

---

## Implementation Steps

### Step 1: HeadlessPanelManager

**New file:** `src/server/headlessPanelManager.ts`

Panel tree management without Electron rendering. Same panel ID generation
scheme as `PanelManager` (`tree/{escaped}/...`), same context ID format. Tracks
panels in-memory with: id, parentId, source, contextId, stateArgs, buildState,
rpcToken. On `createPanel`, triggers build via `getBuild()` and stores artifacts
in the HTTP panel server (Step 3).

### Step 2: Headless Bridge Service

**New file:** `src/server/headlessBridge.ts`

Handles `bridge.*` RPC calls in headless mode. Mirrors
`src/main/ipc/bridgeHandlers.ts` for portable operations:
- `createChild` / `closeSelf` / `closeChild` → delegate to HeadlessPanelManager
- `getInfo` / `getChildPanels` / `setStateArgs` → panel queries
- Context template operations → import from `src/main/contextTemplate/`
- `listAgents` → import from `src/main/agentDiscovery.ts`
- GUI-only ops (`openDevtools`, `forceRepaint`) → no-op
- `openFolderDialog` → error (no GUI)
- Navigation/history → no-op (no WebContentsView)

### Step 3: HTTP Panel Server

**New file:** `src/server/panelHttpServer.ts`

HTTP server that replaces `natstack-panel://` for browsers:
- `GET /panels/:encodedPanelId/` → HTML with injected `__natstack*` globals
  and inline browser transport
- `GET /panels/:encodedPanelId/bundle.js` → JS bundle
- `GET /panels/:encodedPanelId/bundle.css` → CSS
- `GET /panels/:encodedPanelId/*` → code-split chunks and assets
- `GET /` → index page listing available panels
- Token auth via query param (matching Electron's approach)

Globals injection: Before the panel's `<script type="module">`, inject a
`<script>` that sets all `globalThis.__natstack*` values and creates the
WebSocket transport bridge inline (adapted from `wsTransport.ts`).

### Step 4: Browser Transport

**Embedded in:** `src/server/panelHttpServer.ts` (as an inline script generator)

A browser-compatible version of `src/preload/wsTransport.ts`:
- No `process.argv`, no `Buffer` — pure browser APIs
- Config passed as function parameters
- Same WS protocol: `ws:auth` → `ws:rpc` → event handling
- Reconnect with exponential backoff (same as existing)
- Inlined into the HTML served by PanelHttpServer

### Step 5: Server Integration

**Modified file:** `src/server/index.ts`

- Add CLI flags: `--serve-panels`, `--panel-port=PORT`
- When `--serve-panels`:
  1. Create `PanelHttpServer`, start on panel port
  2. Create `HeadlessPanelManager` with deps (getBuild, createToken, etc.)
  3. Register `bridge` service via `handleHeadlessBridgeCall`
- Print panel server URL in ready output

### Step 6: Architecture Document

**New file:** `docs/architecture/headless-service-architecture.md`

Already written — comprehensive design document covering current architecture,
what's portable, what's Electron-bound, design decisions, security
considerations, and future phases (web shell, browser extension, remote workers).

---

## Files Created/Modified

| Action   | File                                              |
|----------|---------------------------------------------------|
| Create   | `src/server/headlessPanelManager.ts`              |
| Create   | `src/server/headlessBridge.ts`                    |
| Create   | `src/server/panelHttpServer.ts`                   |
| Modify   | `src/server/index.ts`                             |
| Create   | `docs/architecture/headless-service-architecture.md` |

No changes to Electron code paths. Existing behavior is unaffected.

---

## What This Does NOT Include (Future Phases)

- **Web shell** (porting `src/renderer/` to run in a browser with iframes)
- **Browser extension** for panel tree management
- **Remote workers** (agent task queue, remote authentication)
- **TLS/HTTPS** (for now, localhost only — use reverse proxy for remote)
- **Subdomain isolation** for cross-origin panel OPFS separation

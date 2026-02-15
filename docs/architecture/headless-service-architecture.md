# Headless Service Architecture

## Status: Design Document
## Date: 2025-02-15

---

## 1. Executive Summary

NatStack already has strong service separation. The `src/server/` process runs
standalone with build, git, pubsub, AI, database, tokens, and agent hosting —
all reachable over WebSocket RPC. Panels are React apps that communicate
exclusively via WebSocket, never via Electron IPC. The panel runtime
(`@workspace/runtime`) reads injected globals and creates a `TransportBridge`
over WebSocket.

This document designs the remaining steps to:

1. **Run the full service stack headlessly** — no Electron, no window, no
   `WebContentsView`.
2. **Serve panels to a regular web browser** — replacing the
   `natstack-panel://` custom protocol with HTTP.
3. **Connect headless workers** to the server for agentic task execution.

---

## 2. Current Architecture (What Exists)

```
Electron Main Process
 |
 +-- ViewManager          [Electron-specific: BaseWindow, WebContentsView]
 +-- PanelManager          [Mixes portable logic with Electron rendering]
 +-- ServiceDispatcher     [Portable: pure routing]
 +-- Shell Services        [Electron-specific: theme, menus, devtools]
 |
 +-- ServerProcessManager  [Spawns headless server as child]
      |
      +-- src/server/index.ts  [Already standalone-capable]
           +-- RpcServer       [WebSocket, token auth, service dispatch]
           +-- BuildSystemV2   [Content-addressed, git-driven]
           +-- GitServer       [HTTP git server]
           +-- PubSub          [WebSocket pub/sub + message store]
           +-- CoreServices    [AgentHost, AI, DB, TypeCheck]
```

### What's portable today

| Component              | Location                    | Electron-free? |
|------------------------|-----------------------------|:--------------:|
| ServiceDispatcher      | `src/main/serviceDispatcher.ts` | Yes        |
| Service policy         | `src/main/servicePolicy.ts`     | Yes        |
| RPC Server             | `src/server/rpcServer.ts`       | Yes        |
| Build System V2        | `src/server/buildV2/`           | Yes        |
| Git Server             | `src/main/gitServer.ts`         | Yes        |
| PubSub Server          | `src/main/pubsubServer.ts`      | Yes        |
| Agent Host             | `src/main/agentHost.ts`         | Yes        |
| AI Handler             | `src/main/ai/`                  | Yes        |
| Database Manager       | `src/main/db/`                  | Yes        |
| Token Manager          | `src/main/tokenManager.ts`      | Yes        |
| Core Services          | `src/main/coreServices.ts`      | Yes        |
| Process Adapter        | `src/main/processAdapter.ts`    | Yes        |
| WS Transport           | `src/preload/wsTransport.ts`    | Yes (browser WebSocket) |

### What's Electron-bound today

| Component              | Location                        | Electron API used          |
|------------------------|---------------------------------|----------------------------|
| PanelManager           | `src/main/panelManager.ts`      | WebContentsView, nativeTheme |
| ViewManager            | `src/main/viewManager.ts`       | BaseWindow, WebContentsView, session |
| Panel Protocol         | `src/main/panelProtocol.ts`     | protocol.handle, session   |
| Bridge Handlers        | `src/main/ipc/bridgeHandlers.ts`| dialog (folder picker)     |
| Shell Services         | `src/main/ipc/shellServices.ts` | nativeTheme, Menu, ViewManager |
| App Entry              | `src/main/index.ts`             | app, BaseWindow, session   |

---

## 3. Design: Headless Server

### 3.1 Goal

Run `node dist/server.mjs --workspace=/path` and get the full NatStack service
stack: build, git, pubsub, AI, agents, database — plus the ability to
manage panel lifecycle without rendering.

### 3.2 What the server already does

The server (`src/server/index.ts`) already starts in standalone mode:

```
$ node dist/server.mjs --workspace=/path/to/workspace
natstack-server ready:
  Git:       http://127.0.0.1:9001
  PubSub:    ws://127.0.0.1:9002
  RPC:       ws://127.0.0.1:9003
  Admin token: <hex>
```

Services registered: `events`, `build`, `tokens`, `git`, `ai`, `db`,
`agentSettings`, `typecheck`.

### 3.3 What's missing for full headless operation

1. **Panel management** — The `bridge` service (`createChild`, `closeSelf`,
   etc.) is only registered in the Electron main process because it delegates
   to `PanelManager` which creates `WebContentsView` instances.

2. **Panel content serving** — Panels are served via `natstack-panel://`
   custom protocol, which only exists inside Electron.

3. **Panel tree persistence** — Currently uses SQLite via the main process.
   The server has `db` service but not the panel tree schema.

4. **OPFS/context template initialization** — Currently relies on hidden
   Electron WebContentsView "template builder" workers to populate OPFS.

### 3.4 Headless Panel Manager

Create a `HeadlessPanelManager` that manages panel lifecycle without rendering:

```typescript
// src/server/headlessPanelManager.ts

class HeadlessPanelManager {
  private panels = new Map<string, HeadlessPanel>();
  private panelTree = new Map<string, string[]>(); // parentId -> childIds

  // Panel CRUD — same interface as PanelManager but no WebContentsView
  async createPanel(parentId, source, options, stateArgs): Promise<ChildCreationResult>
  closePanel(panelId: string): void
  getInfo(panelId: string): PanelInfo
  findParentId(childId: string): string | null
  isDescendantOf(childId, ancestorId): boolean

  // Panel tree
  getSerializablePanelTree(): SerializablePanelTree
  getChildPanels(parentId, options): ChildPanel[]

  // State management
  handleSetStateArgs(panelId, updates): void

  // No rendering, no navigation, no history
  // No forceRepaint, no view bounds, no theme injection
}
```

Each `HeadlessPanel` tracks:
- Panel ID, context ID, parent ID
- Source (package path), state args
- Build status (pending, built, failed)
- Auth token (for RPC and panel content serving)
- Type: `PanelType` (`"app" | "browser" | "shell"` from `src/shared/types.ts`)

**Type alignment:** `HeadlessPanel.type` uses the canonical `PanelType` from
`src/shared/types.ts`. The headless manager only **creates** `app`-type panels
(browser and shell types are GUI-specific), but it tracks whatever types exist
in the tree for query compatibility.

Workers (agents) are **not panels**. They are managed separately by `AgentHost`
as Node.js child processes with their own lifecycle. Workers connect to the RPC
server with `callerKind: "server"` tokens, not panel tokens. This separation is
intentional — workers are compute processes, panels are UI contexts.

For `app` panels in headless mode: the panel is **built but not rendered**.
The built artifacts are stored and made available via the HTTP panel server
(see section 4). A browser client can connect and display it.

### 3.4.1 Panel Tree Persistence

**V1: In-memory only (acceptable for initial headless deployment).**

The headless panel tree is ephemeral — lost on server restart. This is
acceptable for v1 because:
- Panels are cheap to recreate (build cache means instant rebuilds)
- Browser clients reconnect and re-request their panel
- Agents re-register with AgentHost on restart

**V2 (future): SQLite persistence.**

The Electron `PanelManager` already persists panel tree state to SQLite via
`src/main/db/panelPersistence.ts`. The headless server can adopt the same
schema when restart recovery becomes a requirement. The `db` service and
`DatabaseManager` are already available in the server.

### 3.5 Headless Bridge Service

Register a `bridge` service in the server that delegates to
`HeadlessPanelManager`:

```typescript
// In src/server/index.ts, after core services init:

dispatcher.register("bridge", async (ctx, method, args) => {
  return handleHeadlessBridgeCall(headlessPanelManager, ctx.callerId, method, args);
});
```

The headless bridge handler mirrors `bridgeHandlers.ts` but:
- `createChild` → creates panel in `HeadlessPanelManager`, triggers build,
  stores artifacts in HTTP server
- `closeSelf` / `closeChild` → removes from tree, revokes token
- `getInfo` / `getChildPanels` → reads from in-memory tree
- `openDevtools` / `forceRepaint` → no-op (or error)
- `openFolderDialog` → error (no GUI)
- Navigation/history methods → tracked in-memory, no WebContentsView

### 3.6 Service Policy Update

Add a new caller kind or reuse `"server"` for headless admin clients:

```typescript
// servicePolicy.ts update
bridge: {
  allowed: ["panel", "shell", "server"],  // Already allows server
},
```

No policy changes needed — `bridge` already allows `server` callers.

### 3.7 Configuration

```
$ node dist/server.mjs \
  --workspace=/path/to/workspace \
  --data-dir=/path/to/data \
  --serve-panels              # NEW: enable HTTP panel serving
  --panel-port=8080           # NEW: HTTP port for panel content
```

---

## 4. Design: Panel Serving via HTTP

### 4.1 Goal

Serve panel content over HTTP so a regular web browser can load and interact
with panels without Electron.

### 4.2 Architecture

```
Browser                         Server
  |                               |
  |  GET /panels/:panelId         |
  |------------------------------>|  Serves HTML with injected globals
  |  <script> globals + WS init   |
  |<------------------------------|
  |                               |
  |  GET /panels/:panelId/bundle.js
  |------------------------------>|  Serves built JS
  |<------------------------------|
  |                               |
  |  WS ws://server:rpcPort       |
  |------------------------------>|  Panel connects to RPC server
  |  { type: "ws:auth", token }   |  with per-panel token
  |<------------------------------|
  |  RPC calls (ai, db, etc.)     |
  |<============================>|
```

### 4.3 HTTP Panel Server

Create an HTTP server that replaces the `natstack-panel://` protocol:

```typescript
// src/server/panelHttpServer.ts

class PanelHttpServer {
  private panels = new Map<string, PanelArtifacts>();

  async start(port?: number): Promise<number>

  // Store built panel artifacts (mirrors storeProtocolPanel)
  storePanel(panelId: string, artifacts: BuildArtifacts, config: PanelConfig): void

  // Remove panel
  removePanel(panelId: string): void

  // HTTP routes:
  // GET /panels/:panelId/               → HTML with injected globals
  // GET /panels/:panelId/bundle.js      → JS bundle
  // GET /panels/:panelId/bundle.css     → CSS
  // GET /panels/:panelId/assets/*       → Static assets
  // GET /panels/:panelId/split-*.js     → Code-split chunks
}
```

### 4.4 Globals Injection

The key insight: panels read globals from `globalThis.__natstack*`. In
Electron, the preload script sets these. For browsers, we inject them as a
`<script>` tag in the HTML before the bundle loads.

The existing `handleProtocolRequest` in `panelProtocol.ts` already does
something similar with `injectBundleIntoHtml`. We extend this pattern:

```html
<!-- Served by PanelHttpServer -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <!-- CSP header set by server -->
  <script>
    // Injected by server — replaces Electron preload
    globalThis.__natstackId = "panel-abc123";
    globalThis.__natstackContextId = "safe_tpl_hash_instance";
    globalThis.__natstackKind = "panel";
    globalThis.__natstackParentId = "parent-xyz";
    globalThis.__natstackInitialTheme = "dark";
    globalThis.__natstackGitConfig = { serverUrl: "...", token: "...", ... };
    globalThis.__natstackPubSubConfig = { serverUrl: "...", token: "..." };
    globalThis.__natstackEnv = { PARENT_ID: "parent-xyz", ... };
    globalThis.__natstackStateArgs = { channelName: "...", ... };

    // Transport bridge — connects to RPC server via WebSocket
    // This replaces the preload's createWsTransport()
    // URL scheme matches page context: ws:// for HTTP, wss:// for HTTPS
    globalThis.__natstackTransport = (function() {
      const wsScheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${wsScheme}://SERVER_HOST:RPC_PORT`);
      // ... auth, message handling, reconnect ...
      return { send, onMessage };
    })();
  </script>
  <script type="importmap">{ "imports": { ... } }</script>
  <link rel="stylesheet" href="./bundle.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./bundle.js"></script>
</body>
</html>
```

### 4.5 Transport Bridge for Browser

The existing `wsTransport.ts` uses browser-native `WebSocket` already — it
works without Node.js. The transport code can be extracted and served as a
standalone script, or inlined into the HTML.

Key changes:
- Remove `process.argv` parsing (preload-specific)
- Accept config as function parameters instead
- Use `crypto.randomUUID()` (available in secure contexts)

```typescript
// src/server/browserTransport.ts
// A browser-compatible version of wsTransport.ts

export function createBrowserTransport(config: {
  panelId: string;
  rpcHost: string;
  rpcPort: number;
  authToken: string;
}): TransportBridge {
  // Same logic as wsTransport.ts but:
  // - No process.argv
  // - No Buffer (use TextEncoder/TextDecoder)
  // - Uses browser WebSocket API
}
```

### 4.6 OPFS in Browser

Panels use ZenFS with OPFS backend for filesystem access. This works in
modern browsers (Chrome 102+, Safari 15.2+, Firefox 111+) with no changes.

The existing `zenfs.ts` in `@workspace/runtime` already handles:
- OPFS availability detection
- ZenFS configuration with WebAccess backend
- Async-only filesystem API

**Context template initialization** is currently done via hidden Electron
WebContentsViews that run template-builder code. For headless browser serving,
this needs an alternative:

**Option A: Server-side OPFS initialization (recommended)**
- The server pre-populates a template on disk
- When a browser client loads a panel, the server serves a small bootstrap
  script that copies the template into the browser's OPFS
- Uses Service Worker or the panel's own initialization code

**Option B: On-demand clone in browser**
- The panel's bootstrap system (`@workspace/runtime/src/shared/bootstrap.ts`)
  already clones repos from the git server into OPFS
- This works in browsers — isomorphic-git runs in browsers
- Slower for first load but simpler architecture

Recommendation: Start with Option B (already works), optimize to Option A later.

### 4.7 Browser Shell (Future)

The Electron shell (`src/renderer/`) manages the panel tree UI: sidebar,
breadcrumbs, drag-and-drop, tab switching. For browser serving, there are
two approaches:

**Approach A: Single-panel mode**
- Each browser tab/window shows one panel
- No shell UI needed
- Panel creation opens a new browser tab
- Simplest to implement; works immediately

**Approach B: Web shell**
- Port the React shell to run in a browser
- Shell connects to server via WebSocket (already does this)
- Shell manages panel tree, renders panel iframes
- Each panel runs in an `<iframe>` with its own OPFS context
- More complex but provides the full NatStack experience

**Approach C: Browser extension**
- Extension provides the shell UI as a sidebar or popup
- Panels open in regular tabs
- Extension manages the panel tree and routes messages
- Moderate complexity; good UX for power users

Recommendation: Start with **Approach A** (single-panel mode). It works with
zero changes to the shell codebase. Then evolve to Approach B (web shell) for
the full experience. A browser extension (C) could enhance either approach.

---

## 5. Design: Headless Workers

### 5.1 Goal

Run agentic workers (chat agents, code agents, test runners) without any GUI.
Workers should connect to the server, execute tasks, and report results via
PubSub.

### 5.2 Current Agent Architecture

Agents are already headless Node.js processes:

```
AgentHost (src/main/agentHost.ts)
  |
  +-- Spawns agent process (Node.js child_process)
  |   Uses ProcessAdapter abstraction
  |
  +-- Agent connects to:
  |   - RPC server (WebSocket, callerKind: "server")
  |   - PubSub server (WebSocket)
  |
  +-- Agent runtime: @workspace/agent-runtime
      - Receives workspace, PubSub config, RPC port
      - Can call AI, DB, Git services
      - Communicates via PubSub channels
```

### 5.3 What Works Today

- Agent Host spawns agents as Node.js processes
- Agents connect to RPC server with server-kind tokens
- Agents can call `ai`, `db`, `git`, `events`, `build` services
- PubSub handles message delivery between agents and panels
- Build system produces Node-target bundles for agents

### 5.4 What's Needed for Remote Workers

Currently agents are spawned locally by `AgentHost`. For remote workers:

1. **Remote agent registration** — Workers connect from remote machines to
   the RPC server with a worker token.

2. **Agent task queue** — Instead of `AgentHost.spawn()`, publish tasks to a
   queue. Remote workers pull tasks.

3. **Worker authentication** — Remote workers authenticate with a long-lived
   token or API key, not a per-spawn token.

This is a later phase. The immediate priority is getting the server to run
all services headlessly with local agents, which already works.

---

## 6. Implementation Status

### Phase 1: Headless Panel Manager (Done)

**Files created:**
- `src/server/headlessPanelManager.ts` — Panel tree management without rendering
- `src/server/headlessBridge.ts` — Bridge service handler for headless mode

### Phase 2: HTTP Panel Server + Server Integration (Done)

**Files created:**
- `src/server/panelHttpServer.ts` — HTTP server for panel content with inline
  browser transport and globals injection

**Files modified:**
- `src/server/index.ts` — Added `--serve-panels` and `--panel-port` flags,
  HeadlessPanelManager initialization, bridge service registration, HTTP panel
  server startup

### Phase 3: Web Shell (Future)

- Port `src/renderer/` shell to run in a browser with panels in iframes
- Or: browser extension for shell UI
- Requires multi-panel coordination, drag-and-drop, sidebar

### Phase 4: Remote Workers (Future)

- Agent task queue
- Remote worker registration
- Worker heartbeat/health monitoring
- Distributed build cache

---

## 7. Key Design Decisions

### 7.1 Why not just strip Electron from the existing codebase?

The Electron main process mixes portable service orchestration with
Electron-specific rendering. Rather than refactoring `panelManager.ts`
(1400+ lines) to conditionally skip rendering, it's cleaner to create a
focused `HeadlessPanelManager` that handles only the portable parts.

The existing Electron code path continues to work unchanged. Headless mode
is an alternative entry point, not a replacement.

### 7.2 Why HTTP instead of WebSocket for panel content?

Browsers need HTTP to load HTML, JS, CSS, and assets. WebSocket is used for
the RPC transport (real-time, bidirectional), but the initial page load must
be HTTP. This mirrors how the Electron protocol handler works — it serves
static content via `natstack-panel://` which is essentially a custom HTTP-like
protocol.

### 7.3 Why single-panel mode first?

The shell UI (sidebar, breadcrumbs, panel switching) adds significant
complexity. Single-panel mode works immediately: one browser tab = one panel.
This validates the architecture before tackling the multi-panel shell.

### 7.4 Panel isolation in browsers

In Electron, each panel gets its own `WebContentsView` with a separate
session/partition for OPFS isolation. In browsers:

- **Same-origin OPFS**: All panels on the same origin share OPFS. The existing
  context ID system (`safe_tpl_{hash}_{instance}`) already namespaces storage
  within OPFS, so panels don't collide.
- **Cross-origin iframes**: For stronger isolation, the web shell could serve
  each panel from a unique subdomain (e.g., `panel-abc.natstack.local:8080`).
  This gives each panel its own OPFS, cookies, and storage.

Recommendation: Start with same-origin (simpler), add subdomain isolation later.

---

## 8. Security Considerations

### 8.1 Browser Authentication Model

**Decision: Bearer token in JavaScript (explicit `ws:auth`), not HttpOnly cookies.**

The RPC server (`src/server/rpcServer.ts:118`) expects a `ws:auth` message as
the first WebSocket frame. This is a deliberate protocol design — the client
must explicitly authenticate by sending a token. This model works identically
in Electron and browsers:

1. Server generates a per-panel token via `TokenManager.createToken()`
2. Token is embedded in the panel's HTML page (in the injected `<script>` tag)
3. Browser JavaScript reads the token from `globalThis` and sends `ws:auth`
4. Server validates and establishes the authenticated session

**Why not HttpOnly cookies?** JS cannot read HttpOnly cookies, so it couldn't
send the `ws:auth` message. Changing the auth protocol to cookie-based
(validating during WS upgrade) would require modifying the existing RPC server
contract that all panels and agents already use. The explicit token model is
simpler and consistent across all client types.

**Token exposure mitigation:**
- Tokens are per-panel and short-lived (revoked when panel closes)
- The HTML page containing the token is served with `Cache-Control: no-store`
- Token is only valid for the specific panel's caller ID
- In v1, server listens on `127.0.0.1` only (no network exposure)

### 8.2 WebSocket Origin Validation

**CORS does not protect WebSocket connections.** Browsers send an `Origin`
header during the WS handshake, but the WebSocket protocol does not enforce
same-origin policy. The server must explicitly validate the `Origin` header.

The current `RpcServer` (`src/server/rpcServer.ts:73`) creates a
`WebSocketServer` on an `http.Server` but does not validate Origin headers.
This is acceptable today because:
- Server binds to `127.0.0.1` (not reachable from other machines)
- Token-based auth prevents unauthorized access even from localhost

**When exposing to the network (future):** The `RpcServer` must add a
`verifyClient` callback to the `WebSocketServer` configuration:

```typescript
this.wss = new WebSocketServer({
  server: this.httpServer,
  verifyClient: (info) => {
    const origin = info.origin || info.req.headers.origin;
    return this.allowedOrigins.has(origin);
  },
});
```

This is a required change before any non-localhost deployment.

### 8.3 Transport URL Scheme (ws vs wss)

The injected transport must match the page's security context:
- **HTTP page** → `ws://` WebSocket (localhost development)
- **HTTPS page** → `wss://` WebSocket (required — browsers block mixed content)

The `PanelHttpServer` determines the WebSocket URL scheme from its own
serving context. When served over HTTP (localhost), it injects `ws://`. When
behind a TLS-terminating reverse proxy (future), it uses the `X-Forwarded-Proto`
header or a configuration flag to inject `wss://`.

```typescript
// In panelHttpServer.ts globals injection:
const wsScheme = config.tls ? "wss" : "ws";
const wsUrl = `${wsScheme}://${config.rpcHost}:${config.rpcPort}`;
```

### 8.4 Network Exposure

The server currently listens on `127.0.0.1` only. For remote access:
- Use a TLS-terminating reverse proxy (nginx, caddy) in front of the server
- The proxy provides HTTPS + WSS, the server stays on plain HTTP/WS internally
- Add `--allowed-origins` flag for explicit Origin validation
- Admin token should be stored securely, not exposed in logs (use file or env var)

### 8.5 Content Security Policy

Panel HTML already includes CSP meta tags. The HTTP server should also set
CSP headers:
- `default-src 'self'` — restrict resource loading
- `connect-src ws://server:port wss://server:port` — allow WebSocket to RPC
  server (scheme matches page context)
- `script-src 'self' 'unsafe-inline'` — for injected globals script

---

## 9. Migration Path

### For existing Electron users

No changes. The Electron entry point continues to work exactly as before.
The server child process gains new capabilities but the main process
behavior is unchanged.

### For headless deployment

```bash
# Build
pnpm build

# Run headless server
node dist/server.mjs \
  --workspace=/path/to/workspace \
  --data-dir=/path/to/data \
  --serve-panels \
  --panel-port=8080

# Open panel in browser
open http://localhost:8080/panels/chat
```

### For CI/automation

```bash
# Run agents headlessly
node dist/server.mjs --workspace=/path

# Connect via RPC and trigger agent tasks
# (using admin token from stdout)
```

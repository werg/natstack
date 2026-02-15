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
- Type: `app` | `worker`

For `app` panels in headless mode: the panel is **built but not rendered**.
The built artifacts are stored and made available via the HTTP panel server
(see section 4). A browser client can connect and display it.

For `worker` panels: these already run as Node.js child processes via
`AgentHost`. No change needed.

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
    globalThis.__natstackTransport = (function() {
      // Inline transport implementation (or load from separate script)
      // Uses native browser WebSocket
      const ws = new WebSocket("ws://SERVER_HOST:RPC_PORT");
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

## 6. Implementation Plan

### Phase 1: Headless Panel Manager (Server-side)

**Files to create:**
- `src/server/headlessPanelManager.ts` — Panel tree management without rendering
- `src/server/headlessBridge.ts` — Bridge service handler for headless mode

**Files to modify:**
- `src/server/index.ts` — Register bridge service, initialize HeadlessPanelManager
- `src/main/servicePolicy.ts` — No changes needed (bridge already allows server)

**Outcome:** Server can manage panel lifecycle (create, close, tree traversal)
without Electron. Agents and workers can create child panels that exist
logically in the tree.

### Phase 2: HTTP Panel Server

**Files to create:**
- `src/server/panelHttpServer.ts` — HTTP server for panel content
- `src/server/browserTransport.ts` — Browser-compatible WS transport (inline script)

**Files to modify:**
- `src/server/index.ts` — Start HTTP panel server, integrate with build system
- `src/server/headlessPanelManager.ts` — Store artifacts in HTTP server on build complete
- `src/main/panelProtocol.ts` — Extract `handleProtocolRequest` logic into
  shared module usable by both Electron protocol and HTTP server

**Outcome:** Panels can be loaded in a regular browser tab. Browser connects
to RPC server via WebSocket for full panel functionality.

### Phase 3: Browser Transport & Shell

**Files to create:**
- `src/server/static/transport.js` — Standalone browser transport script

**Files to modify:**
- `workspace/packages/runtime/` — Ensure browser compatibility (already mostly there)
- Build output HTML template — Add transport injection point

**Outcome:** Full panel interactivity in browser. AI chat, code editing,
project launching all work in Chrome/Firefox/Safari.

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

### 8.1 Token Management

- Per-panel tokens are created by `TokenManager` and embedded in URLs/WebSocket auth
- Tokens are validated by `RpcServer` before any service call
- Token revocation disconnects the panel's WebSocket

For browser serving:
- Panel tokens should be set as `HttpOnly` cookies instead of URL params
- RPC WebSocket auth uses the token directly (same as today)
- CORS headers restrict which origins can connect

### 8.2 Network Exposure

The server currently listens on `127.0.0.1` only. For remote access:
- Add TLS support (HTTPS + WSS)
- Add authentication for the admin token
- Consider reverse proxy (nginx, caddy) in front of the server

### 8.3 Content Security Policy

Panel HTML already includes CSP meta tags. The HTTP server should also set
CSP headers:
- `default-src 'self'` — restrict resource loading
- `connect-src ws://server:port` — allow WebSocket to RPC server
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

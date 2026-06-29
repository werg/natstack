# NatStack

A tree-based browser with hierarchical panel navigation built on Electron.

## Mission: The Fluid Application Runtime

NatStack is designed to be a lightweight, agentic code execution environment that blurs the line between "using" software and "building" it.

### 1. Generative UI

We aim to enable **Generative UI**, where agents can modify, customize, and create user interfaces on the fly. The application is not a static artifact but a living medium that adapts to the user's needs through agentic intervention.

### 2. Ongoing Agentic Presence

In traditional development, the "builder" (developer or agent) leaves once the app is shipped. In NatStack, the agent remains a first-class citizen of the runtime. The "code part" becomes fluid, allowing the AI to continuously maintain, extend, and recompose the application while it is being used.

### 3. Compositionality for AI

We aim to bring the modularity and compositionality of software engineering to AI applications. By breaking down complex agentic workflows into discrete, composable "panels," we create a system where small, specialized agents can collaborate to achieve complex tasks.

---

## Core Philosophy

### Code as the Agentic Primitive

We believe that **file systems, files, and code execution** are the most robust primitives for agents. By allowing agents to operate within a standard coding environment (reading/writing files, executing scripts), we leverage their strong in-distribution training data (e.g., from GitHub).

### Git for State & Concurrency

**Git** offers a powerful, distributed metaphor for managing state, history, and concurrency. NatStack uses git not just for version control, but as the fundamental synchronization mechanism for application state.

### Lightweight Sandboxing

Full containerization (like Docker or heavy VMs) is often overkill for UI-focused agentic tasks. NatStack hits the "sweet spot" by using **sandboxed browser processes** backed by **server-side per-context folders**. This provides security and isolation without the overhead of a full OS.

---

## High-Level Architecture

NatStack is built as a hierarchical, tree-based browser where every "tab" is a self-contained application environment.

### 1. The Panel System (Electron + Webviews)

- **Structure**: The UI is a tree of "panels." Each panel is an isolated Electron `WebContents` (webview).
- **Hierarchy**: Panels can spawn child panels, creating a recursive interface that maps naturally to task decomposition.
- **Isolation**: Each panel runs in its own process, ensuring that a crash or security issue in one mini-app does not compromise the host.

### 2. The File System (Server-Side Context Folders)

- **Storage**: Each panel is backed by a persistent **per-context folder** on the server at `{workspace}/.contexts/{contextId}/`.
- **Access**: Panel `fs` calls go through RPC to a sandboxed `FsService` that uses Node.js `fs/promises`, exposing a standard Node.js `fs` API.
- **Result**: Agents running inside a panel perceive a standard Linux-like file system, and files are visible on disk for debugging and server-side tool access.

### 3. The Build System (On-the-Fly Compilation)

- **Just-in-Time**: Panels are not pre-compiled binaries. They are source code directories.
- **esbuild**: When a panel is loaded, the host process uses `esbuild` to compile the TypeScript/React source on the fly.
- **Fluidity**: This allows an agent to edit the source code of a running panel, reload it, and immediately see the changes—enabling a tight "edit-run" loop for generative UI.

### 4. Agentic Runtime

- **Injected Capabilities**: The runtime injects powerful capabilities directly into the panel's JavaScript environment, including:
  - **LLM Access**: Streaming interfaces to models like Claude and GPT.
  - **Git Operations**: `isomorphic-git` for cloning, pulling, and pushing state.
  - **Panel Control**: APIs to spawn children, manage layout, and communicate with other panels.

---

## Features

- **Tree Panel Navigation**: Organize browser sessions in a hierarchical tree structure
- **Breadcrumb UI**: Navigate through parent and child panels with intuitive breadcrumb navigation
- **Tab Siblings**: Multiple panels at the same level appear as tabs for easy switching
- **Embedded Browser**: Each panel contains a full webview with real web browsing capability
- **Dark Mode**: Automatic theme synchronization with your system preferences

## Requirements

- Node.js 20+
- pnpm

## Installation

Requires **Node.js 20+**. Both packages update via npm (re-run with `@latest`).

### Desktop app (macOS, Linux; Windows soon)

Installs the GUI and the bundled server:

```bash
npm install -g @natstack/app
natstack             # launch the desktop app
natstack --help      # CLI subcommands: remote, pair, mobile, fs, vcs, agent, eval, …
```

On macOS this runs cert-free for now (npm-delivered, non-quarantined); signed
DMG/AppImage/deb installers are published to GitHub Releases as they become available.

### Headless server (remote/home server; clients connect to it)

```bash
npm install -g @natstack/server
natstack-server --host 0.0.0.0 --gateway-port 3030
# quick one-off (no global install):
npx -p @natstack/server natstack-server --host 0.0.0.0 --gateway-port 3030
```

The server installs with no compiler (workerd/esbuild ship prebuilt binaries) and
builds panels/workers on demand. See [docs/remote-server.md](docs/remote-server.md).

### Develop (contributors)

```bash
pnpm install
pnpm dev             # build + start Electron with DevTools
pnpm cli --help      # run the CLI live from TypeScript
pnpm server:live --help
```

See [docs/cli.md](docs/cli.md). (The published npm packages above replace the old
`pnpm link --global` flow; `pnpm dev` / `pnpm cli` remain the dev workflow.)

## Scripts

- `pnpm dev` - Build and start in development mode with DevTools
- `pnpm dev -- --auto-approve` - Start dev mode and automatically approve decision-style approval prompts
- `pnpm build` - Production build
- `pnpm start` - Start the app (requires prior build)
- `pnpm lint` - Run ESLint with strict rules
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check formatting
- `pnpm type-check` - Type check without emitting

## How It Works

Each panel in Natstack is a browser session that can have child panels. This creates a tree structure where you can:

1. **Navigate down**: Click "Add Child Browser" to create a nested browser panel
2. **Navigate up**: Use ancestor breadcrumbs to go back to parent panels
3. **Navigate sideways**: Click sibling tabs to switch between panels at the same level
4. **Navigate down through descendants**: Click descendant breadcrumbs to jump to child panels

## Development

Start the development server:

```bash
pnpm dev
```

The app will open with DevTools enabled for debugging.

### Memory Diagnostics (optional)

You can enable lightweight memory logging to identify which panel/worker is growing. Logs are derived from `app.getAppMetrics()` and include working set, peak working set, and (Windows-only) private bytes for each view’s process.

```bash
# Log a snapshot every 60s
NATSTACK_MEMORY_LOG_MS=60000 pnpm dev

# Log only if any view exceeds the threshold (MB)
NATSTACK_MEMORY_LOG_THRESHOLD_MB=1500 pnpm dev

# Log a single snapshot at startup
NATSTACK_MEMORY_LOG_ONCE=1 pnpm dev
```

To temporarily increase the renderer V8 heap limit in dev:

```bash
NATSTACK_RENDERER_MAX_OLD_SPACE_MB=4096 pnpm dev
```

## Building for Production

```bash
pnpm build
pnpm start
```

---

## Headless Server

NatStack can run without Electron as a standalone Node.js server. All core
services — build, git, channels, AI, agents, tokens — are available over
WebSocket RPC. Persistent storage lives inside workerd Durable Objects (each
DO owns its own SQLite-backed `this.sql`); the server has no native module
dependencies. Panels can optionally be served to a regular web browser over
HTTP.

### Prerequisites

```bash
npm install -g @natstack/server
```

For development from a source checkout instead: `pnpm install && pnpm build`.

### Running

```bash
natstack-server --host 0.0.0.0 --gateway-port 3030
# from a source checkout: node dist/server.mjs --host 0.0.0.0 --gateway-port 3030
```

The installed `natstack-server` shim pins the app root to the package, so it works
from any directory. On startup the server prints connection details:

```
natstack-server hub ready:
  Gateway:     http://127.0.0.1:3030
  Pairing code: abc123...
```

### CLI Flags

| Flag                  | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `--app-root=PATH`     | Application root (defaults to cwd)                      |
| `--host=HOST`         | External hostname or address clients can reach          |
| `--gateway-port=PORT` | Port for the hub HTTP/WS ingress (default: random)      |
| `--public-url=URL`    | Verified public URL used for OAuth/webhook routes       |
| `--log-level=LEVEL`   | Log level                                               |

The public server is always a hub. Clients pair with the hub, choose a
workspace, and then connect to `/_workspace/<name>`. Workspace flags are
reserved for internal child runtimes and are rejected by the public server.

### Android phone over VPN

For trusted phone testing over a VPN/LAN, build the internal Android app and
start a stable QR-pairing server. If you use the Tailscale HTTPS route, first
configure Serve on the server machine once:

```bash
sudo tailscale serve --bg 3030
```

Then start pairing:

```bash
natstack mobile install --launch
pnpm build
natstack mobile pair --host tailscale --port 3030
```

See [docs/mobile-vpn.md](docs/mobile-vpn.md) for host selection, workspace
selection, dev workspace mode, and reconnect behavior. Use the desktop app's
bootstrap screen to pair a laptop without copying an admin token.
After one desktop client is connected, use **Remote server** → **Paired
devices** → **Pair another device** to create additional pairing links.

Each panel gets:

- **Injected globals** replacing Electron's preload/contextBridge
- **A WebSocket transport** connecting to the RPC server (same protocol as
  the Electron preload)
- **RPC-backed filesystem** via server-side context folders
- **Full service access** — AI, git, database, build, channels

### In-Process Agents

Agents run as in-process services managed by AgentManager. They have direct
access to the server service registry and AIHandler, and communicate via channels.

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
Full containerization (like Docker or heavy VMs) is often overkill for UI-focused agentic tasks. NatStack hits the "sweet spot" by using **sandboxed browser processes** backed by **Origin Private File System (OPFS)**. This provides security and isolation without the overhead of a full OS.

---

## High-Level Architecture

NatStack is built as a hierarchical, tree-based browser where every "tab" is a self-contained application environment.

### 1. The Panel System (Electron + Webviews)
- **Structure**: The UI is a tree of "panels." Each panel is an isolated Electron `WebContents` (webview).
- **Hierarchy**: Panels can spawn child panels, creating a recursive interface that maps naturally to task decomposition.
- **Isolation**: Each panel runs in its own process, ensuring that a crash or security issue in one mini-app does not compromise the host.

### 2. The File System (OPFS + ZenFS)
- **Storage**: Each panel is backed by a persistent **Origin Private File System (OPFS)**.
- **Access**: We use a custom runtime (ZenFS) to expose this browser-native storage as a standard Node.js `fs` API.
- **Result**: Agents running inside a panel perceive a standard Linux-like file system, allowing them to use standard tools and libraries.

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

```bash
pnpm install
```

## Scripts

- `pnpm dev` - Build and start in development mode with DevTools
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
services — build, git, pubsub, AI, agents, database, tokens — are available
over WebSocket RPC. Panels can optionally be served to a regular web browser
over HTTP.

### Prerequisites

The standalone server requires native dependencies (better-sqlite3 compiled
for system Node, not Electron's Node):

```bash
pnpm server:install
pnpm build
```

### Running

```bash
node dist/server.mjs --workspace=/path/to/workspace
```

On startup the server prints connection details:

```
natstack-server ready:
  Git:       http://127.0.0.1:9001
  PubSub:    ws://127.0.0.1:9002
  RPC:       ws://127.0.0.1:9003
  Admin token: <hex>
```

### CLI Flags

| Flag | Description |
|------|-------------|
| `--workspace=PATH` | Path to the NatStack workspace directory (must contain `natstack.yml`) |
| `--data-dir=PATH` | User data directory (build cache, EV state, database) |
| `--app-root=PATH` | Application root (defaults to cwd) |
| `--log-level=LEVEL` | Log level |
| `--serve-panels` | Enable HTTP panel serving for browser access |
| `--panel-port=PORT` | Port for the panel HTTP server (default: random) |

### Serving Panels to a Browser

With `--serve-panels`, the server starts an HTTP server that serves panel
content to any modern web browser — no Electron required:

```bash
node dist/server.mjs \
  --workspace=/path/to/workspace \
  --serve-panels \
  --panel-port=8080
```

Output includes the panel server URL:

```
natstack-server ready:
  Git:       http://127.0.0.1:9001
  PubSub:    ws://127.0.0.1:9002
  RPC:       ws://127.0.0.1:9003
  Panels:    http://127.0.0.1:8080
  Admin token: <hex>
```

Open `http://localhost:8080` to see a list of running panels. Panels are
created via the RPC `bridge.createChild` method (using the admin token), then
accessed by clicking their link on the index page.

Each panel gets:
- **Injected globals** replacing Electron's preload/contextBridge
- **A WebSocket transport** connecting to the RPC server (same protocol as
  the Electron preload)
- **OPFS filesystem** via ZenFS (works in Chrome, Safari, Firefox)
- **Full service access** — AI, git, database, build, pubsub

### Headless Agents

Agents run as headless Node.js processes managed by AgentHost. They work
identically in both Electron and standalone mode — they connect to the RPC
server with server-kind tokens and communicate via PubSub channels.


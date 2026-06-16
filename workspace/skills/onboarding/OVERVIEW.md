# What is NatStack?

NatStack is a desktop application (Electron) that gives you a personal, AI-powered workspace organized as horizontally stacked panels. Each panel is its own TypeScript app running in an isolated webview, and an AI agent (the chat panel) can create, edit, and launch new panels on the fly.

## Key Concepts

### Panels

Panels are the building blocks of your workspace. Each panel is a self-contained TypeScript/React app that gets bundled by esbuild and served in its own webview. Panels can:

- Access a sandboxed filesystem, SQLite databases, and AI models
- Open browser panels to view and automate websites
- Communicate with other panels via RPC
- Launch child panels

The **chat panel** is the default root panel — it's where you interact with the AI agent.

### Trusted Apps

Trusted workspace apps live under `apps/` and use package names such as
`@workspace-apps/shell`, `@workspace-apps/mobile`, and
`@workspace-apps/remote-cli`. Apps are for trusted client runtimes, not ordinary
panels. Use the `appdev` skill before creating or changing apps.

### Workspaces

A workspace is a named collection of panels, packages, workers, and configuration. You can:

- Create multiple workspaces (e.g. "personal", "work", "experiment")
- Fork a workspace to branch off a snapshot
- Switch between workspaces (triggers app relaunch)
- Configure which panels open on first launch (`initPanels`)

Workspace config lives in `meta/natstack.yml`. Each workspace gets its own GAD VCS state graph.

### Contexts

A context is an isolated execution environment for a panel. Each context gets:

- Its own **context folder** — a materialized view of the workspace state
- A unique **context ID** used in URLs and storage

Panels in the same context share a filesystem. The chat panel's agent and its child panels typically share a context so they can see each other's files.

### The Agent (Chat Panel)

The chat panel hosts an AI agent that can:

- **Run code** via the `eval` tool in a browser sandbox
- **Render UI** via `inline_ui` (persistent components in chat), `load_action_bar` / panel `actionBarFile` (compact pinned panel controls), and `feedback_custom` (interactive forms)
- **Preserve transcript state** through typed PubSub events: messages,
  invocations, inline UI, and action bars all replay from the same channel log
- **Read/write files** in the workspace
- **Build and launch panels** on demand
- **Connect API provider integrations** — Gmail, GitHub, Slack, and other OAuth/credential-backed services
- **Tune its own model defaults** — the host chat agent's provider, effort, approval, and chattiness are configurable
- **Import browser data** — cookies, passwords, bookmarks, history
- **Automate browsers** via Playwright (CDP)
- **Query databases**, call AI models, manage workers

### Workers (Workerd)

Workers are Cloudflare V8 isolates (via workerd) that run server-side logic. They support **Durable Objects** for persistent, stateful services. The agent system itself runs on workers with DOs for conversation channels and agent state.

### Runtime APIs

All panels and sandbox code can import from `@workspace/runtime`:

| API         | What it provides                                     |
| ----------- | ---------------------------------------------------- |
| `fs`        | Filesystem scoped to the context folder              |
| `db`        | SQLite databases scoped to the workspace             |
| `ai`        | Text generation and streaming (multiple model roles) |
| `workers`   | Create and manage workerd instances                  |
| `workspace` | List, create, configure, switch workspaces           |
| `rpc`       | Call services on the main process or other panels    |

Additional packages: `@workspace/panel-browser` (browser data import/export), `@workspace/cdp-client` (runtime-internal lightweight CDP client used by `handle.cdp.lightweightPage()`), `@workspace/playwright-automation` (full Playwright helper; import on demand and call `playwrightPage(handle)`).

### Build System

Panels and workers are built **on demand** — when you navigate to a panel URL or create a worker instance, the build system compiles the source with esbuild. Committing a workspace VCS state triggers rebuilds of affected units.

## Architecture at a Glance

```
┌─────────────────────────────────────────────────┐
│  Electron Host                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Chat     │ │ Panel A  │ │ Browser  │  ...    │
│  │ (agent)  │ │          │ │ Panel    │        │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘        │
│       │ WebSocket   │            │              │
│  ┌────┴─────────────┴────────────┴──────┐       │
│  │  Server (RPC, build, VCS, services)  │       │
│  └────┬─────────────────────────────────┘       │
│       │                                         │
│  ┌────┴──────────────────┐                      │
│  │  Workerd (workers/DOs)│                      │
│  └───────────────────────┘                      │
│       │                                         │
│  ┌────┴──────────────────┐                      │
│  │  GAD VCS (source)     │                      │
│  └───────────────────────┘                      │
└─────────────────────────────────────────────────┘
```

- **Panels** connect to the server over WebSocket for RPC
- The **server** handles builds, file access, VCS, external Git interop, database, AI proxy, and service routing
- **Workerd** runs workers and Durable Objects in V8 isolates
- **GAD VCS** stores workspace source state; committed state advances trigger rebuilds

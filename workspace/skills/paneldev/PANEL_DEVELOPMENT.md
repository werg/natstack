# Panel Development Guide

Practical guide to building NatStack panels.

## Quick Start

```tsx
// panels/my-app/index.tsx
export default function MyApp() {
  return <div>Hello World!</div>;
}
```

```json
// panels/my-app/package.json
{
  "name": "@workspace-panels/my-app",
  "natstack": { "title": "My App" },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/react": "workspace:*"
  }
}
```

---

## React Hooks

```tsx
import {
  usePanel,           // Full runtime API
  usePanelTheme,      // "light" | "dark"
  usePanelId,         // Panel's unique ID
  usePanelPartition,  // Storage partition name (null while loading)
  useContextId,       // Context ID for storage
  usePanelFocus,      // Focus state
  usePanelParent,     // Parent handle
} from "@workspace/react";
```

### Theme

```tsx
import { Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";

export default function App() {
  const appearance = usePanelTheme();
  return <Theme appearance={appearance}>{/* UI */}</Theme>;
}
```

### Navigation

Use `openPanel` to open panels. For in-page navigation (replacing the current panel), use `buildPanelLink`:

```tsx
import { openPanel, buildPanelLink } from "@workspace/runtime";

// Open a panel (preferred)
await openPanel("panels/editor");
await openPanel("https://github.com");  // opens as browser panel

// In-page navigation (replaces current panel)
window.location.href = buildPanelLink("panels/editor");

// Cross-context in-page navigation
window.location.href = buildPanelLink("panels/chat", {
  contextId: "abc-123",
  stateArgs: { channelName: "general" },
});
```

### Shared Storage

Multiple panels sharing filesystem and storage via cross-context navigation:

```tsx
const contextId = "shared-session-id";

// Navigate to chat in shared context
window.location.href = buildPanelLink("panels/chat", {
  contextId,
  stateArgs: { contextId },
});
```

The `contextId` must be DNS-safe (lowercase alphanumeric + hyphens).

---

## File System

```tsx
import { promises as fs } from "fs";

await fs.writeFile("/data.json", JSON.stringify({ key: "value" }));
const content = await fs.readFile("/data.json", "utf-8");
await fs.mkdir("/subdir", { recursive: true });
```

### Git

```typescript
import { GitClient } from "@workspace/git";
import { gitConfig } from "@workspace/runtime";

const git = new GitClient(fs, { serverUrl: gitConfig.serverUrl, token: gitConfig.token });
await git.clone({ url: `${gitConfig.serverUrl}/my-repo`, dir: "/repo" });
```

---

## Environment Variables

```typescript
import { env } from "@workspace/runtime";
const workspace = env["NATSTACK_WORKSPACE"] || "/workspace";
```

Environment variables are set at panel creation time via the server.

---

## State Args

Pass and receive configuration data during navigation:

```typescript
import { buildPanelLink, getStateArgs, useStateArgs, setStateArgs } from "@workspace/runtime";

// Pass state when navigating
window.location.href = buildPanelLink("panels/chat", {
  contextId: "abc-123",
  stateArgs: { channelName: "general", mode: "compact" },
});

// Read state reactively in a component (re-renders on update)
const stateArgs = useStateArgs<{ channelName: string; mode: string }>();

// Read state non-reactively (snapshot, for event handlers)
const args = getStateArgs<{ channelName: string }>();

// Update state (persists + triggers re-render)
await setStateArgs({ mode: "expanded" });
```

---

## Persistent State

Persistent state belongs in Durable Objects. Use `this.sql` inside a DO and expose the operations your panel needs through RPC:

```typescript
import { DurableObjectBase } from "@workspace/runtime/worker";

export class ItemsDO extends DurableObjectBase {
  protected createTables() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)");
  }

  addItem(name: string) {
    return this.sql.exec("INSERT INTO items (name) VALUES (?) RETURNING id", name).one();
  }

  listItems() {
    return this.sql.exec("SELECT * FROM items ORDER BY id").toArray();
  }
}
```

workerd stores DO SQL state under the workspace state directory in `.databases/workerd-do/`.

---

## Blobstore (large/binary content)

For bytes that don't fit in a DO row — pasted images, file uploads, generated
artifacts — use the per-workspace content-addressable blobstore. Content is
keyed by sha256 digest, deduplicated automatically, and written/read as
streams.

Metadata calls work via the normal RPC bridge:

```typescript
import { rpc } from "@workspace/runtime";

const exists = await rpc.call("main", "blobstore.has", digest);
const meta = await rpc.call("main", "blobstore.stat", digest); // { size, mtime } | null
```

Binary I/O happens on the gateway HTTP routes — `PUT /_r/s/blobstore/blob`
streams a body in and returns `{ digest, size }`; `GET /_r/s/blobstore/blob/<digest>`
streams it back. Both require a caller Bearer token. The panel runtime exports
`gatewayFetch`, which prefixes the gateway URL and stamps
`Authorization: Bearer <token>`:

```typescript
import { gatewayFetch } from "@workspace/runtime";

const put = await gatewayFetch("/_r/s/blobstore/blob", { method: "PUT", body });
const { digest, size } = await put.json();
const get = await gatewayFetch(`/_r/s/blobstore/blob/${digest}`);
```

`blobstore.delete` and `blobstore.list` are restricted to shell/server callers
— panels cannot mutate or enumerate the store. Treat blobs as immutable; once
a digest exists its bytes never change.

See [`docs/architecture/storage.md`](../../../docs/architecture/storage.md#blobstore-content-addressable-objects)
for the full design.

---

## PubSub

Real-time messaging between panels via `@natstack/pubsub`:

```typescript
import { pubsubConfig } from "@workspace/runtime";
import { connectWithConfig } from "@natstack/pubsub";

const client = connectWithConfig(pubsubConfig, {
  channel: "my-channel",
  contextId,
  handle: "my-panel",
  reconnect: true,
});

await client.ready();
await client.publish("chat", { text: "Hello!" });

for await (const msg of client.messages()) {
  console.log(msg.type, msg.payload);
}
```

---

## Package Scopes

| Scope | Import from | Location | Purpose |
|-------|-------------|----------|---------|
| `@workspace/*` | workspace packages | `workspace/packages/` | Shared utilities (built by esbuild) |
| `@workspace-panels/*` | other panels | `workspace/panels/` | Panel code sharing |
| `@workspace-about/*` | about panels | `workspace/about/` | Shell panels |
| `@workspace-agents/*` | agents | `workspace/agents/` | Agent processes |
| `@natstack/*` | root packages | `packages/` | Pre-built libraries (pubsub, ai, git, types) |

`@workspace/*` packages export TypeScript source directly (esbuild transpiles at build time).
`@natstack/*` packages are pre-compiled and export from `dist/`.
Repos under `workspace/projects/` are plain editable projects, not import
scopes and not launchable runtime units.

---

## Workspace Templates

Panels use the `"default"` workspace template (React + Radix) unless overridden. To use a different template, set the `template` field in the natstack config:

```json
{
  "natstack": {
    "title": "My Svelte Panel",
    "template": "svelte"
  },
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/svelte": "workspace:*"
  }
}
```

Templates live in `workspace/templates/{name}/` and define the framework and HTML shell. The default template is the standard choice for most panels; alternative templates exist for other frameworks.

---

## Related Docs

- [RPC.md](RPC.md) - Typed contracts for parent-child communication
- [BROWSER.md](BROWSER.md) - Browser automation (Playwright/CDP)
- [PANEL_SYSTEM.md](PANEL_SYSTEM.md) - API reference
- [TOOLS.md](TOOLS.md) - Agent tools reference

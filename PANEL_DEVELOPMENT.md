# Panel Development Guide

Practical guide to building NatStack panels. For API reference, see [PANEL_SYSTEM.md](PANEL_SYSTEM.md).

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

That's it. NatStack auto-mounts your default export.

---

## Panel Identity

Panels have two IDs. `slotId` is the stable visible panel slot and is the right
identity for panel-tree operations and PubSub/channel clients. `rpc.selfId`
matches the current runtime entity for direct RPC delivery and can change when
the panel navigates or reopens in place.

---

## React Hooks

Import from `@workspace/react`:

```tsx
import {
  usePanel,           // Get full runtime API
  usePanelTheme,      // "light" | "dark", auto-updates
  usePanelId,         // Panel's unique ID
  usePanelPartition,  // Storage partition name (null while loading)
  useContextId,       // Context ID for storage grouping
  usePanelFocus,      // Whether panel is focused
  usePanelParent,     // Parent handle (null if root)
} from "@workspace/react";
```

### Theme Integration

```tsx
import { Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";

export default function App() {
  const appearance = usePanelTheme();
  return (
    <Theme appearance={appearance}>
      {/* Your UI */}
    </Theme>
  );
}
```

### Navigation

Use `openPanel` to open panels. It handles both URLs (browser panels) and workspace sources.
From userland runtimes, opening a panel is a structural tree mutation and prompts on first use
per requester entity and parent/root target; shell UI calls use the trusted shell path.

```tsx
import { openPanel, buildPanelLink } from "@workspace/runtime";

function NavigationExample() {
  // Open a panel (new tab)
  const openEditor = () => openPanel("panels/editor");

  // Open with state args
  const openChat = () => openPanel("panels/chat", { stateArgs: { channel: "my-channel" } });

  // Open a URL as a browser panel
  const openSite = () => openPanel("https://github.com");

  // In-page navigation (replaces current panel) — use buildPanelLink
  const navigateToEditor = () => {
    window.location.href = buildPanelLink("panels/editor");
  };

  // Cross-context in-page navigation
  const navigateToChat = () => {
    window.location.href = buildPanelLink("panels/chat", {
      contextId: "abc-123",
      stateArgs: { channel: "my-channel" },
    });
  };

  return (
    <div>
      <button onClick={openEditor}>Open Editor</button>
      <button onClick={openChat}>Open Chat</button>
      <button onClick={openSite}>Open GitHub</button>
      <button onClick={navigateToEditor}>Navigate to Editor</button>
    </div>
  );
}
```

### Shared Storage with contextId

When panels need to share the same filesystem and storage (e.g., chat + agents in a session):

```tsx
import { buildPanelLink } from "@workspace/runtime";

function SessionLauncher() {
  const launchSession = () => {
    // Generate shared context ID for the session
    const sessionContextId = crypto.randomUUID();

    // Navigate to chat panel with shared storage
    window.location.href = buildPanelLink("panels/chat", {
      contextId: sessionContextId,
      stateArgs: {
        channelName: "my-channel",
        contextId: sessionContextId,
      },
    });

    // Or open an agent worker in a new tab sharing the same storage
    window.open(buildPanelLink("workers/agent", {
      contextId: sessionContextId,
      stateArgs: {
        channel: "my-channel",
        contextId: sessionContextId,
      },
    }));
  };

  return <button onClick={launchSession}>Start Session</button>;
}
```

**Important:** Pass `contextId` in both the link options (for storage) and
stateArgs (for app logic). `contextId` is not a build selector. If the panel code
itself must come from a context branch, the launch/navigation path must carry an
explicit build `ref` such as `ctx:<contextId>`; otherwise the panel uses the
main/default build.

---

## Typed RPC Communication

For type-safe parent-child communication, define a contract:

### 1. Define Contract (child panel)

```typescript
// panels/editor/contract.ts
import { z, defineContract } from "@workspace/runtime";

export interface EditorApi {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
  save(): Promise<void>;
}

export const editorContract = defineContract({
  source: "panels/editor",
  child: {
    methods: {} as EditorApi,
    emits: {
      "saved": z.object({ path: z.string(), timestamp: z.number() }),
      "modified": z.object({ dirty: z.boolean() }),
    },
  },
});
```

### 2. Export Contract (child's package.json)

```json
{
  "name": "@workspace-panels/editor",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  }
}
```

### 3. Implement Child

```tsx
// panels/editor/index.tsx
import { useEffect, useState } from "react";
import { rpc, getParentWithContract } from "@workspace/runtime";
import { editorContract } from "./contract.js";

const parent = getParentWithContract(editorContract);

export default function Editor() {
  const [content, setContent] = useState("");

  useEffect(() => {
    rpc.expose({
      async getContent() { return content; },
      async setContent(text) { setContent(text); },
      async save() {
        // Save logic...
        await parent?.emit("saved", { path: "/file.txt", timestamp: Date.now() });
      },
    });
  }, [content]);

  return (
    <textarea
      value={content}
      onChange={e => {
        setContent(e.target.value);
        parent.emit("modified", { dirty: true });
      }}
    />
  );
}
```

### 4. Use from Parent

```tsx
// panels/ide/index.tsx
import { useState, useEffect } from "react";
import { buildPanelLink } from "@workspace/runtime";
import { editorContract } from "@workspace-panels/editor/contract";

export default function IDE() {
  const [dirty, setDirty] = useState(false);

  const launch = () => {
    // Navigate to the editor panel via URL
    window.open(buildPanelLink("panels/editor"));
  };

  return (
    <div>
      <button onClick={launch}>Open Editor</button>
      <span>{dirty ? "Modified" : "Saved"}</span>
    </div>
  );
}
```

---

## File System

Safe panels use an RPC-backed filesystem with a Node.js-compatible API:

```tsx
import { promises as fs } from "fs";

async function example() {
  await fs.writeFile("/data.json", JSON.stringify({ key: "value" }));
  const content = await fs.readFile("/data.json", "utf-8");
  const files = await fs.readdir("/");
  await fs.mkdir("/subdir", { recursive: true });
  await fs.rm("/data.json");
}
```

### Workspace VCS (per-repo, build-gated)

VCS is **per-repo**. Each repo — every `section/<name>` under `packages/
panels/ workers/ extensions/ apps/ about/ skills/ templates/ projects/`, plus
the flat `meta` repo — is a first-class versioned unit with its own log
(`vcs:repo:<repoPath>`), `main` head, and `ctx:*` context heads. There is no
whole-workspace version: each repo is its own versioned unit, and the **push is
the build gate**.

Edits are edit-first: the `edit`/`write` tools record working edits on your
context head and project them to disk atomically. Seal those edits with
`vcs.commit`, then advance a repo's `main` with **push**. `vcs.status(repoPath,
head?)` (positional args) reports one repo's unpushed changes vs its own `main`.
`vcs.push` is **build-gated**: it bundles + type-checks the candidate, and if
that fails **no head advances** and you get structured diagnostics back.

A **brand-new** panel needs no init: create `panels/my-panel/` files (Quick
Start above), then the first `vcs.push({ repoPaths: ["panels/my-panel"] })`
*creates* its `main` from empty as the repo's first commit, build-gated. To
branch off an existing panel **keeping its history**, fork it
(`vcs.forkRepo("panels/chat", "panels/mychat")` — preserves the log lineage and
rewrites the `package.json` name leaf; rename the remaining component/contract
identifiers yourself, then push).

```typescript
import { vcs } from "@workspace/runtime";

// One repo's unpushed changes (context head vs that repo's main):
const status = await vcs.status("panels/my-panel");

// Build-gate the change into main. Read the result; never leave a repo red.
const result = await vcs.push({ repoPaths: ["panels/my-panel"] });
if (result.status === "build-failed") {
  for (const report of result.reports)
    for (const build of report.builds)
      for (const d of build.diagnostics)
        console.error(`${d.file}:${d.line}:${d.column}  ${d.severity}  [${d.source}] ${d.message}`);
}
// status: "pushed" | "up-to-date" → main already has the candidate state.
// status: "diverged" → main moved; merge "main" into your head and re-push.
```

Pass several repos (`vcs.push({ repoPaths: ["packages/ui", "panels/notes"] })`)
for an **atomic group push** — every listed repo advances or none does — when a
change spans repos or breaks a dependent. Content-only repos
(`projects/<vault>`, `meta`) push ungated. The CLI mirrors this:
`natstack vcs push --repo <p>` (repeat `--repo` for a group),
`natstack vcs status/log --repo <p>`.

---

## Environment Variables

Access environment variables passed to your panel via `env` from the runtime:

```typescript
import { env } from "@workspace/runtime";

const workspace = env["NATSTACK_WORKSPACE"] || "/workspace";
```

---

## CDP Panel Automation

Use `PanelHandle` for new or existing panels. Opening panels, CDP, and
structural operations are approval-gated per requester/target.

#### Typed API

```typescript
import { openPanel, openExternal, panelTree } from "@workspace/runtime";

// panelTree is a top-level export, not workspace.panelTree.
const handle = await openPanel("https://example.com", { focus: true });
const page = await handle.cdp.lightweightPage();

await page.fill("input[name=query]", "NatStack");
await page.click(".search-button");
const text = await page.textContent(".results .first");
const currentUrl = page.url(); // string, synchronous like Playwright

await handle.cdp.navigate("https://other.com");
await handle.cdp.goBack();
await handle.cdp.reload();

// Existing panels: discover or get by slot id.
const parent = panelTree.self().parent();
await parent?.cdp.lightweightPage();

const allPanels = await panelTree.list();
const existing = allPanels.find((panel) => panel.source === "panels/spectrolite");
const existingPage = await existing?.cdp.lightweightPage();

const known = panelTree.get("panel-slot-id");
await known.refresh(); // hydrate metadata when you start from a known slot id
await known.cdp.lightweightPage();

// Or open in system browser (no CDP access)
await openExternal("https://docs.example.com");
```

Panels created by the workflow are owned by it; close temporary owned panels
when the workflow is done. Existing handles from `panelTree.*` are non-owned:
do not navigate, reload, or close them unless requested.

#### Fire-and-forget (window.open)

In Electron mode, `window.open("https://...")` also creates browser panels. Discover the child ID via event:

```typescript
import { getPanelHandle, onChildCreated } from "@workspace/runtime";

onChildCreated(({ childId, url }) => {
  const handle = getPanelHandle(childId);
  // Now use handle.cdp.getCdpEndpoint(), handle.cdp.navigate(), etc.
});
window.open("https://example.com");
```

#### PanelHandle CDP methods

| Method | Description |
|--------|-------------|
| `cdp.lightweightPage()` | Connect the lightweight CDP client and return the active page |
| `cdp.getCdpEndpoint()` | Get CDP WebSocket URL and token for Playwright |
| `cdp.navigate(url)` | Load a URL |
| `cdp.goBack()` | Navigate back |
| `cdp.goForward()` | Navigate forward |
| `cdp.reload()` | Reload page |
| `cdp.stop()` | Stop loading |
| `close()` | Close browser panel |

Use `handle.ensureLoaded()` before RPC calls to an unloaded panel. CDP access
loads targets automatically after approval.

The lightweight page API follows Playwright's sync/async split: actions and
DOM reads are async, while `page.url()` returns the cached current URL as a
plain string. Do not `await page.url()` or attach `.catch()` to it; use
`await page.evaluate(() => location.href)` only when the URL must be computed in
the page context.

---

## Sharing Code

### Export from Panel

```json
{
  "name": "@workspace-panels/my-panel",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts",
    "./types": "./types.ts"
  }
}
```

### Import in Another Panel

```json
{
  "dependencies": {
    "@workspace-panels/my-panel": "workspace:*"
  }
}
```

```typescript
import { myContract } from "@workspace-panels/my-panel/contract";
import type { MyType } from "@workspace-panels/my-panel/types";
```

---

## State Args

Pass and receive configuration data during panel navigation:

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

// Update state (persists to DB + triggers re-render via WebSocket)
await setStateArgs({ mode: "expanded" });
```

---

## Persistent storage

There is no panel-facing `db` API. Persistent SQL storage lives inside Durable
Objects: every DO has a `this.sql` handle on its own private SQLite-backed
storage. To persist state from a panel, dispatch to a worker DO that owns the
schema. See `docs/architecture/storage.md` for the storage primitive and
`workspace/workers/sample-do/index.ts` for a minimal example.

For ephemeral or per-panel state, prefer `useStateArgs`/`setStateArgs` (above)
or the panel scope persistence (`scope` RPC service) used by the agentic-chat
REPL.

---

## Userland Approval Prompts

Use `requestApproval()` when a panel owns a domain-specific decision and wants
NatStack's trusted shell UI to ask the user. The verified panel is shown as the
issuer, and every non-dismiss choice is remembered for that issuer and
`subject.id`.

```tsx
import { requestApproval, revokeApproval, listApprovals } from "@workspace/runtime";

const decision = await requestApproval({
  subject: { id: "sync:push", label: "Sync push" },
  title: "Allow sync push?",
  summary: "This panel wants to let the sync service push changes.",
  options: [
    { value: "allow", label: "Allow", tone: "primary" },
    { value: "deny", label: "Deny", tone: "danger" },
  ],
});

if (decision.kind === "choice" && decision.choice === "allow") {
  // Continue with the panel-owned action.
}

await revokeApproval("sync:push");
const grants = await listApprovals();
```

Use built-in APIs instead for built-in host capabilities: `openExternal`,
`credentials.*`, `git.*`, and workspace/project operations already include the
right approval and trust-scope behavior.

---

## Channel Services

Real-time panel messaging is implemented as a workspace-owned userland service.
Use the workspace-local panel development docs for the current client package
and examples.

Key channel client APIs:
- `publish(type, payload)` -- Send a message
- `messages()` -- Async iterator for incoming messages
- `onRoster(handler)` -- Track connected participants
- `updateMetadata(meta)` -- Update participant metadata
- `ready()` -- Wait for replay completion

---

## Best Practices

1. **Use hooks** -- `usePanelTheme`, `useContextId`, etc. handle subscriptions automatically

2. **Use contracts** -- Type safety across panel boundaries catches errors at compile time

3. **Check optional parents** -- Panels may run standalone:
   ```typescript
   const parent = getParentWithContract(contract);
   await parent?.emit("event", data);
   ```

4. **Export contracts** -- Put contract in separate file and export via package.json

5. **Use openPanel for navigation** -- `openPanel(source)` opens any panel; use `buildPanelLink` only for in-page navigation:
   ```typescript
   import { openPanel } from "@workspace/runtime";
   await openPanel("panels/target");
   ```

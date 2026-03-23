# Getting Started

A step-by-step guide for new users. The agent should walk through these steps interactively, adapting to what the user wants to do.

## Step 1: Explore Your Workspace

Start by showing the user what's in their workspace:

```
eval({ code: `
  import { workspace, fs } from "@workspace/runtime";
  const config = await workspace.getConfig();
  console.log("Workspace:", config.id);
  console.log("Init panels:", config.initPanels);

  const entries = await fs.readdir("/", { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  console.log("Top-level directories:", dirs.join(", "));
  return { config, dirs };
` })
```

Key directories:
- `panels/` — panel apps (UI)
- `packages/` — shared workspace packages
- `workers/` — workerd workers and Durable Objects
- `agents/` — agent definitions
- `skills/` — skill documentation (like this one)

## Step 2: Import Browser Data

If the user wants to bring in their existing browser data (cookies for authentication, bookmarks, passwords), use the **browser-import** skill.

Quick start — detect what browsers are available:

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const api = createBrowserDataApi(rpc);
  const browsers = await api.detectBrowsers();
  for (const b of browsers) {
    const status = b.tccBlocked ? " (blocked — needs permission)" : "";
    console.log(b.displayName + status + " — " + b.profiles.length + " profile(s)");
    for (const p of b.profiles) {
      console.log("  " + p.displayName + (p.isDefault ? " (default)" : ""));
    }
  }
  return browsers;
`, timeout: 30000 })
```

Then ask the user which browser/profile to import from and which data types they want. See the `browser-import` skill docs for:
- [DISCOVERY.md](../browser-import/DISCOVERY.md) — browser detection and profile enumeration
- [IMPORT.md](../browser-import/IMPORT.md) — running imports
- [COOKIES.md](../browser-import/COOKIES.md) — cookie management and session sync
- [PASSWORDS.md](../browser-import/PASSWORDS.md) — password vault
- [BOOKMARKS.md](../browser-import/BOOKMARKS.md) — bookmark browsing
- [WORKFLOWS.md](../browser-import/WORKFLOWS.md) — end-to-end recipes

## Step 3: Set Up a Workspace

If the user wants to organize their work into separate workspaces:

```
eval({ code: `
  import { workspace } from "@workspace/runtime";

  // List existing workspaces
  const workspaces = await workspace.list();
  console.log("Workspaces:");
  for (const ws of workspaces) {
    const active = ws.name === await workspace.getActive() ? " (active)" : "";
    console.log("  " + ws.name + active);
  }
  return workspaces;
` })
```

Create a new workspace (optionally forking from an existing one):

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  const active = await workspace.getActive();
  const entry = await workspace.create("my-workspace", { forkFrom: active });
  console.log("Created workspace:", entry.name);
` })
```

Configure which panels open on first launch:

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  await workspace.setInitPanels([{ source: "panels/chat" }]);
  console.log("Init panels set");
` })
```

Switch to a workspace (this relaunches the app):

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  await workspace.switchTo("my-workspace");
` })
```

## Step 4: Create Your First Panel

Use the **paneldev** skill to scaffold and launch a panel. See the `paneldev` skill for the full workflow:
- [WORKFLOW.md](../paneldev/WORKFLOW.md) — step-by-step development process
- [PANEL_DEVELOPMENT.md](../paneldev/PANEL_DEVELOPMENT.md) — hooks, filesystem, templates
- [PANEL_SYSTEM.md](../paneldev/PANEL_SYSTEM.md) — API reference

Quick version:

```
eval({ code: `
  import { createProject } from "@workspace-skills/paneldev";
  await createProject({ projectType: "panel", name: "hello", title: "Hello World" });
`, imports: { "@workspace-skills/paneldev": "latest" }, timeout: 30000 })
```

Then edit the generated files with Read/Edit/Write tools and launch:

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  import { buildPanelLink } from "@workspace/runtime";
  await commitAndPush("panels/hello", "Initial launch");
  window.open(buildPanelLink("panels/hello", { contextId }));
`, imports: { "@workspace-skills/paneldev": "latest" }, timeout: 30000 })
```

## Step 5: Explore the Runtime

Use the **sandbox** skill to learn what you can do from the chat panel:
- [EVAL.md](../sandbox/EVAL.md) — running code in the sandbox
- [INLINE_UI.md](../sandbox/INLINE_UI.md) — rendering interactive components in chat
- [RUNTIME_API.md](../sandbox/RUNTIME_API.md) — full API reference (fs, db, ai, workers, etc.)
- [BROWSER_AUTOMATION.md](../sandbox/BROWSER_AUTOMATION.md) — Playwright via CDP
- [PATTERNS.md](../sandbox/PATTERNS.md) — common recipes

## Adapting the Flow

Not every user needs every step. Tailor the walkthrough:

| User goal | Steps to focus on |
|-----------|-------------------|
| "I want to browse the web with my logins" | Steps 1, 2 (import cookies + sync) |
| "I want to build an app" | Steps 1, 4 (scaffold + launch panel) |
| "I want to organize my projects" | Steps 1, 3 (workspace management) |
| "I want to see what this can do" | Steps 1, 5 (explore runtime APIs) |
| "Set everything up" | All steps in order |

Ask the user what they're most interested in and skip to the relevant section.

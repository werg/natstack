---
name: paneldev
description: Build and develop NatStack panels — project scaffolding, hooks, RPC contracts, workers, Durable Objects, AI integration, and development workflow.
---

# Panel Development Skill

Documentation for developing NatStack panels.

## Files

| Document | Content |
|----------|---------|
| [PANEL_DEVELOPMENT.md](PANEL_DEVELOPMENT.md) | Hooks, fs, templates |
| [PANEL_SYSTEM.md](PANEL_SYSTEM.md) | API reference |
| [WORKERS.md](WORKERS.md) | Workers & Durable Objects: AgentWorkerBase (@workspace/agentic-do), DurableObjectBase, PiRunner, approval continuations |
| [RPC.md](RPC.md) | Typed parent-child contracts |
| [AI.md](AI.md) | AI and browser automation |
| [TOOLS.md](TOOLS.md) | Agent tools reference |
| [WORKFLOW.md](WORKFLOW.md) | Development workflow |
| [create-project.ts](create-project.ts) | Project scaffolding and git helpers (importable via eval `imports` parameter) |

## Interaction Patterns

See the sandbox skill's [INTERACTION_PATTERNS.md](../sandbox/INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. In short: if an action involves choices or could fail, prefer rendering an inline UI that lets the user trigger it and reports results back via `chat.publish`.

## Critical Rules

1. **Relative paths only** — use `panels/my-app/index.tsx`, NEVER `/home/.../workspace/...`
2. **NEVER use Bash** for git, file listing, or file creation — use the structured tools
3. **Use filesystem tools for file edits** — Read, Edit, Write (not eval)
4. **Use eval only for runtime operations** — project creation, git, typecheck, tests, launching panels
5. **Static imports only in eval** — `import { rpc, openPanel } from "@workspace/runtime"` (NOT `await import(...)`)

## Quick Start Workflow

Create a project via eval with the `imports` parameter:

```
eval({ code: `
  import { createProject } from "@workspace-skills/paneldev";
  await createProject({ projectType: "panel", name: "my-app", title: "My App" });
`, imports: { "@workspace-skills/paneldev": "latest" }, timeout: 30000 })
```

Edit the generated files, then commit, push, and launch:

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  import { openPanel } from "@workspace/runtime";
  await commitAndPush("panels/my-app", "Initial launch");
  await openPanel("panels/my-app");
`, imports: { "@workspace-skills/paneldev": "latest" }, timeout: 30000 })
```

## Common Tasks

| Task | How |
|------|-----|
| Create project | `eval` with `imports: { "@workspace-skills/paneldev": "latest" }` — call `createProject({ projectType, name, title })` |
| Commit & push | `eval` with `imports` — call `commitAndPush("panels/my-app", "message")` |
| Launch panel | `eval` with `imports` — `commitAndPush(...)` + `openPanel(source)` |
| Launch worker | `eval` — `workers.create({ source: "workers/my-worker", contextId })` |
| Read a file | `Read({ file_path: "panels/my-app/index.tsx" })` |
| Edit a file | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })` |
| Check types | `eval` — `rpc.call("main", "typecheck.check", "panels/my-app")` |
| Run tests | `eval` — `rpc.call("main", "test.run", contextId, "panels/my-app")` |
| Git status | `eval` with `imports` — `import { GitClient } from "@natstack/git"` (see TOOLS.md) |
| List workspaces | `eval` — `workspace.list()` |
| Get workspace config | `eval` — `workspace.getConfig()` |
| Create workspace | `eval` — `workspace.create("name", { forkFrom: "default" })` |
| Set init panels | `eval` — `workspace.setInitPanels([{ source: "panels/my-app" }])` |
| Switch workspace | `eval` — `workspace.switchTo("name")` |

## Environment Compatibility

- Panel lifecycle operations (`openPanel`, `createBrowserPanel`, `focusPanel`, panel reload) require **panel context**.
- Project scaffolding (`createProject`), git operations (`commitAndPush`), typecheck, and tests work in **headless** sessions via eval + RPC.

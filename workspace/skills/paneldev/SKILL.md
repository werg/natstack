---
name: paneldev
description: NatStack panel development docs - hooks, contracts, filesystem, git, AI. Read SKILL.md to start.
---

# Panel Development Skill

Documentation for developing NatStack panels.

## Files

| Document | Content |
|----------|---------|
| [PANEL_DEVELOPMENT.md](PANEL_DEVELOPMENT.md) | Hooks, fs, templates |
| [PANEL_SYSTEM.md](PANEL_SYSTEM.md) | API reference |
| [WORKERS.md](WORKERS.md) | Workers & Durable Objects: AgentWorkerBase (@workspace/agentic-do), DurableObjectBase, StreamWriter, approval continuations |
| [RPC.md](RPC.md) | Typed parent-child contracts |
| [AI.md](AI.md) | AI and browser automation |
| [TOOLS.md](TOOLS.md) | Agent tools reference |
| [WORKFLOW.md](WORKFLOW.md) | Development workflow |
| [create-project.ts](create-project.ts) | Project scaffolding and git helpers (importable via eval `imports` parameter) |

## Critical Rules

1. **Relative paths only** — use `panels/my-app/index.tsx`, NEVER `/home/.../workspace/...`
2. **NEVER use Bash** for git, file listing, or file creation — use the structured tools
3. **Use filesystem tools for file edits** — Read, Edit, Write (not eval)
4. **Use eval only for runtime operations** — project creation, git, typecheck, tests, launching panels
5. **Static imports only in eval** — `import { rpc, buildPanelLink } from "@workspace/runtime"` (NOT `await import(...)`)
6. **`contextId` is pre-injected** — use it directly in eval, do NOT import it from `@workspace/runtime`

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
  import { buildPanelLink } from "@workspace/runtime";
  await commitAndPush("panels/my-app", "Initial launch");
  window.open(buildPanelLink("panels/my-app", { contextId }));
`, imports: { "@workspace-skills/paneldev": "latest" }, timeout: 30000 })
```

## Common Tasks

| Task | How |
|------|-----|
| Create project | `eval` with `imports: { "@workspace-skills/paneldev": "latest" }` — call `createProject({ projectType, name, title })` |
| Commit & push | `eval` with `imports` — call `commitAndPush("panels/my-app", "message")` |
| Launch panel | `eval` with `imports` — `commitAndPush(...)` + `window.open(buildPanelLink(source, { contextId }))` |
| Launch worker | `eval` — `workers.create({ source: "workers/my-worker", contextId, limits: { cpuMs: 100 } })` |
| Read a file | `Read({ file_path: "panels/my-app/index.tsx" })` |
| Edit a file | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })` |
| Check types | `eval` — `rpc.call("main", "typecheck.check", "panels/my-app")` |
| Run tests | `eval` — `rpc.call("main", "test.run", contextId, "panels/my-app")` |
| Git status | `eval` with `imports` — `import { GitClient } from "@natstack/git"` (see TOOLS.md) |

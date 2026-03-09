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
| [WORKERS.md](WORKERS.md) | Worker development, management API, limits |
| [RPC.md](RPC.md) | Typed parent-child contracts |
| [AI.md](AI.md) | AI and browser automation |
| [TOOLS.md](TOOLS.md) | Agent tools reference |
| [WORKFLOW.md](WORKFLOW.md) | Development workflow |

## Critical Rules

1. **Relative paths only** — use `panels/my-app/index.tsx`, NEVER `/home/.../workspace/...`
2. **NEVER use Bash** for git, file listing, or file creation — use the structured tools
3. **Use eval for runtime operations** — project creation, git, typecheck, tests, launching panels
4. **Static imports only in eval** — `import { rpc, buildPanelLink } from "@workspace/runtime"` (NOT `await import(...)`)
5. **`contextId` is pre-injected** — use it directly in eval, do NOT import it from `@workspace/runtime`

## Quick Start Workflow

Create a project via eval:

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  await rpc.call("main", "project.create", contextId, "panel", "my-app", "My App");
`, timeout: 30000 })
```

Edit the generated files:

```
Read({ file_path: "panels/my-app/index.tsx" })
Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })
```

Launch via eval:

```
eval({ code: `
  import { rpc, buildPanelLink } from "@workspace/runtime";
  await rpc.call("main", "git.contextOp", contextId, "commit_and_push", "panels/my-app", "Initial launch");
  window.open(buildPanelLink("panels/my-app", { contextId }));
`, timeout: 30000 })
```

## Common Tasks

| Task | How |
|------|-----|
| Create panel | `eval` — `rpc.call("main", "project.create", contextId, "panel", "my-app")` |
| Create package | `eval` — `rpc.call("main", "project.create", contextId, "package", "utils")` |
| Create agent | `eval` — `rpc.call("main", "project.create", contextId, "agent", "my-agent")` |
| Create worker | `eval` — `rpc.call("main", "project.create", contextId, "worker", "my-worker")` |
| Launch worker | `eval` — `workers.create({ source: "workers/my-worker", contextId, limits: { cpuMs: 100 } })` |
| Read a file | `Read({ file_path: "panels/my-app/index.tsx" })` |
| Edit a file | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })` |
| Check types | `eval` — `rpc.call("main", "typecheck.check", "panels/my-app")` |
| Run tests | `eval` — `rpc.call("main", "test.run", contextId, "panels/my-app")` |
| Git operations | `eval` — `rpc.call("main", "git.contextOp", contextId, "status")` |
| Launch panel | `eval` — `commit_and_push` + `window.open(buildPanelLink(source, { contextId }))` |
| Rebuild panel | `eval` — `commit_and_push` + `window.open(buildPanelLink(source, { contextId }))` |

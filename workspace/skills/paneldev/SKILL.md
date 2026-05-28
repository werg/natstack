---
name: paneldev
description: Build and develop NatStack panels — project scaffolding, hooks, RPC contracts, workers, Durable Objects, AI integration, and development workflow.
---

# Panel Development Skill

Documentation for developing NatStack panels.

For trusted workspace apps under `apps/` (`@workspace-apps/*`, Electron shell,
mobile React Native, or terminal targets), use the `appdev` skill instead.

## Files

| Document                               | Content                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WORKFLOW.md](WORKFLOW.md)             | Canonical agent workflow: scaffold, open, inspect, edit, push, reload, close                                                                      |
| [PANEL_API.md](PANEL_API.md)           | Runtime panel API reference                                                                                                                       |
| [WORKERS.md](WORKERS.md)               | Workers & Durable Objects: AgentWorkerBase (@workspace/agentic-do), DurableObjectBase, PiRunner, approval continuations, runtime approval prompts |
| [RPC.md](RPC.md)                       | Typed parent-child contracts                                                                                                                      |
| [BROWSER.md](BROWSER.md)               | Browser automation (Playwright/CDP)                                                                                                               |
| [TOOLS.md](TOOLS.md)                   | Agent tools reference                                                                                                                             |
| [create-project.ts](create-project.ts) | Project scaffolding and git helpers (importable via eval `imports` parameter)                                                                     |

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
`
})
```

Edit the generated files, then commit, push, and launch:

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  import { openPanel } from "@workspace/runtime";
  await commitAndPush("panels/my-app", "Initial launch");
  scope.myApp = await openPanel("panels/my-app");
`
})
```

## Common Tasks

| Task                 | How                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create project       | `eval` — `import { createProject } from "@workspace-skills/paneldev"` then `createProject({ projectType, name, title })`                             |
| Fork panel           | `eval` — `import { forkProject } from "@workspace-skills/paneldev"` then `forkProject({ from: "panels/chat", to: "panels/chat-experiment", title })` |
| Fork worker          | `eval` — run `forkProject({ from, to, title, dryRun: true })` first; pass `classMap` for multi-class workers                                         |
| Commit & push        | `eval` — `import { commitAndPush } from "@workspace-skills/paneldev"` then `commitAndPush("panels/my-app", "message")`                               |
| Launch panel         | `eval` — `commitAndPush(...)` + `scope.handle = await openPanel(source)`                                                                             |
| Launch worker        | `eval` — `workers.create({ source: "workers/my-worker", contextId })`                                                                                |
| Read a file          | `Read({ file_path: "panels/my-app/index.tsx" })`                                                                                                     |
| Edit a file          | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })`                                                               |
| Check types          | `eval` — `extensions.use("@workspace-extensions/typecheck-service").checkPanel("panels/my-app")`                                                     |
| Run tests            | Not available from panel context — `test.run` is server-only (see TOOLS.md)                                                                          |
| Git status           | `eval` — `import { git } from "@workspace/runtime"; const client = git.client()` (see TOOLS.md)                                                      |
| List workspaces      | `eval` — `workspace.list()`                                                                                                                          |
| Get workspace config | `eval` — `workspace.getConfig()`                                                                                                                     |
| Create workspace     | `eval` — `workspace.create("name", { forkFrom: "default" })`                                                                                         |
| Set init panels      | `eval` — `workspace.setInitPanels([{ source: "panels/my-app" }])`                                                                                    |
| Switch workspace     | `eval` — `workspace.switchTo("name")`                                                                                                                |

## Environment Compatibility

- Panel lifecycle operations (`openPanel`, `listPanels`, `focusPanel`, handle reload/close) require **panel context**.
- Project scaffolding (`createProject`), git operations (`commitAndPush`), and typecheck work in **headless** sessions via eval + RPC.
- `test.run` is restricted to server-origin callers; panel-side eval cannot run tests directly.

## Provenance And Reloads

Workspace runtime units are built from committed git state. If an agent edits a
panel, worker, package, or skill and then observes unchanged runtime behavior,
check provenance before changing the fix:

- Was the edit made in the same context/worktree the runtime imports from?
- Was it committed and pushed?
- Did the build system rebuild that source?
- Did the panel/worker reload after the build?
- In dogfood mode, did the mirror apply or skip because the host checkout was dirty?

Planned hardening: expose a runtime build-provenance API that reports source,
context id, git SHA/ref, dirty state, build timestamp, and artifact id for a
panel/worker/skill/package.

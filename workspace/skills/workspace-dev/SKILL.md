---
name: workspace-dev
description: Build and develop NatStack workspace units — project scaffolding, panels, workers, Durable Objects, runtime publishing, and development workflow.
---

# Workspace Development Skill

Documentation for developing NatStack workspace units, including panels, workers,
packages, skills, and extensions.

For trusted workspace apps under `apps/` (`@workspace-apps/*`, Electron shell,
mobile React Native, or terminal targets), use the `appdev` skill instead.

## Files

| Document                               | Content                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [WORKFLOW.md](WORKFLOW.md)             | Canonical agent workflow: scaffold, open, inspect, edit, push, rebuild/reload, close                                                    |
| [PANEL_API.md](PANEL_API.md)           | Runtime panel API reference                                                                                                             |
| [WORKERS.md](WORKERS.md)               | Workers & Durable Objects: AgentWorkerBase (@workspace/agentic-do), DurableObjectBase, PiRunner, custom shared-resource approval grants |
| [RPC.md](RPC.md)                       | Typed parent-child contracts                                                                                                            |
| [BROWSER.md](BROWSER.md)               | Browser automation (Playwright/CDP)                                                                                                     |
| [TOOLS.md](TOOLS.md)                   | Agent tools reference                                                                                                                   |
| [create-project.ts](create-project.ts) | Project scaffolding and git helpers (importable via eval `imports` parameter)                                                           |

## Interaction Patterns

See the sandbox skill's [INTERACTION_PATTERNS.md](../sandbox/INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. In short: if an action involves choices or could fail, prefer rendering an inline UI that lets the user trigger it and reports results back via `chat.publish`.

## Critical Rules

1. **Relative paths only** — use `panels/my-app/index.tsx`, NEVER `/home/.../workspace/...`
2. **NEVER use Bash** for git, file listing, or file creation — use the structured tools
3. **Use filesystem tools for file edits** — Read, Edit, Write (not eval)
4. **Use eval only for runtime operations** — project creation, git, typecheck, tests, launching panels
5. **Static imports in eval** — `import { rpc, openPanel } from "@workspace/runtime"`; dynamic `await import(...)` may work in some builds, but it is not the supported path for runtime or skill packages.
6. **Close panels you open for temporary work** — keep the one development panel the user is reviewing, but close duplicate, browser, child, and diagnostic panels with `await handle.close()` when done. Use `listPanels()` to reuse existing panels instead of opening another copy.

## Quick Start Workflow

Create a project via eval with the `imports` parameter:

```
eval({ code: `
  import { createProject } from "@workspace-skills/workspace-dev";
  await createProject({ projectType: "panel", name: "my-app", title: "My App" });
`
})
```

Edit the generated files, then publish and launch:

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/workspace-dev";
  import { openPanel } from "@workspace/runtime";
  await commitAndPush("panels/my-app", "Initial launch");
  scope.myApp = await openPanel("panels/my-app");
`
})
```

## Common Tasks

| Task            | How                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create project  | `eval` — `import { createProject } from "@workspace-skills/workspace-dev"` then `createProject({ projectType, name, title })`                             |
| Fork panel      | `eval` — `import { forkProject } from "@workspace-skills/workspace-dev"` then `forkProject({ from: "panels/chat", to: "panels/chat-experiment", title })` |
| Fork worker     | `eval` — run `forkProject({ from, to, title, dryRun: true })` first; pass `classMap` for multi-class workers                                              |
| Publish changes | `eval` — `import { commitAndPush } from "@workspace-skills/workspace-dev"` then `commitAndPush("panels/my-app", "message", { force?: true })`             |
| Launch panel    | `eval` — `commitAndPush(...)` + `scope.handle = await openPanel(source)`                                                                                  |
| Launch worker   | `eval` — `workers.create({ source: "workers/my-worker", contextId })`                                                                                     |
| Read a file     | `Read({ file_path: "panels/my-app/index.tsx" })`                                                                                                          |
| Edit a file     | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })`                                                                    |
| Check types     | `eval` — `extensions.use("@workspace-extensions/typecheck-service").checkPanel("panels/my-app")`                                                          |
| Run tests       | `eval` — `extensions.use("@workspace-extensions/test-runner").run("packages/my-lib")`                                                                     |

`commitAndPush` delegates to `git.publishWorkspaceRepo`. Do not use a bare
`git.client().commit()` as the final step for workspace unit edits; local
context commits do not update the source ref or trigger rebuilds.
| Git status | `eval` — `import { git } from "@workspace/runtime"; const client = git.client()` (see TOOLS.md) |
| List workspaces | `eval` — `workspace.list()` |
| Get workspace config | `eval` — `workspace.getConfig()` |
| Create workspace | `eval` — `workspace.create("name", { forkFrom: "default" })` |
| Set init panels | `eval` — `workspace.setInitPanels([{ source: "panels/my-app" }])` |
| Switch workspace | `eval` — `workspace.switchTo("name")` |

## Environment Compatibility

- Panel lifecycle operations (`openPanel`, `listPanels`, `focusPanel`, handle `rebuildAndReload`/reload/close) require **panel context**.
- Project scaffolding (`createProject`), git operations (`commitAndPush`), typecheck, and test runs work in **headless** sessions via eval + RPC.
- Unit tests run through `@workspace-extensions/test-runner`, not shell commands.

## Provenance And Reloads

Workspace runtime units are built from published git refs. If an agent edits a
panel, worker, package, or skill and then observes unchanged runtime behavior,
check provenance before changing the fix:

- Was the edit made in the same context/worktree the runtime imports from?
- Was the repo published with `git.publishWorkspaceRepo` or `commitAndPush`?
- Did the build system rebuild that source?
- Did the already-open panel run `handle.rebuildAndReload()` after the publish?
- In dogfood mode, did the mirror apply or skip because the host checkout was dirty?

Dirty state is context-local. A running panel can remain dirty in its own
isolated context even after an agent published the same repo path
from another context. Check `contextId` when validating editor or git status
symptoms.

Planned hardening: expose a runtime build-provenance API that reports source,
context id, git SHA/ref, dirty state, build timestamp, and artifact id for a
panel/worker/skill/package.

# Workspace Directory Structure

A NatStack workspace is organized into source directories, each of which becomes an independent git repository. This structure enables isolated context folders where agents can safely read and write files.

## Layout

```
source/
  meta/                 ← Workspace metadata (git repo)
    natstack.yml        ← Workspace config: ID, git port, init panels, OAuth
    AGENTS.md           ← Agent system prompt
  panels/               ← Panel source code
    chat/               ← (git repo) Default chat panel
    my-panel/           ← (git repo) User-created panel
  packages/             ← Shared libraries
    runtime/            ← (git repo) @workspace/runtime
  skills/               ← Agent skill definitions
    sandbox/            ← (git repo) Sandbox execution skill
    paneldev/           ← (git repo) Panel development skill
  agents/               ← Agent configurations
  workers/              ← Workerd Durable Object source
    agent-worker/       ← (git repo) Default AI chat worker
  about/                ← Built-in about/help pages
  templates/            ← Panel/worker scaffolding templates
  projects/             ← Plain editable repos, not runtime units
state/
  .contexts/            ← Per-context folder copies
  .cache/               ← Build cache
  .databases/           ← SQLite databases
```

## The meta/ Directory

`meta/` contains workspace-level configuration that agents need access to:

- **natstack.yml** — Workspace configuration (ID, git server port, OAuth settings, initial panels). Read by the server at startup; agents can read it via `workspace.getConfig()`.
- **AGENTS.md** — The system prompt injected into every agent session. Loaded by the resource loader at agent startup. Agents can also read it directly from `meta/AGENTS.md` in their context folder.

Like every other source directory, `meta/` is a git repo. This means:
- It gets copied into each context folder by the context folder manager
- Agents can commit and push changes back to the workspace source via the internal git server
- Changes pushed to meta/ can trigger rebuilds and config reloads
- Shared git remotes declared under `git.remotes` are materialized into repo
  `.git/config` for source repos and context folders. Prefer
  `git.setSharedRemote(path, { name, url })` for targeted approval and
  propagation instead of editing a context-local remote by hand.

## Context Folders

When a panel or agent session starts, it gets a **context folder** — an isolated copy of the workspace's git repos. Each context folder:

1. Copies the working tree from every git repo in the workspace (panels, packages, skills, meta, etc.)
2. Shares the immutable git object store via symlink (saves disk space)
3. Gets its own mutable git state (HEAD, index, refs) so it can commit independently

This means agents can freely read and write files in their context without affecting the workspace source or other contexts. To propagate changes back, agents commit and push through the internal git server.

## Plain Projects

`projects/` is for repositories that should be editable in the workspace but
are not themselves panels, workers, skills, templates, or packages consumed by
the workspace build system. Examples include upstream application checkouts,
third-party libraries, or larger patch branches an agent is preparing.

Plain projects are still normal workspace git repos:
- They appear in the workspace tree once initialized or cloned.
- They are copied into context folders like other repos.
- Shared remotes declared under `git.remotes.projects.<repo>.<remoteName>` are
  materialized into their `.git/config`.
- `git.importProject({ path: "projects/name", remote })` creates a canonical
  workspace repo from a remote and records the shared remote in `meta/natstack.yml`.
- `git.completeWorkspaceDependencies()` imports configured shared remotes whose
  workspace repos are currently missing.
- They are not launchable runtime units and are not auto-imported as
  `@workspace/*` packages.

## Template vs Live Workspace

The `workspace/` directory in the NatStack source repo is a **template**, never used directly as a live workspace. When a workspace is created:

1. Source directories are copied from the template into `~/.config/natstack/workspaces/{name}/source/`
2. Each subdirectory within the source dirs is initialized as a git repo (`git init` + initial commit)
3. State directories are scaffolded fresh

In dev mode (`pnpm dev`), an ephemeral workspace is created from the template each run.

# Workspace Directory Structure

A NatStack workspace is organized into source directories backed by a shared GAD VCS state graph. This structure enables isolated context folders where agents can safely read and write files.

## Layout

```
source/
  meta/                 ← Workspace metadata
    natstack.yml        ← Workspace config: init panels, external git remotes
    AGENTS.md           ← Agent system prompt
  panels/               ← Panel source code
    chat/               ← Default chat panel
    my-panel/           ← User-created panel
  packages/             ← Shared libraries
    runtime/            ← @workspace/runtime
  skills/               ← Agent skill definitions
    sandbox/            ← Sandbox execution skill
    workspace-dev/           ← Workspace development skill
  agents/               ← Agent configurations
  workers/              ← Workerd Durable Object source
    agent-worker/       ← Default AI chat worker
  apps/                 ← Trusted workspace apps
    shell/              ← @workspace-apps/shell (Electron shell target)
    mobile/             ← @workspace-apps/mobile (React Native target)
    remote-cli/         ← Optional terminal app target shape
  extensions/           ← Trusted Node extension units
    shell/              ← @workspace-extensions/shell
  about/                ← Built-in about/help pages
  templates/            ← Panel/worker scaffolding templates
  projects/             ← Plain editable repos, not runtime units
state/
  .contexts/            ← Per-context folder copies
  .cache/               ← Build cache
  .databases/           ← workerd Durable Object SQL state
```

## The meta/ Directory

`meta/` contains workspace-level configuration that agents need access to:

- **natstack.yml** — Workspace configuration (initial panels and external git remotes). Read by the server at startup; agents can read it via `workspace.getConfig()`.
- **AGENTS.md** — The system prompt injected into every agent session. Loaded by the resource loader at agent startup. Agents can also read it directly from `meta/AGENTS.md` in their context folder.

Like every other source directory, `meta/` is tracked by workspace VCS. This means:

- It is materialized into each context folder
- Agents can commit changes back to their context VCS head
- Changes committed under meta/ can trigger rebuilds and config reloads
- External git remotes declared under `git.remotes` are imported at startup
  when missing, then materialized into `.git/config` for interop checkouts. Prefer
  `git.setSharedRemote(path, { name, url })` for targeted approval and
  propagation instead of editing a context-local remote by hand. See
  [EXTERNAL_GIT_PROJECTS.md](EXTERNAL_GIT_PROJECTS.md) for config shape,
  approvals, branch declarations, and private repo retry behavior.

## Context Folders

When a panel or agent session starts, it gets a **context folder** — an isolated
working tree backed by a context VCS head (`ctx:<contextId>`). Each context can
read and write files without affecting workspace source or other contexts.

Workspace source changes are edit-first: the `edit`/`write` tools (and
`vcs.applyEdits` directly) apply each change as one atomic GAD transition on
your context head and project it to disk, which moves the head, recomputes
effective versions, and triggers rebuilds — so the change is visible to builds
immediately, with no separate commit step. Do not edit via `fs.writeFile` and
expect it to build; a stray write never lands on the head. Existing contexts do
not auto-reset when another context publishes.

## Trusted Apps And Extensions

Apps and extensions use flat source paths. A package named
`@workspace-apps/foo` lives at `apps/foo`; a package named
`@workspace-extensions/bar` lives at `extensions/bar`. Do not add package
scope segments to the filesystem path.

Workspace app targets are:

- `electron` — browser/Electron shell surfaces.
- `react-native` — mobile workspace app bundles.
- `terminal` — supervised Node CLI/client processes for terminal-client style
  tooling.

Capabilities are explicit in `package.json`. Connection management actions
such as minting a pairing invite require the `connection-management`
capability.

For the full trust and client-auth model, see
`docs/trusted-workspace-units.md` in the NatStack source checkout.

For authoring apps, target contracts, capabilities, mobile bootstrap, and
terminal-client guidance, read `skills/appdev/SKILL.md`.

## Plain Projects

`projects/` is for repositories that should be editable in the workspace but
are not themselves panels, workers, skills, templates, or packages consumed by
the workspace build system. Examples include upstream application checkouts,
third-party libraries, or larger patch branches an agent is preparing.

Plain projects are still external Git-backed projects when imported that way:

- They appear in the workspace tree once initialized or cloned.
- They are materialized into context folders like other source trees.
- Shared remotes declared under `git.remotes.projects.<repo>.<remoteName>` are
  materialized into their `.git/config`. Use object declarations with `url` and
  `branch` when a workspace project must clone a non-default branch.
- `git.importProject({ path: "projects/name", remote })` creates a canonical
  workspace project from a remote and records the shared remote in `meta/natstack.yml`.
- Missing configured remotes are imported automatically at startup;
  `git.completeWorkspaceDependencies()` is available as an explicit retry or
  backfill operation.
- They are not launchable runtime units and do not become `@workspace/*`
  packages.

For branch-aware declarations, import approvals, startup auto-import, and
credentialed private repo retries, see
[EXTERNAL_GIT_PROJECTS.md](EXTERNAL_GIT_PROJECTS.md).

## Template vs Live Workspace

The `workspace/` directory in the NatStack source repo is a **template**, never used directly as a live workspace. When a workspace is created:

1. Source directories are copied from the template into `~/.config/natstack/workspaces/{name}/source/`
2. Source directories are ingested into the workspace GAD VCS state graph
3. State directories are scaffolded fresh

In dev mode (`pnpm dev`), an ephemeral workspace is created from the template
each run. Committed workspace-unit edits from that generated workspace are
mirrored back into the checked-in `workspace/` template, so accepted source
changes made during a dev session persist into the source checkout.

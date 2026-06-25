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

- It is readable from any context (materialized into the context folder on demand)
- Agents can edit and commit changes on their context VCS head
- Pushing `meta/` into its `main` triggers rebuilds and config reloads
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

Workspace source changes follow a three-layer build-on-push model on your
context head:

- **edit** — `vcs.edit` (the `edit`/`write` tools) applies each change as one
  atomic GAD transition that lands WORKING content on your context head and
  projects it to disk. No commit, no build, not in `vcs.log`.
- **commit** — `vcs.commit({ message })` folds your uncommitted working edits
  into a per-repo snapshot on the context head. Still no build; `main` does not
  move.
- **push** — `vcs.push({ repoPaths })` is a fast-forward-only advance of `main`,
  gated on a successful build of the committed content. This is the only step
  that produces an authoritative build and recomputes effective versions for the
  workspace. Use `vcs.previewBuild({ repoPaths })` between edit and commit to
  dev-build working content without writing a baseline.

Do not edit via `fs.writeFile` and expect it to build; a stray write never lands
on the head. Existing contexts do not auto-reset when another context pushes.

Context heads are build-addressable, but only when requested explicitly. Use
`ref: "ctx:<contextId>"` (or a `state:<stateHash>` ref) when you intentionally
want to build/test code from that context branch. A generic launch in a context
must omit `ref`: `contextId` gives the runtime access to the context filesystem
and state, while code still comes from the main workspace build.

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
- They are readable from any context (materialized on demand like other source trees).
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
each run. Workspace-unit changes pushed into `main` in that generated workspace
are mirrored back into the checked-in `workspace/` template, so accepted source
changes made during a dev session persist into the source checkout.

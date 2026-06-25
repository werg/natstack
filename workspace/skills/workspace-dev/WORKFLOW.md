# Agent Panel Workflow

Use one runtime concept: `PanelHandle`. `openPanel(source, options)` opens both workspace panels and URLs and returns a handle. In userland, opening a panel is a structural tree mutation and may prompt on first use for the requester entity and parent/root target. `listPanels()` rediscovers existing handles. Keep the handle, then use it to reload the running panel for **runtime/visual** iteration *after* your code is green.

## Versioning is per-repo: edit → commit → push

Each repo (`panels/my-app`, `packages/ui`, `projects/vault`, `meta`) versions
itself on its own log. The dev loop has three layers:

- **edit** (`vcs.edit`, what the `edit`/`write` tools call) records **uncommitted
  working edits** on your context head — tracked and projected to disk, but not a
  commit: no log entry, no head advance, no build.
- **commit** (`vcs.commit({ message })`) folds your working edits into a
  deliberate, messaged snapshot per repo, advancing your context head. `message`
  is mandatory.
- **push** (`vcs.push({ repoPaths: [repo] })`) advances a repo's `main`. `main`
  moves **only** via push. Push is **fast-forward-only** and **build-gated**: it
  builds + type-checks the candidate; if it fails, **no head advances** and you
  get structured diagnostics back (`file:line:col  severity  message`). That
  report is the **primary build signal** — read it and fix the cited lines.

`rebuildAndReload()` is NOT the build gate. It rebuilds and reloads a *running*
panel's renderer for visual iteration at that panel's current build ref:
explicit `ref` if the panel was pinned, otherwise main. It does not infer
`ctx:<contextId>` from the panel context, does not advance `main`, and is not
where you find compile/type errors. Use the push report (or `vcs.previewBuild`)
for "does it build?"; use `rebuildAndReload()` for "what does it look like
running?".

Agents are responsible for panels they open. Keep the primary development panel
open when the user is reviewing it, but close temporary browser panels,
diagnostic panels, duplicate launches, and child panels when finished. Prefer
`listPanels()` and existing handles over opening another panel for the same
source.

## Loop

1. Scaffold with eval:

```ts
import { createProject } from "@workspace-skills/workspace-dev";
await createProject({ projectType: "panel", name: "my-app", title: "My App" });
```

Skip this scaffold step for throwaway project repos. To keep temporary files
context-local, write a file inside a repo-shaped path such as
`projects/tmp-name/note.md`. You can leave it uncommitted, commit it as a local
snapshot, or push it later; `createProject({ projectType: "project" })`
immediately commits and pushes a README.

2. Edit files with the `edit`/`write` filesystem tools, not eval. Each edit is
   recorded as an **uncommitted working edit** on your context head and projected
   to disk. It is tracked but not yet a commit.

3. **Commit a deliberate snapshot.** When the change is a milestone, fold your
   working edits into a commit with `vcs.commit({ message })`. `message` is
   mandatory. You can keep editing and commit several times before shipping.

```ts
import { vcs } from "@workspace/runtime";

const commits = await vcs.commit({ message: "Wire up the form" });
for (const c of commits) console.log(c.repoPath, c.status, c.editCount);
```

   To check what's uncommitted without committing, use `vcs.status(repoPath)`
   (its `uncommitted` count) or preview-build working content with
   `vcs.previewBuild({ repoPaths: [repo] })`. To throw away uncommitted edits,
   `vcs.discardEdits(repoPath)`.

4. **Push to build-gate the change into `main`.** Push is fast-forward-only and
   build-gated: it builds + type-checks the committed candidate; if it fails,
   **no head advances**. Read the report; fix the cited `file:line:col` and push
   again. Do this *before* opening/reloading for the user — a red repo has
   nothing worth shipping. (Push **rejects** if a repo still has uncommitted
   edits — commit first.)

   For a **brand-new** project there is no init: this first push *creates* the
   repo's `main` from empty (the create-project step already did edit→commit→push
   for the scaffold; this is for your subsequent commits). A typo'd `repoPaths`
   entry fails with `unknown repo … has no main and no content`.

```ts
import { vcs } from "@workspace/runtime";

const result = await vcs.push({ repoPaths: ["panels/my-app"] });
if (result.status === "build-failed") {
  // No head advanced. The diagnostics are your task list.
  for (const report of result.reports) {
    for (const build of report.builds) {
      for (const d of build.diagnostics) {
        console.error(`${d.file}:${d.line}:${d.column}  ${d.severity}  [${d.source}] ${d.message}`);
      }
    }
  }
} else if (result.status === "diverged") {
  // main moved past your base — a fast-forward is impossible.
  // Reconcile, then re-commit (if conflicts) and re-push.
  for (const repoPath of result.divergences.map((d) => d.repoPath)) {
    await vcs.merge(repoPath); // pulls main into your head as a merge commit
  }
}
// result.status === "pushed" | "up-to-date" → green; proceed.
```

A `diverged` result means `main` moved past your context's base, so the push
can't fast-forward. Pull `main` into your head with `vcs.merge(repoPath)`; if it
reports conflicts, the markers land in your context files — fix them via
`edit`/`write`, `vcs.commit` to seal the merge, then re-push. A `build-failed`
result means **no head advanced**; never leave the repo red.

5. Open once (after a green push):

```ts
import { openPanel } from "@workspace/runtime";

scope.myApp = await openPanel("panels/my-app", { focus: true });
await scope.myApp.snapshot();
```

6. Iterate visually by reloading the same handle:

```ts
// For runtime/visual iteration of this panel's current build ref. If the panel
// is not explicitly ref-pinned, this is main. rebuildAndReload does not commit,
// does not advance main, and is not the build gate — use vcs.commit + vcs.push
// to ship, or vcs.previewBuild to check a working build.
const lifecycle = await scope.myApp.rebuildAndReload();
console.log(lifecycle);
await scope.myApp.snapshot();
```

`rebuildAndReload()` is the canonical operation to refresh a *running* panel
after edits at the panel's current build ref. It targets exactly the panel named
by the handle's `id`. It does not unload the target's runtime lease and does not
rebuild or reload child panels. If the eval is running inside the target being
reloaded, the eval can be cancelled after the reload command is sent.

Lifecycle method semantics:

| Method               | Build cache               | Renderer                    | Runtime lease | Descendants |
| -------------------- | ------------------------- | --------------------------- | ------------- | ----------- |
| `refresh()`          | unchanged                 | unchanged                   | unchanged     | unchanged   |
| `rebuildPanel()`     | invalidate/rebuild target | unchanged until reload/load | unchanged     | unchanged   |
| `reload()`           | unchanged                 | reload target renderer      | unchanged     | unchanged   |
| `rebuildAndReload()` | invalidate/rebuild target | reload target renderer      | unchanged     | unchanged   |

Before reloading a parent or ancestor, verify the target:

```ts
const info = await handle.refresh().then((h) => h.getInfo());
console.log(info.id, info.source, info.contextId, info.runtimeEntityId, info.effectiveVersion);
```

`effectiveVersion` is the git/effective-version hash for the source currently
running in that panel's active runtime entity. Lifecycle calls return a
structured result with `operation`, `status`, `panelId`, `loaded`, `rebuilt`,
`reloaded`, `buildRevision`, and `effectiveVersion` when the host can report it.

7. Tune running state without reopening:

```ts
await scope.myApp.stateArgs.set({ theme: "dark", mode: "fixture" });
await scope.myApp.setMode("fixture");
```

## Managing Child Panels

Use `listPanels()` from agent eval to see the current tree. Use `handle.children()` to hydrate a fresh child list from a known handle. Close stale children with `handle.close()`.

```ts
import { listPanels } from "@workspace/runtime";

const roots = await listPanels();
for (const panel of roots) {
  console.log(panel.id, panel.kind, panel.source);
}

const children = await scope.myApp.children();
await children[0]?.close();
```

Do not open duplicate panels while iterating. If the source is already open,
reuse the existing handle. Remember that handles carry metadata snapshots; call
`await handle.refresh()` or rediscover with `listPanels()` after rebuild/reload
transitions if the title/source looks like a placeholder slot id.

When a panel was opened only to inspect, test, or collect diagnostics, close it
in `finally`:

```ts
let sitePanel;
try {
  sitePanel = await openPanel("https://example.com", { focus: true });
  const page = await sitePanel.cdp.lightweightPage();
  await page.title();
} finally {
  await sitePanel?.close().catch((err) => console.warn("panel cleanup failed", err));
}
```

## Browser Panels

URLs also use `openPanel`:

```ts
import { openPanel } from "@workspace/runtime";

const sitePanel = await openPanel("https://example.com", { focus: true });
const page = await sitePanel.cdp.lightweightPage();
await page.title();
await sitePanel.close();
```

CDP automation lives under `handle.cdp` and is available for panel-tree targets through the server broker after approval. Use `handle.ensureLoaded()` before RPC to unloaded targets; CDP loads automatically after approval.

## Verification

Use `handle.snapshot()` for an agent-readable view of the running panel. Use `handle.tree()`, `handle.state()`, and `handle.routes()` for deeper workspace-panel inspection. Use typecheck before launch when the change is more than a small text edit.

## Forking Existing Projects

A fork copies an existing repo to a new path **preserving history** — the new
repo's log descends from the source's lineage, so your edits build on top of the
inherited commits (contrast a from-scratch new project, whose first push starts
a clean empty history). `forkProject` is the workspace-dev helper that copies
only trackable workspace source, skips platform/generated artifacts such as
`.gad/`, and rewrites the obvious references. A non-dry run performs edit →
commit → push for the new repo. The lower-level `vcs.forkRepo(fromPath, toPath)`
/ `natstack vcs fork-repo FROM TO` preserves history and rewrites only the
`package.json` `name` leaf so the fork is build-valid, leaving deeper renames
(component/class names, contract sources, DO class bindings) to you.

For panels, inspect the source, dry-run if the source is unfamiliar, then fork:

```ts
import { forkProject } from "@workspace-skills/workspace-dev";

await forkProject({
  from: "panels/source-panel",
  to: "panels/new-panel",
  title: "New Panel",
});
```

For workers, always start with a dry run and review warnings because Durable Object class names and workspace config references may need explicit mapping:

```ts
import { forkProject } from "@workspace-skills/workspace-dev";

const plan = await forkProject({
  from: "workers/source-worker",
  to: "workers/new-worker",
  title: "New Worker",
  dryRun: true,
});
console.log(plan);
```

If the worker has multiple Durable Object classes, apply with an explicit `classMap`. After the fork, `vcs.commit({ message })` then `vcs.push({ repoPaths: [repo] })` to build-gate it (read the report; fix any diagnostics and re-push), then launch the panel or worker. Follow-up edits via the `edit`/`write` tools are uncommitted working edits; `vcs.commit` then `vcs.push` to advance `main`.

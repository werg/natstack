# Agent Panel Workflow

Use one runtime concept: `PanelHandle`. `openPanel(source, options)` opens both workspace panels and URLs and returns a handle. In userland, opening a panel is a structural tree mutation and may prompt on first use for the requester entity and parent/root target. `listPanels()` rediscovers existing handles. Keep the handle, then call `rebuildAndReload()` after committed code changes so the named panel rebuilds and its renderer fetches the rebuilt bundle.

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

2. Edit files with filesystem tools, not eval.

3. Publish and open once:

```ts
import { commitAndPush } from "@workspace-skills/workspace-dev";
import { openPanel } from "@workspace/runtime";

await commitAndPush("panels/my-app", "Initial launch");
scope.myApp = await openPanel("panels/my-app", { focus: true });
await scope.myApp.snapshot();
```

4. Iterate by rebuilding and reloading the same handle:

```ts
import { commitAndPush } from "@workspace-skills/workspace-dev";

await commitAndPush("panels/my-app", "Fix layout");
const lifecycle = await scope.myApp.rebuildAndReload();
console.log(lifecycle);
await scope.myApp.snapshot();
```

`commitAndPush()` publishes through `git.publishWorkspaceRepo`; a bare
`git.client().commit()` is not enough because it does not update the workspace
source ref. `rebuildAndReload()` is the canonical operation after
`commitAndPush()` when the
panel is already open. It targets exactly the panel named by the handle's `id`.
It does not unload the target's runtime lease and does not rebuild or reload
child panels. If the eval is running inside the target being reloaded, the eval
can be cancelled after the reload command is sent.

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

5. Tune running state without reopening:

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
const page = await sitePanel.cdp.playwrightPage();
await page.title();
await sitePanel.close();
```

CDP automation lives under `handle.cdp` and is available for panel-tree targets through the server broker after approval. Use `handle.ensureLoaded()` before RPC to unloaded targets; CDP loads automatically after approval.

## Verification

Use `handle.snapshot()` for an agent-readable view of the running panel. Use `handle.tree()`, `handle.state()`, and `handle.routes()` for deeper workspace-panel inspection. Use typecheck before launch when the change is more than a small text edit.

## Forking Existing Projects

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

If the worker has multiple Durable Object classes, apply with an explicit `classMap`. After the fork, typecheck, launch the panel or worker, then use `commitAndPush` for follow-up edits.

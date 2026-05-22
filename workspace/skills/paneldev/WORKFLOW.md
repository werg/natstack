# Agent Panel Workflow

Use one runtime concept: `PanelHandle`. `openPanel(source, options)` opens both workspace panels and URLs and returns a handle. `listPanels()` rediscovers existing handles. Keep the handle and reload it after code changes.

## Loop

1. Scaffold with eval:

```ts
import { createProject } from "@workspace-skills/paneldev";
await createProject({ projectType: "panel", name: "my-app", title: "My App" });
```

2. Edit files with filesystem tools, not eval.

3. Commit, push, and open once:

```ts
import { commitAndPush } from "@workspace-skills/paneldev";
import { openPanel } from "@workspace/runtime";

await commitAndPush("panels/my-app", "Initial launch");
scope.myApp = await openPanel("panels/my-app", { focus: true });
await scope.myApp.snapshot();
```

4. Iterate by reloading the same handle:

```ts
import { commitAndPush } from "@workspace-skills/paneldev";

await commitAndPush("panels/my-app", "Fix layout");
await scope.myApp.reload();
await scope.myApp.snapshot();
```

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

Do not open duplicate panels while iterating. If the source is already open, reuse the existing handle and call `reload()`.

## Browser Panels

URLs also use `openPanel`:

```ts
import { openPanel } from "@workspace/runtime";

const browser = await openPanel("https://example.com", { focus: true });
const page = await browser.browser.page();
await page.title();
```

Browser automation lives under `handle.browser`. Workspace handles expose the same property, but browser methods throw with a clear error unless `handle.kind === "browser"`.

## Verification

Use `handle.snapshot()` for an agent-readable view of the running panel. Use `handle.tree()`, `handle.state()`, and `handle.routes()` for deeper workspace-panel inspection. Use typecheck before launch when the change is more than a small text edit.

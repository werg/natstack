# Panel API

Import panel APIs from `@workspace/runtime`.

Panel handles are server-mediated APIs. Panels, workers, and Durable Objects can
list, inspect, open, and mutate UI panels through `panelTree`; CDP is served by
the Electron host that currently holds the target panel's runtime lease.
In panel code, import `panelTree` as a top-level runtime export. Do not use
`workspace.panelTree`; `workspace` is the workspace catalog/source/unit
namespace. Use top-level `openPanel` to create panels.

`panelTree` return signatures:

```ts
panelTree.self(): PanelHandle
panelTree.get(id): PanelHandle
panelTree.list(): Promise<PanelHandle[]>
panelTree.roots(): Promise<PanelHandle[]>
panelTree.children(id): Promise<PanelHandle[]>
panelTree.parent(id): PanelHandle | null
panelTree.navigate(id, source, opts?): Promise<{ id: string; title: string }>
openPanel(source, opts?): Promise<PanelHandle>
```

`self()` and `get()` are synchronous handle factories. Do not call `.catch()` on
them; catch errors on async handle methods such as `await handle.refresh()` or
`await handle.getInfo()`.

## Handles

```ts
import { openPanel, listPanels } from "@workspace/runtime";

const handle = await openPanel("panels/my-app", { stateArgs: { mode: "fixture" } });
const lifecycle = await handle.rebuildAndReload();
console.log(lifecycle.status, lifecycle.effectiveVersion);
await handle.stateArgs.set({ mode: "live" });
const snapshot = await handle.snapshot();
await handle.close(); // close temporary panels opened for diagnostics/tests
```

`openPanel(source)` opens a new panel for the main/pushed build; it does not take
a build `ref`. `handle.navigate(source, { ref })` and
`panelTree.navigate(id, source, { ref })` are the ref-capable replacement paths.
Use `ref: \`ctx:${contextId}\`` only when you intentionally want code from that
context branch. `contextId` without `ref` only changes filesystem/storage state.

Inside the current panel, use `panel.reopen({ source?, contextId?, stateArgs? })`
for self-replacement of source/state args/context. `panel.reopen({ contextId })`
does not select code provenance. Use `handle.navigate(source, opts)` or
`panelTree.navigate(id, source, opts)` when intentionally replacing a known panel
slot from another runtime.

`PanelHandle` fields:

| Member                                          | Description                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                                            | Host panel id                                                                                                       |
| `getInfo()`                                     | Copyable metadata `{ id, title, source, kind, parentId, contextId, runtimeEntityId, effectiveVersion, ref, build }` |
| `source`                                        | Workspace source or URL                                                                                             |
| `kind`                                          | `"workspace"` or `"browser"`                                                                                        |
| `children()`                                    | Fresh direct child handles                                                                                          |
| `navigate(source, opts?)`                       | Replace this panel slot with another source/context/stateArgs                                                       |
| `rebuildPanel()`                                | Invalidate/rebuild this workspace panel's bundle; target-only and not recursive                                     |
| `reload()`                                      | Browser-style reload of this panel's current renderer; does not rebuild code                                        |
| `rebuildAndReload()`                            | Rebuild this panel's bundle and reload this panel's renderer; target-only and not recursive                         |
| `close()`                                       | Close this panel                                                                                                    |
| `stateArgs.get()` / `stateArgs.set(updates)`    | Host-owned state args                                                                                               |
| `snapshot()`                                    | Agent-readable AX/synthetic snapshot                                                                                |
| `tree()` / `state()` / `routes()` / `setMode()` | Workspace `_agent` methods                                                                                          |
| `cdp`                                           | Approval-gated CDP automation namespace for panel-tree targets                                                      |
| `click(selector)`                               | Convenience wrapper for `cdp.click(selector)`                                                                       |

## State Args

Inside a panel:

```ts
import { panel } from "@workspace/runtime";

const initial = panel.stateArgs.get();
await panel.stateArgs.set({ theme: "dark" });
```

`panel.stateArgs.set()` persists through the host and immediately applies the
returned, validated snapshot to the caller panel. `panel.stateArgs.use()`
re-renders from that local snapshot and from later host-published
`runtime:stateArgsChanged` events for updates made elsewhere.

From an agent-held handle:

```ts
await handle.stateArgs.set({ theme: "dark" });
const next = await handle.stateArgs.get();
```

Parent handles are regular `PanelHandle`s:

```ts
import { panelTree } from "@workspace/runtime";

const parent = panelTree.self().parent();
if (parent) {
  await parent.refresh(); // hydrate exact source/runtime metadata from the host
  const info = await parent.getInfo();
  const args = await parent.stateArgs.get();
  console.log(info.id, info.source, info.effectiveVersion, args);
}
```

`effectiveVersion` is the exact immutable source version currently associated
with the active panel runtime entity. For git-backed workspace units this is the
commit/effective-version hash used for approvals and runtime identity. Use
`refresh()` before comparing metadata around rebuilds, navigation, or reloads.

Lifecycle calls return:

```ts
type PanelLifecycleResult = {
  panelId: string;
  operation: "reload" | "rebuild" | "rebuildAndReload" | "unload" | "close";
  status: string;
  loaded: boolean;
  rebuilt: boolean;
  reloaded: boolean;
  buildRevision?: number;
  effectiveVersion?: string | null;
};
```

Use `rebuildAndReload()` after committed code changes, or after context-local
changes only when the panel is already pinned to the intended build `ref`. Use
`rebuildPanel()` only when you want to invalidate/prebuild the target bundle
without touching the current renderer. Use `reload()` only when the bundle is
already correct and the target renderer should do a browser-style reload.

## Agent Inspection

Every runtime panel registers `_agent.snapshot`, `_agent.tree`, `_agent.state`, `_agent.routes`, and `_agent.setMode`. Agents should call these through a handle, not directly.

`handle.state()` is empty by default — React component state is not otherwise
reachable from outside the renderer. A panel publishes introspectable state by
registering providers:

```tsx
import { useAgentState } from "@workspace/react";

function Editor() {
  const [doc, setDoc] = useState(initialDoc);
  const [dirty, setDirty] = useState(false);
  useAgentState("editor", { path: doc.path, dirty, length: doc.text.length });
  // A debugging agent: await parent.state()
  // => { editor: { path: "Welcome.mdx", dirty: true, length: 1280 } }
}
```

Outside React, use `agentApi.registerStateProvider(key, () => value)` from
`@workspace/runtime` (returns an unregister function). The latest value is
reported on each `state()` call, so keep providers cheap and side-effect free.

Mobile hosts implement these methods through the WebView bridge. CDP access is
served by CDP-capable Electron hosts through `handle.cdp.lightweightPage()` and
the direct `handle.cdp` navigation helpers. CDP automation works for **any**
panel target — workspace panels and browser panels alike, including the panel
you are running in (`panelTree.self()`). Panels held by non-CDP hosts reject CDP
access instead of being silently taken over. CDP access is still approval-gated
through the `panelCdp` service.
`handle.cdp.lightweightPage()` returns a Playwright-style page driven by our own
lightweight, workerd-native CDP client (`@workspace/cdp-client`). It is the
single browser-automation surface — there is no separate "full Playwright" tier,
and you do not import or install any `playwright*` package. The page exposes
locators (`page.locator`, `page.getByRole`, `page.getByText`, …), auto-waiting
actions (`click`, `fill`, `check`, `selectOption`, …), reads (`innerText`,
`count`, `isVisible`, …), and page-level methods (`goto`, `screenshot`,
`waitForSelector`, `evaluate`, …). For protocol-level work, `import
{ CdpConnection } from "@workspace/cdp-client"` and connect via
`handle.cdp.getCdpEndpoint()`. There is no generic `handle.cdp.page()` alias.
Because the client is workerd-native, `handle.cdp.*` automation works wherever
you hold a panel handle, including server-side eval.

Approval-gated panel operations wait for a visible shell approval decision. If
no decision arrives before the approval deadline, the request fails with an
approval-timeout error. That timeout means the consent prompt was not resolved;
it is not a model prompt timeout.

Agents must close panels they open for temporary diagnostics, setup, scraping,
or tests. Use `try/finally` around `openPanel()` and call `await handle.close()`
when done. The normal exceptions are an explicit user request to leave the
panel open, a primary workspace panel the user asked to build or inspect, or a
workflow that explicitly needs the panel across follow-up calls. Duplicate,
child, URL, and diagnostic panels should not be left open without such a reason.

## Runtime Provenance

Panel handles identify the live panel (`id`, `source`, `kind`). To inspect the
build artifact serving a workspace source, call the host provenance RPC:

```ts
import { rpc } from "@workspace/runtime";

const provenance = await rpc.call("main", "build.inspectBuildProvenance", [handle.source]);
// { source, contextId, gitSha, ref, dirty, builtAt, artifactId }
```

This should be an early check when a panel appears stale after a fix.

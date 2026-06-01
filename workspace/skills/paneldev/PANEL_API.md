# Panel API

Import panel APIs from `@workspace/runtime`.

Panel handles are server-mediated APIs. Panels, workers, and Durable Objects can
list, inspect, open, and mutate UI panels through `panelTree`; CDP is served by
the Electron host that currently holds the target panel's runtime lease.

## Handles

```ts
import { openPanel, listPanels } from "@workspace/runtime";

const handle = await openPanel("panels/my-app", { stateArgs: { mode: "fixture" } });
await handle.rebuildPanel();
await handle.reload();
await handle.stateArgs.set({ mode: "live" });
const snapshot = await handle.snapshot();
```

`PanelHandle` fields:

| Member                                          | Description                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                                            | Host panel id                                                                                                       |
| `getInfo()`                                     | Copyable metadata `{ id, title, source, kind, parentId, contextId, runtimeEntityId, effectiveVersion, ref, build }` |
| `source`                                        | Workspace source or URL                                                                                             |
| `kind`                                          | `"workspace"` or `"browser"`                                                                                        |
| `children()`                                    | Fresh direct child handles                                                                                          |
| `rebuildPanel()`                                | Invalidate/rebuild this workspace panel's bundle; not recursive                                                     |
| `reload()`                                      | Browser-style reload of this panel's current renderer; does not rebuild code                                        |
| `close()`                                       | Close this panel                                                                                                    |
| `stateArgs.get()` / `stateArgs.set(updates)`    | Host-owned state args                                                                                               |
| `snapshot()`                                    | Agent-readable AX/synthetic snapshot                                                                                |
| `tree()` / `state()` / `routes()` / `setMode()` | Workspace `_agent` methods                                                                                          |
| `cdp`                                           | Approval-gated CDP automation namespace for panel-tree targets                                                      |
| `click(selector)`                               | Convenience wrapper for `cdp.click(selector)`                                                                       |

## State Args

Inside a panel:

```ts
import { getStateArgs, useStateArgs, setStateArgs } from "@workspace/runtime";

const initial = getStateArgs();
await setStateArgs({ theme: "dark" });
```

`setStateArgs()` persists through the host and immediately applies the returned,
validated snapshot to the caller panel. `useStateArgs()` re-renders from that
local snapshot and from later host-published `runtime:stateArgsChanged` events
for updates made elsewhere.

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

## Agent Inspection

Every runtime panel registers `_agent.snapshot`, `_agent.tree`, `_agent.state`, `_agent.routes`, and `_agent.setMode`. Agents should call these through a handle, not directly.

Mobile hosts implement these methods through the WebView bridge. CDP access is
served by CDP-capable Electron hosts through `handle.cdp.playwrightPage()`,
or `handle.cdp.lightweightPage()`. Panels held by non-CDP hosts reject CDP
access instead of being silently taken over.
Use `handle.cdp.playwrightPage()` for the vendored `@workspace/playwright-core`
client, or `handle.cdp.lightweightPage()` for the smaller wrapper. There is no
silent fallback between them and no generic `handle.cdp.page()` alias. Use
these APIs instead of eagerly importing Playwright in panel UI code.

Approval-gated panel operations wait for a visible shell approval decision. If
no decision arrives before the approval deadline, the request fails with an
approval-timeout error. That timeout means the consent prompt was not resolved;
it is not a model prompt timeout.

## Runtime Provenance

Panel handles identify the live panel (`id`, `source`, `kind`). To inspect the
build artifact serving a workspace source, call the host provenance RPC:

```ts
import { rpc } from "@workspace/runtime";

const provenance = await rpc.call("main", "build.inspectBuildProvenance", [handle.source]);
// { source, contextId, gitSha, ref, dirty, builtAt, artifactId }
```

This should be an early check when a panel appears stale after a fix.

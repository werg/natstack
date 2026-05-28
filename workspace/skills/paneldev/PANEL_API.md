# Panel API

Import panel APIs from `@workspace/runtime`.

Panel handles are server-mediated APIs. Panels, workers, and Durable Objects can
list, inspect, open, and mutate UI panels through `panelTree`; CDP is served by
the Electron host that currently holds the target panel's runtime lease.

## Handles

```ts
import { openPanel, listPanels } from "@workspace/runtime";

const handle = await openPanel("panels/my-app", { stateArgs: { mode: "fixture" } });
await handle.reload();
await handle.stateArgs.set({ mode: "live" });
const snapshot = await handle.snapshot();
```

`PanelHandle` fields:

| Member | Description |
|--------|-------------|
| `id` | Host panel id |
| `source` | Workspace source or URL |
| `kind` | `"workspace"` or `"browser"` |
| `children()` | Fresh direct child handles |
| `reload()` | Rebuild/remount the panel |
| `close()` | Close this panel |
| `stateArgs.get()` / `stateArgs.set(updates)` | Host-owned state args |
| `snapshot()` | Agent-readable AX/synthetic snapshot |
| `tree()` / `state()` / `routes()` / `setMode()` | Workspace `_agent` methods |
| `cdp` | Approval-gated CDP automation namespace for panel-tree targets |

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

## Agent Inspection

Every runtime panel registers `_agent.snapshot`, `_agent.tree`, `_agent.state`, `_agent.routes`, and `_agent.setMode`. Agents should call these through a handle, not directly.

Mobile hosts implement these methods through the WebView bridge. CDP access is
served by CDP-capable Electron hosts through `handle.cdp.page()`. Panels held by
non-CDP hosts reject CDP access instead of being silently taken over.

## Runtime Provenance

Panel handles identify the live panel (`id`, `source`, `kind`) but do not yet
prove which build artifact is running. Until a build-provenance API exists, use
git status, commit/push state, typecheck/build output, and panel reload timing
to verify that a running panel has consumed your source change.

Target design for provenance inspection:

```ts
const provenance = await runtime.inspectBuildProvenance({ source: handle.source });
// { source, contextId, gitSha, ref, dirty, builtAt, artifactId }
```

This should become the first check when a panel appears stale after a fix.

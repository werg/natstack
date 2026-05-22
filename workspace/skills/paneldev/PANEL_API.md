# Panel API

Import panel APIs from `@workspace/runtime`.

Panel handles are host APIs. They require an Electron or mobile shell bridge;
server/headless runtimes cannot create, list, inspect, or mutate UI panels
unless they are executing inside a host-provided panel runtime.

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
| `browser` | Browser automation namespace for URL panels |

## State Args

Inside a panel:

```ts
import { getStateArgs, useStateArgs, setStateArgs } from "@workspace/runtime";

const initial = getStateArgs();
await setStateArgs({ theme: "dark" });
```

From an agent-held handle:

```ts
await handle.stateArgs.set({ theme: "dark" });
const next = await handle.stateArgs.get();
```

## Agent Inspection

Every runtime panel registers `_agent.snapshot`, `_agent.tree`, `_agent.state`, `_agent.routes`, and `_agent.setMode`. Agents should call these through a handle, not directly.

Mobile hosts implement these methods through the WebView bridge. Android hosts
also expose an in-app WebView CDP proxy for `handle.browser.page()` when the
WebView debugging backend is available. iOS WebViews do not provide CDP.

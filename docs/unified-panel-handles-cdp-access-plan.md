# Unified Panel Handles + Approval-Gated CDP/RPC Access — Implementation Plan

> Handoff plan for an implementing agent. NatStack is pre-release; prefer clean
> architecture over backward compatibility. All file:line references are anchors, not
> exact targets — re-confirm before editing.

## 1. Context & problem

NatStack is an Electron tree-browser: the UI is a tree of "panels" (each an Electron
`WebContentsView`), plus non-visual participants — workers and Durable Objects (DOs) —
sharing one userland runtime. Today's connectivity model is fragmented and restrictive:

- **Two divergent handle types.** `ParentHandle` (`workspace/packages/runtime/src/core/types.ts:119-162`)
  is RPC-only (`id/call/emit/onEvent`, with typed-contract generics). `PanelHandle`
  (`workspace/packages/runtime/src/panel/handle.ts:15-34`) is control/metadata/CDP only, with
  *no* RPC. A child can RPC its parent but can't CDP it; a parent can CDP a child but the two
  surfaces don't match.
- **CDP is ancestor→descendant + browser-kind only.** `cdpServer.canAccessBrowser()`
  (`src/main/cdpServer.ts:204`) grants only the owner + tree ancestors;
  `browserAutomation.ts:26` (`assertBrowser`) throws unless `kind === "browser"`. A child
  cannot drive its parent and siblings cannot drive each other.
- **No approval on CDP today.** The only capability approval is `externalOpenService`
  (system-browser opens). CDP attach is gated purely by ancestry + a short-lived token. This
  plan adds the missing approval gate.
- **Workers/DOs are second-class.** They expose only `getParent()`; they lack
  `getPanelHandle`/`listPanels`/`openPanel`. (Arbitrary peer-to-peer RPC routing already
  works — `src/server/rpcServer.ts:1999 checkRelayAuth` returns OK unconditionally — and the
  CDP service policy already lists `worker`/`do`.)
- **No load lifecycle for connecting.** On startup only the focused panel gets a live view
  (`src/main/panelOrchestrator.ts:720 initializePanelTree` + `restorePolicy`); other tree
  members exist in the registry with no `webContents`, and `unloadPanel` tears views down.
  CDP to such a panel fails.

**Goal.** One unified handle abstraction obtainable for *any* panel-tree member from a
`panelTree` API, usable by panels, workers, and DOs, where any live panel can be driven over
CDP/RPC — with **all CDP and control/destructive operations gated by an interactive user
approval** (remembered per requester→target; escalated for privileged targets) — and
**transparent loading** of unloaded targets when CDP is accessed.

## 2. Decisions (settled with product owner)

1. **Full unification:** merge `ParentHandle` into a single `PanelHandle`; remove
   `ParentHandle`. `parent` becomes a `PanelHandle`.
2. **`panelTree` API** for arbitrary tree members, exported into panel, worker, and DO
   runtimes. Workers/DOs are **first-class clients** — including CDP — via the server-proxied
   system (§10/§3); they reach it on their existing server connection, no special bridging.
   They can never be CDP/RPC *targets* (no `webContents`).
3. **All CDP + control/destructive ops are approval-gated for every target, including
   parent→child.** The tree relationship buys no bypass. Only the trusted shell/host
   principal bypasses (it can't prompt itself). Approvals are **remembered per
   requester→target** (one-time consent per pair).
4. **Privilege is a severity input, not a wall.** `shell: true` targets are attachable, but
   gated ops on them require a **severe** (danger-tone) approval vs. a *standard* one.
5. **Open (never prompts):** read/metadata, `ensureLoaded`/`focus`, and consensual RPC
   `call`/`emit`/`onEvent` to methods the target *chose* to expose.
6. **Approvals are always interactive.** We do **not** build a headless / non-interactive /
   pre-grant path. A human is present to approve; if no approver responds, the op is denied.
7. **Transparent loading, CDP-only:** accessing `handle.cdp.*` transparently ensures the
   target is loaded first. An explicit `ensureLoaded()` remains for non-CDP needs (e.g.,
   before RPC to an unloaded panel).
8. Rename the automation namespace `handle.browser.*` → `handle.cdp.*`, and `browser`→
   `target`/`panel` throughout the CDP layer.
9. **(Scope extension, §9) Multi-host model with an always-on headless host as the default
   home.** Panel runtimes are held by exactly one *host* via the existing server-arbitrated
   lease; an always-connected headless Electron host is the default lessee for any panel no
   interactive client has taken over, so CDP/agentic work has a CDP-capable home with zero
   interactive clients. Note 6 (interactive approvals) still holds — headless *hosting* is not
   headless *approval*; a human still approves the automate/structural grant.
10. **(§3/§4) All CDP is proxied through the server.** Remove the direct Electron-main CDP
    server; the server owns a single CDP broker (generalize `cdpBridge`), Electron hosts connect
    as debugger providers exposing their `webContents.debugger`, and **auth reuses the server's
    in-process capability/approval system exactly** — one auth site, no cross-process hop. The
    CDP connection just **errors out** if the target/host goes away (no reconnect). Tradeoff:
    desktop-local CDP traffic now hops through the server instead of a direct loopback —
    accepted for the uniformity and for first-class worker/DO + headless access. The vestigial
    browser-extension provider is verified and removed.

## 3. Architecture: one server-proxied CDP system (READ FIRST — load-bearing)

**Decision: all CDP is proxied through the server. There is no direct client↔host CDP and no
main-local CDP server.** The server owns a single CDP *broker*; Electron hosts (desktop main,
headless §9) connect to it as *debugger providers* exposing their local `webContents.debugger`;
clients (panels, workers, DOs) connect as CDP clients. Auth/approval runs **in-process in the
server**, reusing the existing capability system — so the cross-process approval gymnastics of
earlier drafts are gone, and workers/DOs are first-class (they already have a server
connection).

What this replaces / builds on:
- **Remove** the standalone Electron-main CDP server (`new CdpServer()`, `index.ts:1099`): today
  desktop clients connect directly to a main loopback WS that attaches `webContents.debugger`.
  Its attach/forward logic *migrates into the host provider agent* (§4.4).
- **Keep** the server broker — it already has the right shape: `cdpBridge`
  (`src/server/cdpBridge.ts`, wired at `panelHttpServer.ts:339`) brokers between Playwright
  clients (`/cdp/{browserId}`) and a *debugger provider* (`/api/cdp-bridge`).
- **Replace the provider.** The current provider is a browser extension driving
  `chrome.debugger` (`extension/background.js`) — **believed dead / non-functional; verify and
  remove.** The new provider is the Electron host agent (§4.4).

New shape:
```
Client (panel/worker/DO, Playwright)
  → Server CDP broker   /cdp/{browserId}    ← in-process auth: accessDecision + capability approval
  → Host CDP provider   /api/cdp-host        ← the lease-holding Electron host (main or headless)
  → webContents.debugger → panel WebContentsView
```
The broker routes a client's `/cdp/{browserId}` connection to whichever host currently **holds
the lease** for that browser (the lease coordinator already tracks holders, §9). A
**mobile-held** target has no provider (device WebView, server can't bridge) → reject (§9.4).
The CDP connection simply **errors out** if its host provider disconnects or the lease moves
away — no reconnect logic.

(CORS is unrelated and stays as-is: it is genuinely main-originated, firing inside main's
`webRequest` interception, and keeps its `serverClient` hop — `src/main/index.ts:409-435`.)

## 4. Authorization + approval — the core refactor

### 4.1 Shared policy module (single source of truth)
Extract one pure function into `packages/shared` (e.g. `panelAccessPolicy.ts`):

```
accessDecision(op, requester, target) -> {
  allow: boolean,
  capability?: "panel.automate" | "panel.structural",
  severity?: "standard" | "severe",
}
```

- **Op classes:**
  - *open* (no capability): read/metadata, `ensureLoaded`, `focus`, consensual RPC
    `call`/`emit`/`onEvent`.
  - *automate* (`panel.automate`): `cdp.*`, `navigate`, `reload`, `goBack`, `goForward`,
    `stop`.
  - *structural* (`panel.structural`): `archive`, `close`, `unload`, `movePanel`, `takeOver`,
    `openDevTools`, `rebuildPanel`, `updatePanelState`/`stateArgs.set`.
- **Severity:** `severe` iff target is privileged (`shell:true`), else `standard`.
- **Bypass (allow, no capability):** requester is the trusted shell/host
  (`CallerKind` `shell`/`shell-remote`, or a requester whose own panel is `shell:true`).
- **No relationship bypass.** Parent→child automate/structural still requires approval.

The server CDP broker (§3) consumes this one function, in-process. There is no per-process
divergence anymore — auth happens in exactly one place.

Two capabilities, because CDP attach already confers total in-panel control (so gating
individual drive verbs is pointless — shared `panel.automate`), but *structural* ops mutate
the tree/host and must not be silently authorized by an automate grant (`panel.structural`).

### 4.2 Reuse the server capability system, in-process
Do **not** call `userlandApprovalService` directly. Use `requestCapabilityPermission`
(`src/server/services/capabilityPermission.ts`) — the same helper behind `cors-response-read`
and `external-browser-open`. Because the CDP broker now lives **in the server**, this is a
direct in-process call: no `serverClient` hop, no main-local token, no impersonation. It
provides scoped grants (`once`/`session`/`version`) + revocation via `CapabilityGrantStore`,
danger tone for severe, and dedup keys; the grant keying gives "remembered per requester→target"
for free; prompts surface through the existing pipeline (`ApprovalQueue` emits
`shell-approval:pending-changed`, `approvalQueue.ts:291`; `approvalPushBridge.ts` delivers to
the shell renderer). This is the "reuse the server auth system exactly" requirement.

### 4.3 Server CDP broker: endpoint + in-process auth

`getCdpEndpoint` becomes a **server service** (policy `allowed: ["panel","worker","do"]`); every
client reaches it on its own RPC connection, so `ctx.caller` is the genuine requester. It:
1. runs §4.1 `accessDecision("cdp", requester=ctx.caller, target)`;
2. if a capability is required, runs `requestCapabilityPermission` **in-process** (§4.2) —
   prompts on first use, instant on a remembered grant; deny → reject `"CDP access denied"`;
3. ensures a CDP-capable host holds the target (transparent `ensureLoaded` via lease
   assignment, §8/§9) — a mobile-held target has no provider → reject `cdp_unavailable_mobile_held`;
4. mints the server-local `CdpGrantService` handshake token (binds this mint to the next WS
   connect) and returns `{ wsEndpoint: ws://<server>/cdp/{browserId}, token }`.

The client connects to `/cdp/{browserId}` with the token; the broker redeems it (server-local)
and routes the stream to the holding host's provider (§4.4). This **replaces** the old
`canAccessBrowser` (ancestry) and `panelOwnsBrowser` (owner) predicates entirely — authorization
is now `accessDecision` + the capability grant, evaluated once in the server.

**Drive/structural verbs** (`navigate`/`reload`/… and `close`/`archive`/…) are gated by the same
`accessDecision` in the server; `panel.structural` is distinct so an automate grant never
authorizes them. Structural ops mutate server-authoritative registry/lease state (§6), so hosts
converge via the existing lease/registry event sync — no reverse server→main request routing.

**The handshake token** (`CdpGrantService`, `packages/shared/src/cdpGrants.ts`) is opaque,
single-use, 60s, **server-local** — it only ties a mint to its immediately-following WS connect.
It is **not** the authorization of record; the durable, revocable authorization is the
capability grant in `CapabilityGrantStore` (§4.2), re-evaluated on every `getCdpEndpoint`.

**SDK (transparent to callers):** `handle.cdp.page()` calls the `getCdpEndpoint` server service
(which prompts if needed) and connects — the caller writes nothing about approval or loading.

### 4.4 Host CDP provider agent (replaces the extension)

Each Electron host (desktop main, and the headless host §9) runs a small **CDP provider** that
connects to the broker's provider endpoint (as the extension did at `/api/cdp-bridge`; detailed
design in §14),
authenticates with its host/admin token, registers the `browserId`s it currently holds (per the
lease), and forwards CDP commands to its local `webContents.debugger`, streaming events back.
This is the *existing* `cdpServer` machinery — `ensureDebuggerAttached`, `sendDebuggerCommand`,
the per-target serialized `debuggerCommandQueues`, the `Page.captureScreenshot` handling
(`cdpServer.ts:343-520`) — **moved out of the standalone main server into the provider**,
reusing `cdpBridge`'s provider-side protocol (`handleExtensionConnection`,
`cdp:command`/`cdp:result`/`cdp:event`, `cdpBridge.ts:422-636`).

- **Delete** the standalone main `CdpServer` WS (`index.ts:1099`).
- **Verify the browser-extension provider is dead** (`extension/background.js`,
  `/api/cdp-bridge`); if so, remove it. Either way the broker stays and the provider role is
  taken over by the host agent.
- **Host-side AX/snapshot** (`getAccessibilityTree`, `cdpServer.ts:259`) moves into the provider
  (or stays in main using the same per-target queue) — preserve the single-session per-target
  command serialization through the `browser`→`target` rename (§7).
- **Screenshots** work natively: the provider runs `Page.captureScreenshot` against its
  `webContents`; the headless host uses Electron offscreen rendering / native capture, so no
  `withViewVisible` window dance is required (§9).

## 5. Unified `PanelHandle`

Define one type in `workspace/packages/runtime/src/core/types.ts` (merging today's
`PanelHandle` + `ParentHandle`):

- **Metadata stays synchronous `readonly` props** (`id`, `title`, `source`, `kind`,
  `parentId`) — do NOT convert to async getters (that breaks every consumer). A bare
  `panelTree.get(id)` returns a handle with placeholder metadata (today's `getPanelHandle`
  pattern, `handle.ts:152`); fully-hydrated handles come from `list()`/`children()`. Add an
  async `refresh()` to (re)populate metadata for a bare handle.
- **RPC:** `call: TypedCallProxy<Exposed>`, `emit`, `onEvent` — generalize
  `createParentHandle` (`workspace/packages/runtime/src/shared/handles.ts:10-31`) from
  `parentId` to any target id.
- **Typed contracts:** `withContract(contract, role)` where `role` resolves which side of the
  (asymmetric) `defineContract` `.call` exposes (`child.methods` vs `parent.methods`): a
  handle to my parent exposes parent methods; to my child, child methods. Keep
  `getParentWithContract` as a thin alias (`= parent.withContract(contract, "parent")`).
- **Tree:** `children()`, `parent()`.
- **Lifecycle:** `ensureLoaded()`, `isLoaded()`, `reload()`, `close()`, `focus()`.
- **State + introspection:** `stateArgs.get/set`, `snapshot()`, `tree()`, `state()`,
  `routes()`, `setMode()`.
- **Automation:** `cdp: CdpAutomation` (renamed from `browser`, see §7).

Remove `ParentHandle`, `noopParent`'s special shape (replace with a unified no-parent
handle), and the separate `ParentHandleFromContract` path. `parent.cdp.*`, `parent.call.*`,
`parent.emit(...)` all work uniformly.

## 6. `panelTree` API (panel + worker + DO runtimes)

```
panelTree.self(): PanelHandle
panelTree.get(id): PanelHandle            // sync; placeholder metadata until refresh()
panelTree.list(): Promise<PanelHandle[]>
panelTree.roots(): Promise<PanelHandle[]>
panelTree.children(id): Promise<PanelHandle[]>
panelTree.parent(id): PanelHandle | null
panelTree.open(source, opts): Promise<PanelHandle>
```

Wraps `packages/shared/src/panelRegistry.ts` (`listPanels`/`getChildren`/`findParentId`).

**Two-service split (do NOT widen the shell service).** The existing
`src/main/services/panelShellService.ts` stays **shell-only** with full unguarded access (it
backs the trusted shell renderer, reachable over Electron IPC). Add a **new userland panel
service on the server** (policy `allowed: ["panel","worker","do"]`) that runs every op through
§4.1 `accessDecision`, and when a capability is required, runs §4.3 approval **in-process**.

**Server-authoritative, host-converging — no reverse server→main routing.** Structural ops
(`open`/`close`/`archive`/`move`/`ensureLoaded`) mutate server-authoritative **registry + lease**
state (`panelRegistry`, `panelRuntimeCoordinator`); the Electron hosts already converge on that
state via the existing lease/registry event sync (`syncRuntimeLeaseSnapshot` /
`applyRuntimeLeaseChanged`, `panel:runtimeLeaseChanged`). So a worker/DO/panel calls the server
service on its own connection and the holding host reacts — the same event-driven pattern the
orchestrator already uses, requiring **no** worker→main IPC and **no** new server→main request
relay (which confirmed-does-not-exist). `handle.ts` `panelCall` routes to this server service
over RPC for all runtimes; the shell renderer keeps its IPC fast-path to `panelShellService`.

Export `panelTree` + `PanelHandle` from `workspace/packages/runtime/src/panel/index.ts`,
`worker/index.ts`, and `worker/durable-base.ts`.

## 7. CDP layer: client API, privileged tracking, naming

- **Client** (`workspace/packages/runtime/src/panel/browserAutomation.ts`): drop the `kind`
  param and `assertBrowser` (and its 7 call sites); rename → `createCdpAutomation` /
  `CdpAutomation`. It obtains the endpoint from the **`getCdpEndpoint` server service** (§4.3)
  on its own RPC connection — not via the Electron IPC fast-path — and connects to the server
  broker, so panels, workers, and DOs all use one path. (The `globalThis.__natstackShell` IPC
  fast-path for CDP goes away.)
- **Privileged tracking** (severity input, not exclusion): add `privileged?: boolean` to
  `PanelSnapshot` (`packages/shared/src/types.ts:~217`) and `createSnapshot`
  (`packages/shared/src/panel/accessors.ts:116`), set from `manifest.shell` where the snapshot
  is built (`packages/shared/src/shell/panelManager.ts:236-243`, mirroring
  `autoArchiveWhenEmpty`; also `packages/shared/src/panelFactory.ts:182`).
- **Registration / root:** `registerBrowser`→`registerTarget(panelId, wcId, { privileged })`
  (`src/main/cdpServer.ts:126`, called from `src/main/panelView.ts:156/235`); keep a
  `privilegedTargets: Set`. Remove the `if (parentId)` guard at `panelView.ts:154/233` so the
  root panel is also a registered target.
- **Rename** `browser`→`target`/`panel` across the server broker (`cdpBridge.ts`), the host
  provider agent (migrated `cdpServer.ts` logic, §4.4), `panelView.ts`, and the registration
  path. **Caution:** the provider also serves host-side `getAccessibilityTree`/snapshots over
  the same single debugger session (`debuggerCommandQueues`); the rename must preserve the
  per-target command serialization.

## 8. Transparent loading (CDP-only) + explicit `ensureLoaded`

Most of the handle is **host/registry-served** and works while the target is unloaded
(`panelCall` → `shell.panel[method]`): metadata, `children()`/`parent()` (`list`),
`stateArgs.get/set` (host-persisted), `close()`, `isLoaded()`. Only **live-only** ops need the
target's runtime: `cdp.*`, RPC `call`/`emit`, and `_agent` introspection
(`tree`/`state`/`routes`/`setMode`, `handle.ts:89-92`).

- Add `PanelOrchestrator.ensureLoaded(panelId): Promise<LoadResult>` reusing the private
  `loadPanelIntoView` (`src/main/panelOrchestrator.ts:1056`) **without** focus/visibility/event
  side effects (idempotent; `{loaded, reason}`: already_loaded / not_in_registry /
  build_error / view_creation_failed). Inverse of `unloadPanel`. **Verify** a not-yet-visible
  `WebContentsView` is debugger-attachable so loading-without-focus still permits CDP.
- **"Loaded" is now host/lease-scoped (§9).** A panel's live runtime is held by exactly one
  *host* via the existing server-arbitrated lease (`panelRuntimeCoordinator`). `ensureLoaded`
  means "ensure a CDP-capable host holds this panel" — with the always-on headless host (§9)
  this is nearly always already true, so `no_host` should not arise; a panel currently leased
  by a non-CDP client (mobile) yields a `leased_elsewhere` result and the take-over policy
  in §9 decides what happens.
- **Transparent on CDP access:** the **`getCdpEndpoint` server service** (§4.3), after the
  grant check passes, ensures a CDP-capable host holds the target — by assigning/confirming a
  lease (the default headless host, §9, or a desktop host) so the host loads the panel via its
  existing lease-acquisition path. `handle.cdp.page()` on an unloaded panel just works, with no
  caller action and no reverse server→main request (it's lease-driven). Loading runs *after*
  the grant check (never load a panel the requester isn't authorized to drive).
- **Explicit `ensureLoaded()` / `isLoaded()`** stay on the handle (open class — no prompt) for
  non-CDP needs, e.g. before RPC `call`/`emit` to an unloaded panel. Documented, but CDP
  examples no longer need to call it (transparency handles them). RPC/`_agent` do **not**
  auto-load — callers use the explicit primitive there.

## 9. Execution surfaces, hosts & the always-on headless host (scope extension)

This section generalizes "loading" from a single implicit desktop host to a multi-host model
with an always-connected headless host as the default home for panel runtimes. Approved as an
explicit scope extension.

### 9.1 What exists today (the seam we build on)
- **`PanelOrchestrator` exists only in desktop Electron main** (`src/main/index.ts`); the
  server has **no** orchestrator and **no** view host (no `WebContentsView` under `src/server`).
  Mobile renders panels in iOS WebViews and has **no CDP** (`bridgeAdapter.ts:135`). So CDP +
  view loading is an Electron-`WebContentsView` capability.
- The orchestrator is already decoupled from its render surface via an injected
  `getPanelView()` returning a `PanelViewLike` (`panelOrchestrator.ts:65,118`); if absent it
  **silently no-ops** (`loadSnapshotIntoView`: `const view = this.getPanelView(); if (!view)
  return;`).
- A **server-arbitrated runtime-lease system already exists**: `src/server/panelRuntimeCoordinator.ts`
  + `services/panelRuntimeService.ts` is the authority. The orchestrator
  `syncRuntimeLeaseSnapshot()` / `applyRuntimeLeaseChanged()` and, on transfer, unloads its
  local view (`unloadPanelIfPresent(slotId, "lease-transfer")`); it reports `leased_elsewhere`
  + `holderLabel`, and supports `acquire` vs `takeOver` (`panelOrchestrator.ts:693-702,
  844-900`). Leases are **exclusive**: one host holds a panel's live runtime at a time.
- **`shellPresenceService`** already tracks connected interactive clients
  (`isAnyShellActive()` / `getActiveShellCount()`, heartbeat, 6s prune).

### 9.2 The model: hosts as lease holders, headless as default home
- A **host** is anything that can instantiate a panel's runtime and offers a `PanelViewLike`:
  interactive desktop Electron, (future) headless host, mobile WebView. Each host runs the
  lease-syncing orchestrator and acquires the lease for panels it instantiates; the server
  coordinates exclusivity. CDP-capable hosts = Electron-based (desktop, headless); **mobile is
  not** CDP-capable.
- **Always-on headless host = the default lessee.** A panel that no interactive client has
  leased is held by the headless host. When a desktop/mobile client wants to *display* it, it
  `takeOver`-leases (existing path → headless unloads via `lease-transfer`); when that client
  releases or disconnects, the panel **falls back** to the headless host (re-acquire). This is
  policy on top of the existing coordinator, not new transport.
- **Spin-up policy:** the headless host is the default *target* for spin-up; load **lazily**
  (when a panel must be live for CDP/RPC/agent work and no client holds it) rather than eagerly
  instantiating the whole tree, plus idle teardown to bound resource use. Eager-restore can be
  a tunable (`panelRestorePolicy` already exists, default `"focused"`).

### 9.3 Implementation: headless host = headless Electron (Option A)
Run the **existing** `PanelOrchestrator` + `cdpServer` in a **windowless Electron main** with
an offscreen `PanelViewLike` (hidden/offscreen `WebContentsView`). This reuses the entire
view + debugger + CDP stack unchanged — one code path — versus Option B (a Chromium-in-Node
host + parallel orchestrator/CDP in the server), which doubles the rendering stack. The
headless host connects to the server like any other client, is **always present**, and
registers as a host the lease coordinator can assign to.

### 9.4 How this resolves the CDP/loading questions
- **Client-awareness:** host selection becomes explicit. Extend `shellPresenceService` (or add
  a host registry) to report host **capabilities** (hosts-views, supports-CDP) so a request
  resolves to a concrete holder. CDP requests resolve to a CDP-capable holder.
- **No-client case disappears:** because the headless host is always connected and CDP-capable,
  every unleased panel has a CDP-ready home — agentic/background automation works with zero
  interactive clients. `ensureLoaded`'s `no_host` becomes effectively unreachable.
- **CDP vs. current holder:** desktop-held → attach there (the instance the human sees);
  headless-held → attach to the invisible instance; **mobile-held → not CDP-capable, so the
  automate request is rejected** (for now) with a clear error
  (`cdp_unavailable_mobile_held` / "target is open on a mobile client that does not support
  CDP"). No silent take-over — we will not yank a panel off someone's device. (Future option,
  not built: an explicit user-initiated hand-off that take-over-leases it to the headless
  host.)

### 9.5 Hard problems to flag (not hand-wave)
- **Leasing is re-instantiation, not live migration.** A lease transfer unloads then reloads
  the panel on the new host; in-memory DOM/JS state is lost (only persisted `stateArgs`/registry
  state survives). This matches today's `lease-transfer` unload behavior, but "move a panel to
  a client" must be understood as re-instantiation.
- **Holder change mid-automation → just error out** (decided). If the holder changes (a human
  takes over a headless-driven panel, or vice-versa), the provider for that `browserId`
  disconnects from the broker and the client's CDP connection **errors and closes** — no
  reconnect, no lease-holding. The caller handles the error and may re-acquire. Simple and
  user-first (a human can always take over their panel).
- **Two orchestrators, one tree.** Headless + desktop both run orchestrators; tree-mutation ops
  (open/close/move) stay single-authority — they mutate the server registry/lease (§6) and hosts
  converge, so confirm no host-local divergence.
- **Resource bounds:** headless host accumulating live web contents → enforce lazy load + idle
  GC + a cap.

### 9.6 Suggested phasing
The server CDP broker + host provider agent (§4.3/§4.4) is the desktop host's day-one provider,
so it is **not** deferred — it replaces the standalone main `CdpServer` in the core work. The
*headless host* is the scope extension: (a) host-capability presence (hosts-views/supports-CDP);
(b) a windowless Electron host running the existing orchestrator **and a CDP provider agent**;
(c) default-lessee + fallback-on-release policy in `panelRuntimeCoordinator`; (d) the
mobile-held-target reject (§9.4). Lease-change handling is just "error the CDP connection" (§9.5)
— no extra SDK work. The lease coordinator, lease-transfer unload, and presence service already
exist, so the headless extension is mostly policy + the windowless host process.

## 10. Docs & tests

- **Docs/skills:** rewrite Browser Automation sections to use `panelTree.get(id)` →
  `handle.cdp.page()` (no explicit load needed for CDP); document that the first
  automate/structural op triggers an approval (remembered per pair, severe for privileged);
  show child→parent (`panelTree.self().parent()`) and sibling examples; document explicit
  `ensureLoaded()` for the RPC-to-unloaded case. Files: `PANEL_DEVELOPMENT.md:291-352`,
  `PANEL_SYSTEM.md` runtime-API list, `workspace/skills/*/{BROWSER,EVAL,WORKFLOW*}.md`,
  `workspace/packages/playwright-core/INTEGRATION_TEST_EXAMPLE.ts`.
- **Tests:** `src/server/cdpBridge.test.ts` (broker auth + client/provider routing), a new host
  CDP **provider agent** test (migrated `cdpServer` attach/forward/queue/screenshot logic),
  `workspace/packages/runtime/src/panel/handle.test.ts` (remove kind-gating reject at `:59`;
  rename `.browser`→`.cdp`; unified RPC+cdp surface), `packages/shared/src/cdpGrants.test.ts`,
  plus a new **`getCdpEndpoint` server-service** test (in-process `accessDecision` +
  `requestCapabilityPermission`) and shared-policy tests for `accessDecision`. Cases: any
  automate/structural op (incl. parent→child) prompts on first use, remembered per
  requester→target (no second prompt); deny blocks; trusted shell bypasses; standard vs severe
  by target privilege; `automate` grant does NOT authorize `structural`; consensual RPC `call`
  needs no prompt; CDP on an unloaded panel transparently loads it; worker/DO attaching a
  panel; root attachable.

## 11. Suggested implementation order

1. Shared `accessDecision` policy module + `panel.automate`/`panel.structural` constants
   (+ tests). No behavior change yet.
2. **Server CDP broker auth (§4.3):** make `getCdpEndpoint` a server service
   (`["panel","worker","do"]`) that runs `accessDecision` + `requestCapabilityPermission`
   **in-process**, mints the handshake token, returns the server `/cdp/{id}` endpoint. Replace
   `canAccessBrowser`/`panelOwnsBrowser` in the broker (`cdpBridge`).
3. **Host CDP provider agent (§4.4):** migrate `cdpServer`'s attach/forward (debugger queues,
   screenshot, AX) into a provider that connects to the broker's provider endpoint; **delete the
   standalone main `CdpServer`**; verify + remove the browser-extension provider. Privileged-
   target registration + root registration + `browser`→`target` rename land here.
4. `PanelOrchestrator.ensureLoaded` + transparent loading via lease assignment in the
   `getCdpEndpoint` service (§8).
5. **Server-side userland panel service** (§6) mutating registry/lease + `panelCall` RPC routing
   for all runtimes; hosts converge via existing lease/registry events.
6. Unified `PanelHandle` (merge types, `cdp` rename, `withContract(role)`, sync metadata +
   `refresh()`); remove `ParentHandle`; update `parent`/`noopParent`.
7. `panelTree` API; export from panel/worker/DO runtimes.
8. Docs/skills/examples + tests.
9. **(§9 scope extension, after the above)** host-capability presence → windowless Electron
   headless host running the orchestrator **+ a CDP provider agent** → default-lessee/fallback
   policy in `panelRuntimeCoordinator` → mobile-held-target reject.

## 12. Open risks / verify before/while building

- **Grant enforcement** (§4.2/§4.3) — *resolved:* the CDP broker is in the server, so auth is a
  direct **in-process** `requestCapabilityPermission` — no `serverClient` hop, no main-local
  token, no signing. The durable grant (server) is the revocable authority, re-evaluated on
  every `getCdpEndpoint`; the 60s handshake token is server-local.
- **Worker→main routing** (§6) — *no longer needed.* The server-proxy makes CDP a server
  service and structural ops server-authoritative (hosts converge via existing lease/registry
  events), so workers/DOs need neither IPC nor a `"main"` relay. (Confirmed that relay doesn't
  exist — `rpcServer` has no main route, main connects as `admin` with no WS server-state — and
  this design avoids needing it.)
- **Server↔host provider channel** (§4.4) — *designed in §14:* dedicated provider WS per host,
  routed by `lease.connectionId`, reusing the `cdpBridge` relay + extension protocol. Remaining
  to validate in build: the headless orchestrator's new "load-on-lease-assignment" behavior
  (§14.4) and `getCdpEndpoint` awaiting provider-ready without racing lease churn.
- **CDP now hops through the server** — desktop-local CDP loses the direct main loopback; every
  CDP command crosses client→server→host. Accepted tradeoff; watch latency/throughput for
  chatty Playwright sessions and large payloads (e.g. screenshots).
- **Host debugger coexistence** (§7) — *confirmed shape:* host `getAccessibilityTree`
  (`cdpServer.ts:259`) and client CDP share one per-target serialized queue
  (`debuggerCommandQueues`, `sendDebuggerCommand:506`); migrating into the provider must keep
  the queue keyed per target.
- **Hidden-view / headless screenshots** — *resolved:* `debugger.attach` is
  visibility-independent (hidden views attach fine); the provider runs `Page.captureScreenshot`
  against its `webContents`, and a headless host uses Electron offscreen rendering / native
  capture — so the desktop `withViewVisible` dance (`cdpServer.ts:363-369`) is not required
  headless. Verify offscreen capture quality/perf on the headless host.
- **(§9) Mobile-held target + CDP** — *resolved:* reject with `cdp_unavailable_mobile_held`
  (no take-over). Implementation note: enforcement must know the current holder's
  CDP-capability — derive it from the lease `holderLabel`/host-capability presence (§9.4), not
  from the panel itself.
- **(§9) Lease-change mid-automation** — *resolved:* the provider for that `browserId` drops, so
  the client CDP connection **errors and closes**; no reconnect, no lease-holding (§9.5).
- **(§9) Runtime re-instantiation** — lease transfer loses in-memory state; only persisted
  `stateArgs`/registry survive.

## 13. End-to-end verification

- `pnpm type-check`; `pnpm vitest run` (cdp/handle/grants/browser + new policy/service suites).
- Manual E2E (`pnpm dev`):
  1. Two sibling panels A,B. From A: `panelTree.get(B.id).cdp.page()` → target loads
     transparently → **standard** approval prompt; on allow, drive B; second `cdp.page()` →
     no prompt (remembered).
  2. From a child: `panelTree.self().parent().cdp.getCdpEndpoint()` → approval even though
     it's the parent; on allow, `chromium.connectOverCDP(...)`.
  3. From a worker/DO: obtain a handle and `cdp.page()` (with approval); confirm nothing can
     target the worker/DO itself.
  4. Restart so a panel is unloaded; `cdp.page()` it → transparently loads (no focus steal),
     then prompts; confirm a bare metadata read does not load it.
  5. `cdp` an about/shell panel → **severe** danger-tone approval naming the target; on allow
     it succeeds; a shell principal bypasses.
  6. `panelTree.get(child.id).close()` from its parent → prompts first time (no relationship
     bypass), then remembered. Confirm an `automate` grant does not silently authorize it.
- **(§9 scope extension) Headless-host E2E:** with **no** interactive client connected, an
  agent `cdp.page()`s a panel → it spins up in the always-on headless host and drives (with
  approval). Then open the desktop and `takeOver` the same panel for display → it transfers
  (headless unloads); release/disconnect the desktop → the panel falls back to the headless
  host. A panel currently leased by a mobile client → CDP automate request is **rejected** with
  `cdp_unavailable_mobile_held` (no take-over, panel stays on the device).

## 14. Detailed design: server↔host CDP provider channel

The load-bearing new piece for §3/§4.4. It generalizes today's `cdpBridge` (server-side broker
between Playwright clients and a single browser-extension provider) into a broker between
clients and **per-host debugger providers**, routed by lease ownership.

### 14.1 Routing key = `lease.connectionId` (no new registry)
`PanelRuntimeCoordinator` already maps `browserId → holder` and the holder identity **is** a
`connectionId` (`panelRuntimeCoordinator.ts:18,169`; `getLease(id).connectionId`). The broker
routes each client connection through it:
```
client → /cdp/{browserId}
  lease       = coordinator.getLease(browserId)
  providerWS  = providers.get(lease.connectionId)
  relay client ⇄ providerWS  (tagged with browserId)
```
The **only** structural change to `cdpBridge`: replace the singular `extensionWs` ("one
extension at a time", `cdpBridge.ts:80,424`) with `providers: Map<connectionId, WS>`, and look
up per-`browserId` via the lease. The lease coordinator stays the single source of truth, so a
provider can never serve a panel it doesn't hold (the broker only routes what the lease says) —
no separate browserId→provider registry, no divergence.

### 14.2 Connection & identity
- Each Electron host (desktop main, headless §9) opens **one dedicated provider WS** to the
  server's existing `panelHttpServer` HTTP surface, at `/api/cdp-host` (renamed from
  `/api/cdp-bridge`).
- It authenticates with its host token via `tokenManager` (`shell-remote`/admin — desktop main
  already has `shellToken`, `index.ts:2277`; the headless host mints its own the same way),
  using the existing constant-time check (`cdpBridge.ts:175`).
- On connect it declares the **same `connectionId` it uses to acquire leases**
  (`acquireRuntimeLease`). The broker keys `providers.set(connectionId, ws)`. That declared
  `connectionId` is the join between "who holds the lease" and "which WS to drive."

**Decision — dedicated WS, not multiplexed over `serverClient`.** Multiplexing is *not* simpler:
`serverClient` has no inbound-request path (broker→host would have to be modeled as event +
reverse call, splitting one round trip), the broker could no longer reuse its WS-frame relay,
and CDP event/screenshot volume would share the JSON-RPC control channel. Only hosts are
providers (1–2 sockets total), and the dedicated WS's auth/reconnect is a near-copy of existing
patterns. So dedicated.

### 14.3 Protocol: reuse the extension protocol verbatim
The broker↔provider frames already exist (`cdp:command` / `cdp:result` / `cdp:error` /
`cdp:event` / `cdp:detach`, `cdpBridge.ts:501-636`). The provider implements the **host** side
against `webContents.debugger` instead of `chrome.debugger` — exactly the migrated `cdpServer`
logic (`ensureDebuggerAttached`, `sendDebuggerCommand` + per-target serialized
`debuggerCommandQueues`, `Page.captureScreenshot`, event forwarding via
`contents.debugger.on("message")`, `cdpServer.ts:343-520`). Wire protocol unchanged; only the
debuggee binding differs. The provider attaches its local debugger lazily on the first
`cdp:command` for a held `browserId`, and detaches on `cdp:detach` (broker sends it when the
last client for that browserId disconnects, refcounted broker-side as today).

### 14.4 Transparent load = lease assignment (no server→host requests)
When `getCdpEndpoint` (§4.3) finds no CDP-capable holder:
1. the server **assigns the lease** to the headless host's `connectionId`;
2. the headless orchestrator observes the lease change (`applyRuntimeLeaseChanged`) and **loads
   on assignment** — the one genuinely new orchestrator behavior, localized to the headless
   host's "default-lessee loads what it's assigned" policy (§9.2);
3. `getCdpEndpoint` **awaits provider-ready** for that `browserId` (mirror how
   `cdpBridge.openBrowserTab` awaits `cdp:register`, `cdpBridge.ts:295`), then returns the
   endpoint.

Loading is thus driven entirely through the existing lease/event sync — the server never issues
a request *to* a host (which would need the non-existent reverse-routing).

### 14.5 Failure / lease change → error out (decided)
The broker subscribes to `panel:runtimeLeaseChanged`. On a holder change or a provider WS drop,
it **closes the affected client `/cdp/{browserId}` connections** (a provider drop already flushes
that host's pending commands, `cdpBridge.ts:462-494`). The client CDP socket errors; no
reconnect, no lease-holding.

### 14.6 `connectionId` stability (good-enough)
Leases are keyed by `connectionId` and survive brief drops via the existing grace window
(`markDisconnected`/`markConnected`/`expired`, `coordinator.ts:151-163`). The host reuses a
stable `connectionId` and re-registers its provider WS on reconnect, so routing recovers within
the grace window; leases that fully expire are re-acquired on the host's next load. No explicit
re-assertion handshake beyond re-registering the `connectionId`.

### 14.7 Trust model
The provider WS is authenticated (host token), but the broker does **not** trust it for
authorization: client-side `accessDecision` + capability approval happen at `getCdpEndpoint`
(§4.3, in-process), and routing is gated by the lease coordinator. A provider can only ever
drive panels its host legitimately holds.

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
   runtimes. Workers/DOs are full *clients*; they can never be CDP/RPC *targets* (no
   `webContents`).
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

## 3. Architecture constraint (READ FIRST — load-bearing)

**Approval and CDP live in different processes.** There are two `ServiceDispatcher`s:

- **Server dispatcher** (`src/server/index.ts:802`) owns approval: `ApprovalQueue`,
  `createUserlandApprovalService` (`:1057`), the capability-grant machinery
  (`src/server/services/capabilityPermission.ts`, `capabilityGrantStore.ts`),
  `corsApprovalService` (the closest precedent), and `externalOpenService` (`:983`).
- **Main dispatcher** (`src/main/index.ts:958`) owns CDP/browser control: `createBrowserService`
  (`:1243`) and `cdpServer`. Panels reach these via Electron IPC (`src/preload/panelPreload.ts:78`
  `natstack:getCdpEndpoint`, `natstack:panel.*`).

Main **spawns the server as a child process** (`src/main/serverSession.ts`,
`createServerClient`/`ServerProcessManager`); main connects to it as a single privileged
`shell`-token principal (`serverSession.ts:295/392`), and `serverClient.call(service, method,
args)` carries **no per-call principal** (`src/main/serverClient.ts:23`).

**Key consequence for the approval design (§4.3):** CDP/control ops are *requester-initiated*
(a panel/worker/do actively calls them). The requester already has its own RPC connection to
the server where `ctx.caller` is its genuine identity, so it asks the server for the
capability **directly** — no impersonation, no main→server attribution. Main's only job is
**enforcement** at the boundary it owns (the `WebContentsView`/debugger): it mints the CDP
endpoint only if an approved grant exists. This is the opposite of CORS, which is genuinely
*main-originated* (the decision fires inside main's `webRequest` interception, where no panel
identity is on the stack) — that is why CORS uses the `serverClient` hop and CDP does not.

Mode notes:
- **Desktop:** approval = panel→server (direct); enforcement = `src/main/cdpServer.ts` /
  `browserService` (main).
- **Server-mode (UI client present):** CDP = `src/server/cdpBridge.ts`; approval + enforcement
  are both in the server dispatcher — same connection, no hop.
- **Mobile:** `apps/mobile/src/services/bridgeAdapter.ts` (`getCdpEndpoint`,
  `MainScreen.tsx:491`) reaches the same server approval service on its own connection.

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

`cdpServer.ts` (desktop), `cdpBridge.ts` (server), and the mobile backend all consume this
one function. Only the *approval invocation* (§4.3) differs per process.

Two capabilities, because CDP attach already confers total in-panel control (so gating
individual drive verbs is pointless — shared `panel.automate`), but *structural* ops mutate
the tree/host and must not be silently authorized by an automate grant (`panel.structural`).

### 4.2 Reuse the capability-grant machinery
Do **not** call `userlandApprovalService` directly. Use `requestCapabilityPermission`
(`src/server/services/capabilityPermission.ts`) — the same helper behind `cors-response-read`
and `external-browser-open`. It provides scoped grants (`once`/`session`/`version`) +
revocation via `CapabilityGrantStore`, danger tone for severe, and dedup keys. The grant
keying gives "remembered per requester→target" for free, and prompts surface through the
existing pipeline (`ApprovalQueue` emits `shell-approval:pending-changed`,
`approvalQueue.ts:291`; `approvalPushBridge.ts` delivers to the shell renderer) — so a CDP
approval gets the prompt UI automatically.

### 4.3 CDP/control approval wiring — requester asks, main enforces

The principle (§3): the **requester asks the server for the capability on its own connection**
(`ctx.caller` is the genuine panel/worker/do — no impersonation, no mis-keying); the **main
boundary only enforces**. Model the service on `corsApprovalService`
(`src/server/services/corsApprovalService.ts`), which already calls
`requestCapabilityPermission` for a panel caller — but invoked by the requester, not by main.

**Approval — new server service `panelControlApproval`** (server dispatcher, alongside
corsApproval), policy `allowed: ["panel","worker","do"]` (NOT shell):
- `authorize({ targetId, targetTitle, capability })` → `{ allowed, decision, grantToken? }`.
- Uses `ctx.caller` as the genuine requester. Runs `requestCapabilityPermission` with
  `capability` ∈ {`panel.automate`,`panel.structural`} (§4.1), `resource = { type:"panel",
  label: targetTitle, value: targetId, key: targetId }`, `dedupKey =
  cdp:${ctx.caller.runtime.id}:${targetId}:${capability}`, severity by target privilege
  (severe → danger tone). On allow, the grant is recorded in `CapabilityGrantStore` keyed
  (requester→target→capability) → "remembered per requester→target" for free; the prompt
  surfaces via the existing pipeline (§4.2). On allow, mint and return a short-lived **signed
  capability token** bound to (requesterId, targetId, capability) — reuse the existing
  `cdpGrants` signing scheme (`packages/shared/src/cdpGrants.ts`) so main can verify it
  offline.

**Enforcement at the main boundary** (it owns the `WebContentsView`/debugger):
- `getCdpEndpoint(targetId, grantToken?)` (Electron IPC → `browserService`, main): main runs
  §4.1 `accessDecision("cdp", requester=ctx.caller, target)`. If `panel.automate` is required,
  main verifies a valid grant for (requester→target): **prefer offline verification of the
  signed `grantToken`** (no round-trip on the hot path); fall back to a
  `serverClient.call("capabilityGrants","check",[…])` lookup (a *query* — correctly attributed
  because the grant was created under the real requester id — not an approval). Absent/invalid
  → reject `"CDP access denied"`. On pass → **transparently `ensureLoaded(target)`** (§8) →
  mint the CDP endpoint. Persist `CallerKind` in the minted `CdpGrant` so the WebSocket
  `handleConnection`/`cdpBridge` re-evaluate bypass without re-prompting.
- **Drive/structural ops** (`navigate`/`reload`/… and `close`/`archive`/…) go through the
  userland panel service (§6, main) and enforce identically before delegating to
  `PanelOrchestrator`; `panel.structural` is distinct so an automate grant never authorizes
  them.

**SDK orchestration (the handle, transparent to callers):** a live-only op first calls
`panelControlApproval.authorize` on the requester's own RPC connection — **idempotent**:
returns immediately with a token if a grant already exists, otherwise prompts — then calls the
main IPC with the returned `grantToken`. The caller writes only `handle.cdp.page()`.

**Why main can trust this:** the requester names only the *target* (the approved resource); it
cannot forge its own identity (that is its verified RPC `ctx.caller`), and main independently
re-runs `accessDecision` + verifies the signed token, so a panel that skips asking simply gets
rejected. Defense in depth, with the policy module (§4.1) shared by both sides.

**Server-mode (`cdpBridge.ts`) & mobile:** same `panelControlApproval` service, in-process in
the server dispatcher (no token round-trip needed — same process owns the grant store).
Replace `canAccessBrowser` / `panelOwnsBrowser` / `assertOwner` (`browserService.ts:42`) with
the shared `accessDecision` + grant check.

**CORS is unchanged:** it remains main-originated via the `serverClient` hop
(`src/main/index.ts:409-435`); only CDP/control move to the requester-asks model.

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
backs the trusted shell renderer). Add a **new userland panel service** (policy
`allowed: ["shell","panel","worker","do","server"]`) that runs every op through §4.1
`accessDecision`, and when a capability is required, runs §4.3 approval before delegating to
the same `PanelOrchestrator` lifecycle methods the shell service uses.

**Transport.** `handle.ts` `panelCall` (lines 52-55) currently requires `shell.panel[method]`
(Electron IPC) and throws otherwise. Workers/DOs have no Electron shell, so `panelCall` must
route to the new userland panel service over RPC when no shell is present. **Verify** a
worker/DO's RPC bridge can reach this main-process service in *desktop* mode (server→main
routing); if not, that routing is part of this work. (Server-mode reachability is confirmed.)

Export `panelTree` + `PanelHandle` from `workspace/packages/runtime/src/panel/index.ts`,
`worker/index.ts`, and `worker/durable-base.ts`.

## 7. CDP layer: client API, privileged tracking, naming

- **Client** (`workspace/packages/runtime/src/panel/browserAutomation.ts`): drop the `kind`
  param and `assertBrowser` (and its 7 call sites); move the shell lookup
  (`globalThis.__natstackShell ?? __natstackElectron`) inside the factory; rename
  → `createCdpAutomation` / `CdpAutomation`. RPC target stays `main`/`cdp.*`.
- **Privileged tracking** (severity input, not exclusion): add `privileged?: boolean` to
  `PanelSnapshot` (`packages/shared/src/types.ts:~217`) and `createSnapshot`
  (`packages/shared/src/panel/accessors.ts:116`), set from `manifest.shell` where the snapshot
  is built (`packages/shared/src/shell/panelManager.ts:236-243`, mirroring
  `autoArchiveWhenEmpty`; also `packages/shared/src/panelFactory.ts:182`).
- **Registration / root:** `registerBrowser`→`registerTarget(panelId, wcId, { privileged })`
  (`src/main/cdpServer.ts:126`, called from `src/main/panelView.ts:156/235`); keep a
  `privilegedTargets: Set`. Remove the `if (parentId)` guard at `panelView.ts:154/233` so the
  root panel is also a registered target.
- **Rename** `browser`→`target`/`panel` across `cdpServer.ts`, `cdpBridge.ts`,
  `browserService.ts`, `panelView.ts`, `preload/panelPreload.ts:78`, and the mobile backend.
  **Caution:** `cdpServer` also serves host-side `getAccessibilityTree`/snapshots over the
  same single debugger session (`debuggerCommandQueues`). The rename + access-widening must
  not break the host's own debugger use or the per-target command serialization.

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
- **Transparent on CDP access:** fold `ensureLoaded(targetId)` into the main `getCdpEndpoint`
  handler (and the `cdp.*` drive paths), so `handle.cdp.page()` on an unloaded panel just
  works — no caller action. Loading runs *after* main's §4.3 grant enforcement passes (never
  load a panel the requester isn't authorized to drive).
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
- **CDP session survives a holder change?** If the holder changes mid-automation (a human takes
  over a headless-driven panel, or vice-versa), the existing CDP socket breaks; the SDK must
  detect the lease change (`panel:runtimeLeaseChanged` event already exists) and reconnect, or
  hold the lease for the duration of automation.
- **Two orchestrators, one tree.** Headless + desktop both run orchestrators; tree-mutation ops
  (open/close/move) must stay single-authority — they already route through the registry/server,
  so confirm no host-local divergence.
- **Resource bounds:** headless host accumulating live web contents → enforce lazy load + idle
  GC + a cap.

### 9.6 Suggested phasing
Land §1-8 first (they work with today's single desktop host). Then: (a) host-capability
presence; (b) headless Electron host process running the existing orchestrator; (c) default-
lessee + fallback-on-release policy in `panelRuntimeCoordinator`; (d) lease-change reconnect in
the CDP SDK; (e) the mobile-held-target policy. The lease coordinator, lease-transfer unload,
and presence service already exist, so this is mostly policy + a new host process, not new
transport.

## 10. Docs & tests

- **Docs/skills:** rewrite Browser Automation sections to use `panelTree.get(id)` →
  `handle.cdp.page()` (no explicit load needed for CDP); document that the first
  automate/structural op triggers an approval (remembered per pair, severe for privileged);
  show child→parent (`panelTree.self().parent()`) and sibling examples; document explicit
  `ensureLoaded()` for the RPC-to-unloaded case. Files: `PANEL_DEVELOPMENT.md:291-352`,
  `PANEL_SYSTEM.md` runtime-API list, `workspace/skills/*/{BROWSER,EVAL,WORKFLOW*}.md`,
  `workspace/packages/playwright-core/INTEGRATION_TEST_EXAMPLE.ts`.
- **Tests:** `src/main/cdpServer.test.ts`, `src/server/cdpBridge.test.ts`,
  `src/main/ipc/browserHandlers.test.ts`, `workspace/packages/runtime/src/panel/handle.test.ts`
  (remove kind-gating reject at `:59`; rename `.browser`→`.cdp`; unified RPC+cdp surface),
  `packages/shared/src/cdpGrants.test.ts` (grant carries kind), plus a new
  `panelControlApproval` service test and shared-policy tests for `accessDecision`. Cases: any
  automate/structural op (incl. parent→child) prompts on first use, remembered per
  requester→target (no second prompt); deny blocks; trusted shell bypasses; standard vs severe
  by target privilege; `automate` grant does NOT authorize `structural`; consensual RPC `call`
  needs no prompt; CDP on an unloaded panel transparently loads it; worker/DO attaching a
  panel; root attachable.

## 11. Suggested implementation order

1. Shared `accessDecision` policy module + `panel.automate`/`panel.structural` constants
   (+ tests). No behavior change yet.
2. Privileged-target persistence (`PanelSnapshot.privileged`) + `registerTarget` + root
   registration + `browser`→`target` rename in the CDP layer.
3. `panelControlApproval` server service (§4.3), policy `["panel","worker","do"]`, reusing
   `requestCapabilityPermission`; returns a signed `grantToken` (reuse `cdpGrants` signing).
4. Main enforcement: `getCdpEndpoint(targetId, grantToken?)` + drive/structural paths run
   `accessDecision` and verify the signed token (fallback: `capabilityGrants.check` query).
   Replace `canAccessBrowser`/`assertOwner`; `cdpBridge` enforces in-process. SDK handle calls
   `authorize` (idempotent) then passes the token to main.
5. `PanelOrchestrator.ensureLoaded` + transparent fold into `getCdpEndpoint`.
6. New userland panel service + `panelCall` RPC routing for no-shell runtimes.
7. Unified `PanelHandle` (merge types, `cdp` rename, `withContract(role)`, sync metadata +
   `refresh()`); remove `ParentHandle`; update `parent`/`noopParent`.
8. `panelTree` API; export from panel/worker/DO runtimes.
9. Docs/skills/examples + tests.
10. **(§9 scope extension, after the above)** host-capability presence → headless Electron host
    → default-lessee/fallback policy in `panelRuntimeCoordinator` → CDP lease-change reconnect →
    mobile-held-target policy.

## 12. Open risks / verify before/while building

- **Grant enforcement at main** (§4.3) — decide signed-token offline verification (preferred,
  no round-trip) vs. a `capabilityGrants.check` query; confirm the `cdpGrants` signing scheme
  is reusable for the capability `grantToken`.
- **Worker→main service routing in desktop mode** (§6) — confirm or implement (needed for the
  enforcement IPC; the panel→server approval connection is already confirmed).
- **Signed-token freshness/revocation** — short TTL so a revoked `CapabilityGrantStore` entry
  can't be replayed via a stale token; main re-runs `accessDecision` regardless.
- **Host debugger coexistence** (§7) — renames/access-widening must not disturb
  `getAccessibilityTree`/snapshot or single-session command serialization.
- **Hidden-view CDP attach** (§8) — verify a non-visible `WebContentsView` attaches (also the
  basis for the headless host, §9.3).
- **(§9) Mobile-held target + CDP** — *resolved:* reject with `cdp_unavailable_mobile_held`
  (no take-over). Implementation note: enforcement must know the current holder's
  CDP-capability — derive it from the lease `holderLabel`/host-capability presence (§9.4), not
  from the panel itself.
- **(§9) Lease-change mid-automation** — CDP socket breaks on holder change; SDK reconnect via
  `panel:runtimeLeaseChanged`, or hold the lease for the automation's duration.
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

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
  `browserAutomation.ts:26` (`assertBrowser`) throws unless `kind === "browser"`. So a child
  cannot drive its parent and siblings cannot drive each other.
- **No approval on CDP today.** The only capability approval is `externalOpenService`
  (system-browser opens). CDP attach is gated purely by ancestry + a short-lived token.
- **Workers/DOs are second-class.** They expose only `getParent()`; they lack
  `getPanelHandle`/`listPanels`/`openPanel`. (Arbitrary peer-to-peer RPC routing already
  works — `src/server/rpcServer.ts:1999 checkRelayAuth` returns OK unconditionally — and the
  CDP service policy already lists `worker`/`do`.)
- **No load lifecycle for connecting.** On startup only the focused panel gets a live view
  (`src/main/panelOrchestrator.ts:720 initializePanelTree` + `restorePolicy`); other tree
  members exist in the registry with no `webContents`, and `unloadPanel` tears views down.
  CDP/RPC to such a panel fails.

**Goal.** One unified handle abstraction obtainable for *any* panel-tree member from a
`panelTree` API, usable by panels, workers, and DOs, where any live panel can be driven over
CDP/RPC — with **all CDP and control/destructive operations gated by a user approval**
(remembered per requester→target; escalated for privileged targets) — and an explicit,
well-documented `ensureLoaded()` for members that aren't currently live.

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
6. **`ensureLoaded()` is explicit + documented**, auto-fired only by live-only ops.
7. Rename the automation namespace `handle.browser.*` → `handle.cdp.*`, and `browser`→
   `target`/`panel` throughout the CDP layer.

## 3. Architecture constraint (READ FIRST — load-bearing)

**Approval and CDP live in different processes.** There are two `ServiceDispatcher`s:

- **Server dispatcher** (`src/server/index.ts:802`) owns approval: `ApprovalQueue`,
  `createUserlandApprovalService` (`:1057`), the capability-grant machinery
  (`src/server/services/capabilityPermission.ts`, `capabilityGrantStore.ts`), and
  `externalOpenService` (`:983`).
- **Main dispatcher** (`src/main/index.ts:958`) owns CDP/browser control: `createBrowserService`
  (`:1243`) and `cdpServer`. Panels reach these via Electron IPC (`src/preload/panelPreload.ts:78`
  `natstack:getCdpEndpoint`, `natstack:panel.*`).

Main **spawns the server as a child process** (`src/main/serverSession.ts`,
`createServerClient`/`ServerProcessManager`). Therefore "await approval before issuing a CDP
grant" is a **cross-process** call from main → server. This is already an established
pattern: main runs **CORS approval** through `serverSession.serverClient`
(`src/main/index.ts:409-435`) and `openExternal` approval is a *server* service invoked from
a *main* IPC entry. **Reuse that seam** — do not invent a second approval system.

Mode asymmetry:
- **Desktop:** CDP = `src/main/cdpServer.ts`; approval requires the main→server hop above.
- **Server/headless:** CDP = `src/server/cdpBridge.ts`; approval is **in-process** (same
  server dispatcher) — no hop.
- **Mobile:** `apps/mobile/src/services/bridgeAdapter.ts` (`getCdpEndpoint`,
  `MainScreen.tsx:491`) must reach the same decision + approval.

## 4. Authorization + approval design

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
one function. Only the *approval invocation* differs per process (§4.3).

Rationale for two capabilities: CDP attach already confers total in-panel control, so
gating individual drive verbs is pointless — they share `panel.automate`. But *structural*
ops mutate the tree/host (not just panel content); they must not be silently authorized by
an automate grant, hence a separate `panel.structural` capability.

### 4.2 Reuse the capability-grant machinery
Do **not** call `userlandApprovalService` directly. Use `requestCapabilityPermission`
(`src/server/services/capabilityPermission.ts`) — the same helper behind
`external-browser-open` and `runtime.crossContextEntity`. It already provides:
- scoped grants (`once` / `session` / `version`) + revocation via `CapabilityGrantStore`;
- danger tone for severe;
- dedup keys.

Call shape: `capability = "panel.automate" | "panel.structural"`,
`resource = { type: "panel", label: <target title>, value: <targetId>, key: <targetId> }`,
`caller = ctx.caller`. The grant store keying gives "remembered per requester→target" for
free.

### 4.3 Where approval runs
- **Server/headless (`cdpBridge.ts`):** call `requestCapabilityPermission` in-process before
  issuing the grant / performing the op.
- **Desktop (`cdpServer.ts` / `browserService.ts` / new userland panel service):** forward the
  capability request to the server via `serverSession.serverClient` (mirror the CORS-approval
  call at `src/main/index.ts:409-435`), await the decision, then issue the grant. The CDP
  grant token (`packages/shared/src/cdpGrants.ts`) is minted **after** approval; the WebSocket
  `handleConnection` only validates the token (approval already happened at issuance).
- Persist `CallerKind` in the `CdpGrant` so `handleConnection`/`cdpBridge` can re-evaluate
  bypass without re-prompting.

### 4.4 Non-interactive / agentic path (REQUIRED — do not skip)
The product's "ongoing agentic presence" means agents drive panels with no human present. A
first-use prompt per requester→target would deadlock autonomous/CI/agent flows. Provide a
non-interactive grant source consumed by the same `accessDecision`/grant lookup:
- honor the existing `version` grant scope (trust a code version once), and
- add a workspace/policy pre-grant (allowlist of `{requesterScope, capability, targetScope}`)
  loaded into the `CapabilityGrantStore` at startup,

so headless principals resolve to an existing grant instead of an interactive prompt. Decide
the exact policy surface with the owner before building; the seam is the grant-store lookup
inside `requestCapabilityPermission`.

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
  (asymmetric) contract `.call` exposes — `defineContract` has distinct `child.methods` vs
  `parent.methods`, so a handle to my parent exposes parent methods, a handle to my child
  exposes child methods. Keep `getParentWithContract` as a thin alias
  (`= parent.withContract(contract, "parent")`). This replaces the simplistic
  "generalize `ParentHandleFromContract`."
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
the same `PanelOrchestrator` lifecycle methods the shell service uses. This prevents userland
from inheriting shell privileges wholesale.

**Transport.** `handle.ts` `panelCall` (lines 52-55) currently requires `shell.panel[method]`
(Electron IPC) and throws otherwise. Workers/DOs have no Electron shell, so `panelCall` must
route to the new userland panel service over RPC when no shell is present. **Verify** that a
worker/DO's RPC bridge can reach this main-process service in *desktop* mode (server→main
routing); if not, that routing is part of this work. (Server-mode reachability is already
confirmed.)

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
- Replace `canAccessBrowser` and the `panelOwnsBrowser`/`assertOwner` second tier
  (`browserService.ts:42`) with the shared §4.1 `accessDecision` + §4.3 approval.

## 8. `ensureLoaded()` (explicit; auto-fired only by live-only ops)

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
- Expose via the new userland panel service (open class — no prompt; loading grants no
  control). Surface as `handle.ensureLoaded()` / `handle.isLoaded()`.
- **Explicit + documented** primitive, shown in every CDP example/skill. **Auto-fired only by
  live-only ops** (`cdp.getCdpEndpoint`/`page`, first RPC `call`/`emit`, `_agent`
  introspection); host-served ops (metadata, `children`, `stateArgs`, `close`) deliberately do
  **not** auto-load. (`onEvent` is a local subscription — no target load.)

## 9. Docs & tests

- **Docs/skills:** rewrite Browser Automation sections to use `panelTree.get(id)` →
  `await handle.ensureLoaded()` → `handle.cdp.page()`; document that the first automate/
  structural op triggers an approval (remembered per pair, severe for privileged); show
  child→parent (`panelTree.self().parent()`) and sibling examples. Files:
  `PANEL_DEVELOPMENT.md:291-352`, `PANEL_SYSTEM.md` runtime-API list,
  `workspace/skills/*/{BROWSER,EVAL,WORKFLOW*}.md`,
  `workspace/packages/playwright-core/INTEGRATION_TEST_EXAMPLE.ts`. **Every** CDP example
  includes the explicit `ensureLoaded()` step.
- **Tests:** `src/main/cdpServer.test.ts`, `src/server/cdpBridge.test.ts`,
  `src/main/ipc/browserHandlers.test.ts`, `workspace/packages/runtime/src/panel/handle.test.ts`
  (remove kind-gating reject at `:59`; rename `.browser`→`.cdp`; unified RPC+cdp surface),
  `packages/shared/src/cdpGrants.test.ts` (grant carries kind). New shared-policy tests for
  `accessDecision` (op×privilege→capability/severity, shell/owner bypass). New cases: any
  automate/structural op (incl. parent→child) requires approval on first use, remembered per
  requester→target (no second prompt); dismiss blocks; trusted shell bypasses; standard vs
  severe by target privilege; `automate` grant does NOT authorize `structural`; consensual RPC
  `call` + `ensureLoaded` need no prompt; non-interactive pre-grant resolves without a prompt;
  worker/DO attaching a panel; root attachable.

## 10. Suggested implementation order

1. Shared `accessDecision` policy module + `panel.automate`/`panel.structural` capability
   constants (+ tests). No behavior change yet.
2. Privileged-target persistence (`PanelSnapshot.privileged`) + `registerTarget` + root
   registration + `browser`→`target` rename in the CDP layer.
3. `requestCapabilityPermission` wiring: server-mode (`cdpBridge`) in-process; desktop main→
   server seam via `serverSession.serverClient`. Replace `canAccessBrowser`/`assertOwner`.
4. New userland panel service (read/connect/drive + approval-gated structural) + `panelCall`
   RPC routing for no-shell runtimes.
5. Unified `PanelHandle` (merge types, `cdp` rename, `withContract(role)`, sync metadata +
   `refresh()`); remove `ParentHandle`; update `parent`/`noopParent`.
6. `panelTree` API; export from panel/worker/DO runtimes.
7. `ensureLoaded` orchestrator method + service + auto-fire on live-only ops.
8. Non-interactive pre-grant policy (confirm surface with owner).
9. Docs/skills/examples + tests.

## 11. Open risks / verify before/while building

- **Worker→main service routing in desktop mode** (§6) — confirm or implement.
- **Main→server approval round-trip** adds latency to the CDP path and a hard dependency on
  server reachability; define the failure mode (deny vs error).
- **Non-interactive approval** (§4.4) — the policy surface needs owner sign-off.
- **Host debugger coexistence** (§7) — renames/access-widening must not disturb
  `getAccessibilityTree`/snapshot or single-session command serialization.
- **Hidden-view CDP attach** (§8) — verify a non-visible `WebContentsView` attaches.

## 12. End-to-end verification

- `pnpm type-check`; `pnpm vitest run` (cdp/handle/grants/browser + new policy/service suites).
- Manual E2E (`pnpm dev`):
  1. Two sibling panels A,B. From A: `panelTree.get(B.id)` → `ensureLoaded()` (no prompt) →
     `cdp.page()` → **standard** approval; on allow, drive B; second `cdp.page()` → no prompt.
  2. From a child: `panelTree.self().parent()` → `cdp.getCdpEndpoint()` → approval even though
     it's the parent; on allow, `chromium.connectOverCDP(...)`.
  3. From a worker/DO: obtain a handle and `cdp.page()` (with approval); confirm nothing can
     target the worker/DO itself.
  4. Restart so a panel is unloaded; `ensureLoaded()` brings it live without focus/prompt; the
     following `cdp` op prompts.
  5. Attach/`cdp` an about/shell panel → **severe** danger-tone approval naming the target; on
     allow it succeeds; a shell principal bypasses.
  6. `panelTree.get(child.id).close()` from its parent → prompts first time (no relationship
     bypass), then remembered. Confirm an `automate` grant does not silently authorize it.
  7. With a non-interactive pre-grant configured, the agent path runs with no prompt.

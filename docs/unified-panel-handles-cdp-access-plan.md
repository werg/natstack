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
`createServerClient`/`ServerProcessManager`). So a CDP request handled in main must reach the
approval system in the server. The seam already exists and is exercised by CORS approval:
`serverSession.serverClient.call(service, method, args)` (`src/main/index.ts:409-435`).

Mode notes:
- **Desktop:** CDP = `src/main/cdpServer.ts`; approval requires the main→server hop (§4.3).
- **Server-mode (UI client present):** CDP = `src/server/cdpBridge.ts`; approval is
  **in-process** in the same server dispatcher — no hop.
- **Mobile:** `apps/mobile/src/services/bridgeAdapter.ts` (`getCdpEndpoint`,
  `MainScreen.tsx:491`) reaches the same server approval service.

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

### 4.3 Concrete CDP-approval wiring (the part that must actually work)

Model on `corsApprovalService` (`src/server/services/corsApprovalService.ts`), which already
calls `requestCapabilityPermission` for a panel caller and is invoked by main via
`serverClient`.

**Add a server service `panelControlApproval`** (server dispatcher, alongside corsApproval):
- `authorize({ requesterId, requesterKind, targetId, targetTitle, capability, severity })`
  → `{ allowed, decision }`.
- Policy admits the trusted shell/host caller (main) **plus** `panel`/`worker`/`do` (for the
  in-process server-mode path).
- **Caller attribution (critical):** `serverClient.call` carries no per-call caller identity
  (`src/main/serverClient.ts:23` — `call(service, method, args)`), and `corsApprovalService`
  derives the issuer from `ctx.caller`. We do **not** rely on impersonation: main passes the
  already-verified requester identity *explicitly* in the args (it has it from the IPC
  `ctx.caller.runtime.id`), and the service synthesizes a `VerifiedCaller`
  `{ runtime: { id: requesterId, kind: requesterKind } }` to feed `requestCapabilityPermission`
  (which only reads `caller.runtime`). Main is trusted to assert the requester it already
  authenticated. *(First confirm exactly how CORS attribution works today — whether
  `serverClient` connects with a panel identity or there is an existing per-call override —
  and prefer that mechanism if it's cleaner; the explicit-arg design above is the fallback
  that does not depend on impersonation.)*
- Capability/resource: `capability` from §4.1; `resource = { type:"panel",
  label: targetTitle, value: targetId, key: targetId }`; `dedupKey` =
  `cdp:${requesterId}:${targetId}:${capability}`. Severe → danger tone.

**Desktop flow (`getCdpEndpoint`):**
1. Panel calls `natstack:getCdpEndpoint` (IPC) → `browserService` (main). Main knows the
   verified requester (`ctx.caller.runtime.id/kind`) and the target id.
2. Main runs §4.1 `accessDecision("cdp", requester, target)`. If a capability is required,
   main calls `serverSession.serverClient.call("panelControlApproval","authorize",[{...}])`
   and awaits `{ allowed, decision }` (mirror the CORS call at `src/main/index.ts:409-435`,
   including the failure→deny `.catch`).
3. On allow, main **transparently ensures the target is loaded** (§8), then mints the CDP
   grant token (`packages/shared/src/cdpGrants.ts`) and returns the endpoint. On deny/timeout
   → throw "CDP access denied". The WebSocket `handleConnection` continues to only validate
   the token (approval already happened at issuance). Persist `CallerKind` in `CdpGrant` so
   `handleConnection`/`cdpBridge` can re-evaluate bypass without re-prompting.
4. Repeat calls hit the remembered grant in `CapabilityGrantStore` → no second prompt.

**Drive/structural ops** (`navigate`/`reload`/… and `close`/`archive`/…) follow the same
gate before acting; `panel.structural` is a distinct capability so an automate grant never
authorizes them.

**Server-mode (`cdpBridge.ts`):** identical, but call `requestCapabilityPermission`
in-process (no `serverClient` hop). Replace `canAccessBrowser` / `panelOwnsBrowser` /
`assertOwner` (`browserService.ts:42`) with the shared `accessDecision` + this approval.

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
- **Transparent on CDP access:** fold `ensureLoaded(targetId)` into the main `getCdpEndpoint`
  handler (and the `cdp.*` drive paths), so `handle.cdp.page()` on an unloaded panel just
  works — no caller action. Loading runs *after* the §4.3 approval is granted.
- **Explicit `ensureLoaded()` / `isLoaded()`** stay on the handle (open class — no prompt) for
  non-CDP needs, e.g. before RPC `call`/`emit` to an unloaded panel. Documented, but CDP
  examples no longer need to call it (transparency handles them). RPC/`_agent` do **not**
  auto-load — callers use the explicit primitive there.

## 9. Docs & tests

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

## 10. Suggested implementation order

1. Shared `accessDecision` policy module + `panel.automate`/`panel.structural` constants
   (+ tests). No behavior change yet.
2. Privileged-target persistence (`PanelSnapshot.privileged`) + `registerTarget` + root
   registration + `browser`→`target` rename in the CDP layer.
3. `panelControlApproval` server service (§4.3) + reuse `requestCapabilityPermission`. First
   confirm CORS caller attribution; implement explicit-requester args.
4. Wire main `browserService` (and drive/structural paths) to call it via `serverClient`
   before minting grants; in-process for `cdpBridge`. Replace `canAccessBrowser`/`assertOwner`.
5. `PanelOrchestrator.ensureLoaded` + transparent fold into `getCdpEndpoint`.
6. New userland panel service + `panelCall` RPC routing for no-shell runtimes.
7. Unified `PanelHandle` (merge types, `cdp` rename, `withContract(role)`, sync metadata +
   `refresh()`); remove `ParentHandle`; update `parent`/`noopParent`.
8. `panelTree` API; export from panel/worker/DO runtimes.
9. Docs/skills/examples + tests.

## 11. Open risks / verify before/while building

- **CORS caller attribution** (§4.3) — confirm how `serverClient`-invoked approvals are
  attributed to a panel today; adopt that or the explicit-requester fallback.
- **Worker→main service routing in desktop mode** (§6) — confirm or implement.
- **Main→server approval round-trip** adds latency and a hard dependency on server
  reachability; failure mode is deny (mirror CORS `.catch`).
- **Host debugger coexistence** (§7) — renames/access-widening must not disturb
  `getAccessibilityTree`/snapshot or single-session command serialization.
- **Hidden-view CDP attach** (§8) — verify a non-visible `WebContentsView` attaches.

## 12. End-to-end verification

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

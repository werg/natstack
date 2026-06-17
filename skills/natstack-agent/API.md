<!-- GENERATED FILE — do not edit. Regenerate with: pnpm generate:agent-docs -->

# NatStack RPC Service Reference (agent CLI)

Every service below is callable from a paired CLI as
`natstack agent call SERVICE.METHOD 'ARGS_JSON'` (and from `natstack eval run`
code as `services.SERVICE.METHOD(...args)` or `rpc.call("SERVICE.METHOD", args)`).

This file lists methods and descriptions only. For full Zod argument and
return schemas of a service, ask the live server:

```bash
natstack agent services SERVICE_NAME --json
```

Generated statically from `src/server/services/`; a server build may register
a subset depending on its configuration — `natstack agent services` shows what
is actually live.

Some internal services (e.g. workerd) are not shell-callable and do not appear
here. Create workers and DOs via `runtime.createEntity` (`kind: "worker"` /
`"do"`), then dispatch to them with `--target` relay calls.

## `audit`

Audit log query access

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `audit.query` |  |

## `auth`

Gateway authentication bootstrap routes

Allowed callers: `server`, `shell`, `shell-remote`

| Method | Description |
|--------|-------------|
| `auth.grantConnection` |  |
| `auth.getConnectionInfo` |  |
| `auth.createPairingInvite` |  |
| `auth.listDevices` |  |
| `auth.revokeDevice` |  |

## `blobstore`

Per-workspace content-addressable blob storage

Allowed callers: `panel`, `app`, `worker`, `do`, `shell`, `server`

| Method | Description |
|--------|-------------|
| `blobstore.has` |  |
| `blobstore.stat` |  |
| `blobstore.putText` |  |
| `blobstore.getText` |  |
| `blobstore.getRange` |  |
| `blobstore.getRangeBytes` |  |
| `blobstore.grep` |  |
| `blobstore.putBase64` |  |
| `blobstore.getBase64` |  |
| `blobstore.delete` |  |
| `blobstore.list` |  |
| `blobstore.pruneUnreferenced` |  |

## `build`

Build system (getBuild, getBuildNpm, recompute, gc, getAboutPages)

Allowed callers: `panel`, `app`, `shell`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `build.getBuild` |  |
| `build.getBuildNpm` |  |
| `build.getBuildMetadata` |  |
| `build.getEffectiveVersion` |  |
| `build.inspectBuildProvenance` | Resolve a workspace build unit and report its effective version, immutable build keys, and cached artifact metadata. |
| `build.listRecentBuildEvents` | List recent state-triggered build lifecycle events and failures, optionally filtered by unit name or workspace-relative path. |
| `build.doctorExtension` | Inspect an extension manifest, dependency routing, cached metadata, and smoke/build status. |
| `build.recompute` |  |
| `build.gc` |  |
| `build.getAboutPages` |  |
| `build.hasUnit` |  |
| `build.getPanelMetadata` |  |
| `build.listSkills` | List available workspace skill packages that can be loaded via the eval imports parameter. |

## `credentials`

URL-bound userland credential storage and egress

Allowed callers: `shell`, `app`, `panel`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `credentials.storeCredential` |  |
| `credentials.connect` |  |
| `credentials.configureClient` |  |
| `credentials.requestCredentialInput` |  |
| `credentials.getClientConfigStatus` |  |
| `credentials.deleteClientConfig` |  |
| `credentials.forwardOAuthCallback` |  |
| `credentials.listStoredCredentials` |  |
| `credentials.revokeCredential` |  |
| `credentials.grantCredential` |  |
| `credentials.resolveCredential` |  |
| `credentials.proxyFetch` |  |
| `credentials.proxyGitHttp` |  |
| `credentials.audit` |  |

## `externalOpen`

Approval-gated system browser opens

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `externalOpen.openExternal` |  |

## `fs`

Per-context filesystem operations (sandboxed to context folder)

Allowed callers: `panel`, `app`, `server`, `worker`, `do`, `extension`, `shell`, `harness`

| Method | Description |
|--------|-------------|
| `fs.readFile` |  |
| `fs.writeFile` |  |
| `fs.appendFile` |  |
| `fs.readdir` |  |
| `fs.mkdir` |  |
| `fs.rmdir` |  |
| `fs.rm` |  |
| `fs.stat` |  |
| `fs.lstat` |  |
| `fs.exists` |  |
| `fs.access` |  |
| `fs.unlink` |  |
| `fs.copyFile` |  |
| `fs.rename` |  |
| `fs.realpath` |  |
| `fs.truncate` |  |
| `fs.readlink` |  |
| `fs.chmod` |  |
| `fs.utimes` |  |
| `fs.grep` |  |
| `fs.glob` |  |
| `fs.open` |  |
| `fs.handleRead` |  |
| `fs.handleWrite` |  |
| `fs.handleClose` |  |
| `fs.handleStat` |  |
| `fs.mktemp` |  |

## `gitInterop`

External Git interop: declared remotes and remote project imports

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `gitInterop.setSharedRemote` |  |
| `gitInterop.removeSharedRemote` |  |
| `gitInterop.importProject` |  |
| `gitInterop.completeWorkspaceDependencies` |  |

## `meta`

Runtime introspection for services and eval runtime surfaces.

Allowed callers: `panel`, `app`, `worker`, `do`, `extension`, `server`, `shell`

| Method | Description |
|--------|-------------|
| `meta.listServices` | List all registered RPC services and their method metadata. |
| `meta.describeService` | Describe one registered RPC service by name. |
| `meta.getRuntimeSurface` | Return the live eval runtime surface manifest for the requested target. |

## `notification`

Push notifications to the shell chrome area

Allowed callers: `shell`, `app`, `panel`, `worker`, `do`, `extension`, `server`

| Method | Description |
|--------|-------------|
| `notification.show` |  |
| `notification.dismiss` |  |
| `notification.reportAction` |  |

## `panelCdp`

Approval-gated server CDP access for panel targets

Allowed callers: `shell`, `server`, `panel`, `worker`, `do`

| Method | Description |
|--------|-------------|
| `panelCdp.getCdpEndpoint` |  |
| `panelCdp.navigate` |  |
| `panelCdp.reload` |  |
| `panelCdp.goBack` |  |
| `panelCdp.goForward` |  |
| `panelCdp.stop` |  |
| `panelCdp.consoleHistory` |  |

## `panelLog`

Forward panel console errors and lifecycle events into unit diagnostics

Allowed callers: `shell`, `server`

| Method | Description |
|--------|-------------|
| `panelLog.append` |  |

## `panelRuntime`

Panel runtime lease coordination

Allowed callers: `shell`, `app`, `server`

| Method | Description |
|--------|-------------|
| `panelRuntime.registerClient` |  |
| `panelRuntime.unregisterClient` |  |
| `panelRuntime.getSnapshot` |  |
| `panelRuntime.acquire` |  |
| `panelRuntime.takeOver` |  |
| `panelRuntime.release` |  |

## `presence`

Active shell/panel ownership

Allowed callers: `server`, `shell`

| Method | Description |
|--------|-------------|
| `presence.markPanelActive` |  |
| `presence.markPanelsOwned` |  |
| `presence.getPanelActiveOwner` |  |

## `push`

Push notification device registration and delivery

Allowed callers: `shell`, `app`, `server`

| Method | Description |
|--------|-------------|
| `push.register` |  |
| `push.unregister` |  |

## `runtime`

Runtime entity creation and retirement

Allowed callers: `panel`, `app`, `shell`, `server`, `worker`, `do`, `harness`

| Method | Description |
|--------|-------------|
| `runtime.createEntity` | Create a runtime entity (panel, worker, or DO). |
| `runtime.retireEntity` | Retire a single entity, firing cleanup hooks. With removeContext, also delete the context folder when no other live entity shares the context. |
| `runtime.listEntities` | List live entities (id, kind, source, contextId, title, createdAt). |
| `runtime.resolveContext` | Return the contextId for an entity (or null if unknown). Cached read; falls back to DO. |
| `runtime.setTitle` | Set a server-controlled display title for the calling entity. Surfaced by approval UIs in place of the opaque id. Pass null/empty to clear. |

## `scope`

REPL scope persistence backed by an internal Durable Object

Allowed callers: `panel`, `app`, `worker`, `do`, `extension`, `shell`, `server`

| Method | Description |
|--------|-------------|
| `scope.upsert` |  |
| `scope.loadCurrent` |  |
| `scope.get` |  |
| `scope.list` |  |

## `shellApproval`

Shell-owned consent approval queue

Allowed callers: `shell`, `app`, `server`

| Method | Description |
|--------|-------------|
| `shellApproval.resolve` |  |
| `shellApproval.resolveBootstrap` |  |
| `shellApproval.resolveUserland` |  |
| `shellApproval.submitClientConfig` |  |
| `shellApproval.submitCredentialInput` |  |
| `shellApproval.listPending` |  |

## `shellPresence`

Tracks active shell clients for push notification delivery decisions

Allowed callers: `shell`, `app`, `server`

| Method | Description |
|--------|-------------|
| `shellPresence.heartbeat` |  |

## `tokens`

Token management for non-panel bearers and admin token rotation

Allowed callers: `server`, `shell`

| Method | Description |
|--------|-------------|
| `tokens.create` |  |
| `tokens.ensure` |  |
| `tokens.revoke` |  |
| `tokens.get` |  |
| `tokens.rotateAdmin` |  |

## `vcs`

Workspace version control (GAD-native): commit, status, log, diff

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`, `harness`

| Method | Description |
|--------|-------------|
| `vcs.applyEdits` |  |
| `vcs.readFile` |  |
| `vcs.listFiles` |  |
| `vcs.revert` |  |
| `vcs.status` |  |
| `vcs.unitStatus` |  |
| `vcs.log` |  |
| `vcs.diff` |  |
| `vcs.resolveHead` |  |
| `vcs.merge` |  |
| `vcs.abortMerge` |  |
| `vcs.pendingMerge` |  |
| `vcs.publishStatus` |  |
| `vcs.publish` |  |
| `vcs.recall` |  |

## `webhookIngress`

Generic public webhook ingress subscriptions

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `webhookIngress.createSubscription` |  |
| `webhookIngress.listSubscriptions` |  |
| `webhookIngress.revokeSubscription` |  |
| `webhookIngress.rotateSecret` |  |

## `workerdInspector`

Approval-gated workerd V8 inspector access for profiling workers and DOs

Allowed callers: `shell`, `server`, `panel`, `worker`, `do`

| Method | Description |
|--------|-------------|
| `workerdInspector.listTargets` |  |
| `workerdInspector.getEndpoint` |  |

## `workerLog`

Forward DO console output to the server terminal and the workspace-unit log stream

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `workerLog.write` |  |

## `workers`

Worker discovery and userland service resolution

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `workers.listSources` | List available worker sources with durable object classes |
| `workers.listServices` | List manifest-declared userland services |
| `workers.resolveService` | Resolve a userland service by name or protocol |
| `workers.resolveDurableObject` | Resolve a Durable Object RPC target by source/class/key |

## `workspace`

Workspace catalog, configuration, and lifecycle (list, create, switch, etc.)

Allowed callers: `shell`, `shell-remote`, `app`, `panel`, `worker`, `do`, `extension`, `server`

| Method | Description |
|--------|-------------|
| `workspace.getInfo` |  |
| `workspace.list` |  |
| `workspace.getActive` |  |
| `workspace.getActiveEntry` |  |
| `workspace.getConfig` |  |
| `workspace.create` |  |
| `workspace.delete` |  |
| `workspace.select` |  |
| `workspace.setInitPanels` |  |
| `workspace.setConfigField` |  |
| `workspace.getAgentsMd` |  |
| `workspace.listSkills` |  |
| `workspace.readSkill` |  |
| `workspace.sourceTree` |  |
| `workspace.findUnitForPath` |  |
| `workspace.units.list` |  |
| `workspace.units.inspector` |  |
| `workspace.units.restart` |  |
| `workspace.units.logs` |  |
| `workspace.units.diagnostics` |  |
| `workspace.units.versions` |  |
| `workspace.units.rollback` |  |
| `workspace.units.bakeAppDist` |  |
| `workspace.recurring.list` |  |
| `workspace.hostTargets.list` |  |
| `workspace.hostTargets.getSelection` |  |
| `workspace.hostTargets.setSelection` |  |
| `workspace.hostTargets.clearSelection` |  |
| `workspace.hostTargets.versions` |  |
| `workspace.hostTargets.preparePinnedRef` |  |
| `workspace.hostTargets.launch` |  |
| `workspace.hostTargets.beginLaunch` |  |
| `workspace.hostTargets.getLaunchSession` |  |
| `workspace.hostTargets.resolveLaunchSessionApproval` |  |
| `workspace.hostTargets.cancelLaunchSession` |  |

## `workspace-state`

Workspace slot/entity state (WorkspaceDO).

Allowed callers: `shell`, `app`, `server`, `panel`, `worker`, `do`

| Method | Description |
|--------|-------------|
| `workspace-state.slot.list` | List open slots. |
| `workspace-state.slot.get` | Get a single slot row by id. |
| `workspace-state.slot.history` | Get the history for a slot. |
| `workspace-state.entity.resolveActive` | Resolve a single active entity record by id. |
| `workspace-state.slot.create` | Create a new slot row. |
| `workspace-state.slot.appendHistory` | Append a history entry to a slot. |
| `workspace-state.slot.setCurrent` | Move a slot's current pointer to an existing history entry. |
| `workspace-state.slot.updateCurrentStateArgs` | Mutate the stateArgs for a slot's current history entry. |
| `workspace-state.slot.replaceHistory` | Replace a slot's history with the given entries and cursor. |
| `workspace-state.slot.setParent` | Reparent a slot. |
| `workspace-state.slot.setPosition` | Update a slot's position rank. |
| `workspace-state.slot.move` | Atomically update a slot's parent and position. |
| `workspace-state.slot.close` | Mark a slot closed. |
| `workspace-state.panel.search` | FTS5 search over panel entities. |
| `workspace-state.panel.index` | Upsert a panel's search-metadata row. |
| `workspace-state.panel.updateTitle` | Update the searchable title for a panel entity. |
| `workspace-state.panel.incrementAccess` | Bump the access counter for a panel entity. |
| `workspace-state.panel.rebuildIndex` | Rebuild the panel-search index from active panel entities. |

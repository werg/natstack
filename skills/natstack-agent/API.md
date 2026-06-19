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

Allowed callers: `server`, `shell`

| Method | Description |
|--------|-------------|
| `auth.grantConnection` | Mint a short-lived connection token for a panel/app caller (requires the panel-hosting capability), granting it access to the gateway. |
| `auth.getConnectionInfo` | Report how clients should reach this gateway: server/connect URLs, protocol, server identity, and current workspace. |
| `auth.createPairingInvite` | Create a one-time device-pairing invite (code + deep link) for this server; requires the connection-management capability and is audit-logged. |
| `auth.listDevices` | List paired devices for this server (refresh-token secrets stripped). |
| `auth.revokeDevice` | Revoke a paired device by id, invalidating its shell token and retiring any mobile-app principal; audit-logged. Returns whether a device was revoked. |

## `blobstore`

Per-workspace content-addressable blob storage

Allowed callers: `panel`, `app`, `worker`, `do`, `shell`, `server`

| Method | Description |
|--------|-------------|
| `blobstore.has` | Whether a blob with this content digest exists in the workspace store. |
| `blobstore.stat` | Size (bytes) and last-modified time of a blob, or null if it does not exist. |
| `blobstore.putText` | Store a UTF-8 string; returns its content digest + byte size. Content-addressed, so identical text always yields the same digest (idempotent). |
| `blobstore.getText` | Full UTF-8 text of a blob, or null if absent. |
| `blobstore.getRange` | UTF-8 text slice. offset/length are BYTES (so they compose with stat.size); the returned string is UTF-8-decoded, so partial codepoints at slice boundaries become U+FFFD replacement chars. Use getRangeBytes for a raw binary slice. |
| `blobstore.getRangeBytes` | Raw byte slice, base64-encoded on the wire so binary blobs (PDFs, images) round-trip intact. Decode with Buffer.from(result.bytesBase64, 'base64'). |
| `blobstore.grep` | Search a blob's text for a regex pattern; returns matching lines with optional surrounding context, or null if the blob is absent. |
| `blobstore.putBase64` | Store raw bytes from a base64 payload; returns content digest + byte size (idempotent by content). |
| `blobstore.getBase64` | Full blob contents as a base64 string, or null if absent. |
| `blobstore.delete` | Delete a blob by digest; returns true if it existed. Destructive, admin-only. |
| `blobstore.list` | List blob digests, optionally filtered by hex prefix and capped by limit. Admin-only. |
| `blobstore.pruneUnreferenced` | Garbage-collect blobs not in the `referenced` set (optionally only those older than olderThanMs). Pass dryRun:true to preview without deleting. Destructive, admin-only. |

## `build`

Build system (getBuild, getBuildNpm, recompute, gc, getAboutPages)

Allowed callers: `panel`, `app`, `shell`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `build.getBuild` | Build a panel/worker/extension unit (or a library bundle) and return its artifacts. The optional ref selects the workspace state to build from: omitted = main HEAD, a head name (e.g. 'ctx:abc'), or an immutable 'state:…' hash. Results are cached by content-derived build key, so rebuilding an unchanged unit reuses the cache. |
| `build.getBuildNpm` | Build an npm package as a CJS library bundle for sandbox use, leaving the given externals unbundled. |
| `build.getBuildMetadata` | Cached build metadata for an immutable build key, or null if it is not cached. Includes the unit's most recent structured build diagnostics (esbuild + tsc) when any were captured. |
| `build.getBuildReport` | Queryable companion to the synchronous push gate: build a unit (runtime, or library targets for packages) at the given workspace state (omitted = main HEAD) and return its agent-actionable RepoBuildReport with structured esbuild + tsc diagnostics. Does NOT advance any head. |
| `build.getEffectiveVersion` | Effective version (content-derived identity) of a workspace unit, or null if unknown. |
| `build.inspectBuildProvenance` | Resolve a workspace build unit (by name, relative path, or basename) and report its effective version, immutable build keys, and cached artifact metadata. Reports ambiguity when a basename matches multiple units. |
| `build.listRecentBuildEvents` | List recent state-triggered build lifecycle events and failures, optionally filtered by unit name or workspace-relative path. |
| `build.doctorExtension` | Inspect an extension manifest, dependency routing, cached metadata, and smoke/build status. |
| `build.recompute` | Rediscover the package graph, recompute every unit's effective version, rebuild any changed buildable units, and return the set of changed/added/removed units. |
| `build.gc` | Garbage-collect cached build artifacts not referenced by the given active units; returns the number of artifacts freed. |
| `build.getAboutPages` | List available about pages for the launcher UI. |
| `build.hasUnit` | Whether a build unit with this name exists in the workspace graph. |
| `build.getPanelMetadata` | Launcher metadata (source path, title, description, launcher visibility) for a panel unit, or null if the name is absent or not a panel. |
| `build.listSkills` | List available workspace skill packages that can be loaded via the eval imports parameter. |

## `credentials`

URL-bound userland credential storage and egress

Allowed callers: `shell`, `app`, `panel`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `credentials.storeCredential` | Persist a URL-bound credential (label, audience, injection, secret material); userland callers are prompted to approve it before it is stored, and the returned summary never echoes the secret. |
| `credentials.connect` | Run a connection flow (OAuth2/OAuth1a/API-key/SSH/browser-session) to obtain and store a credential; interactive flows open a browser sign-in and may return a DeferredResult for hibernatable DO callers. |
| `credentials.configureClient` | Store (versioned) OAuth client configuration — authorize/token URLs and client fields such as client id/secret; userland callers are prompted to submit the material, and secrets are never returned in the status. |
| `credentials.requestCredentialInput` | Prompt the user to enter exactly one secret field, then store the resulting credential; the submitted secret is never returned in the summary. |
| `credentials.getClientConfigStatus` | Return the configured status of an OAuth client config (which fields are set, URLs, status) without revealing secret values; rejects callers outside the config's trust scope. |
| `credentials.deleteClientConfig` | Disable a client config (marks it deleted so it is no longer used for new connections or refreshes); userland callers are prompted to confirm and only the config's owner may delete it. |
| `credentials.forwardOAuthCallback` | Deliver an inbound OAuth provider callback (code/state, or a full callback URL) to its pending connection transaction, validating the caller against the transaction's redirect strategy. |
| `credentials.listStoredCredentials` | List summaries of stored URL-bound credentials visible to the caller; secret material is never included. |
| `credentials.inspectStoredCredentials` | List administrator-facing credential summaries with runtime usage metadata; secret material is never included. |
| `credentials.revokeCredential` | Revoke a stored credential by id (marks it revoked and best-effort revokes the upstream provider token); only an authorized administrator of the credential may call it. |
| `credentials.resolveCredential` | Locate a stored credential by url/provider/id and authorize its use for the caller, returning a summary, null when nothing matches, or a DeferredResult while a use-approval prompt is awaited. |
| `credentials.proxyFetch` | Forward an outbound HTTP request through the egress proxy, injecting the resolved credential; returns status, ordered header pairs, final URL, and a base64 body. |
| `credentials.proxyGitHttp` | Forward a Git smart-HTTP request through the egress proxy with credential injection; the request/response bodies are base64-encoded. |
| `credentials.audit` | Query the credential egress audit log (optionally filtered by provider/connection/caller/since, paged by limit/after). |

## `docs`

Agent-facing capability catalog: discover services and runtime APIs with typed schemas, access rules, and examples (results filtered to what the caller may invoke).

Allowed callers: `panel`, `app`, `worker`, `do`, `extension`, `server`, `shell`

| Method | Description |
|--------|-------------|
| `docs.search` | Search the capability catalog (services and runtime APIs) by keyword. Results are filtered to what the calling kind may invoke. Use docs.describe(id) for the full typed schema, access rules, and examples. |
| `docs.describe` | Return the full catalog entry for an id (typed args/returns schema, access/restrictedness, examples). Returns null if unknown or not visible to the caller. |
| `docs.getSchema` | Return just the args/returns JSON Schema for a catalog id. |
| `docs.listSurfaces` | List catalog surfaces and the number of entries the caller can see in each. |
| `docs.listServices` | List registered RPC services and their methods (per-service view with JSON-Schema args/returns), filtered to what the calling kind may invoke. Every service.method listed is callable as services.<service>.<method>(...). |
| `docs.describeService` | Describe one registered RPC service by name: its policy and every method the caller may invoke (with JSON-Schema args/returns). Returns null for an unknown service. |

## `eval`

Owner-scoped sandbox eval backed by a per-owner internal EvalDO

Allowed callers: `panel`, `app`, `worker`, `do`, `extension`, `shell`, `server`

| Method | Description |
|--------|-------------|
| `eval.run` | Run TypeScript/JS in the caller's per-owner EvalDO sandbox (persistent REPL scope + synchronous in-DO SQLite `db`). Owner is the verified caller; fs is scoped to the owner's context. |
| `eval.reset` | Reset the eval context: wipe the persistent scope + the user `db` tables (a fresh scope), preserving the kernel's own state. The owner's existing data is cleared. |
| `eval.startRun` | Start an eval run for a caller that cannot hold a connection (an agent DO): returns a runId at once; the eval runs server-held in the EvalDO and the result is delivered out-of-band (onEvalComplete) and/or polled via getRun. Connection-holding callers (panels/CLI) should use `run` for a one-request result. |
| `eval.getRun` | Poll an async run started with startRun: returns its status and (when done) result. |
| `eval.cancel` | Cancel a single in-flight or pending run by runId (CAS to cancelled, then abort its outbound calls so a run wedged on an rpc.call unwinds). Other runs and the persistent scope are untouched. A no-op if the run is already terminal. |
| `eval.forceReset` | Forced recovery for a wedged eval DO: cancel every non-terminal run, abort all in-flight runs, and reset the eval context (wipe scope + user db) IMMEDIATELY without waiting on the stuck run chain. Use when `reset` itself would hang behind a wedged run. |

## `externalOpen`

Approval-gated system browser opens

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `externalOpen.openExternal` | Open an http(s) or mailto URL in the host OS browser; approval-gated for code callers, returning the persisted approval decision when one was made. |

## `fs`

Per-context filesystem operations (sandboxed to context folder)

Allowed callers: `panel`, `app`, `server`, `worker`, `do`, `extension`, `shell`

| Method | Description |
|--------|-------------|
| `fs.readFile` | Read a file's contents. Overloaded: with an `encoding` argument the bytes are decoded and returned as a string; without one, raw bytes are returned base64-encoded in a binary envelope. (Server/shell callers prepend a contextId as the first argument.) |
| `fs.writeFile` | Write data to a file, replacing existing contents; context-scoped writes create missing parent directories. Data may be a UTF-8 string or a base64 binary envelope. GAD-tracked context paths commit through the VCS rather than the worktree. |
| `fs.appendFile` | Append data to the end of a file; context-scoped appends create the file and missing parent directories when absent. Data may be a UTF-8 string or a base64 binary envelope. |
| `fs.readdir` | List the entries of a directory; returns bare name strings, or Dirent-shaped objects with type flags when `withFileTypes` is set, optionally recursing into subdirectories. |
| `fs.mkdir` | Create a directory; with `recursive` it creates missing parents and returns the first-created path (relative to the context root), otherwise returns undefined. |
| `fs.rmdir` | Remove an empty directory; throws if the directory is not empty. |
| `fs.rm` | Remove a file or directory; `recursive` deletes a directory's contents and `force` suppresses errors for missing paths. |
| `fs.stat` | Return metadata (type flags, size, mtime/ctime, mode) for a path, following symlinks to their target. |
| `fs.lstat` | Like stat, but reports on the symlink itself rather than following it to its target. |
| `fs.exists` | Return whether a path exists and is accessible to the caller. |
| `fs.access` | Test a path's accessibility against the given fs.constants mode bits; resolves on success, throws on failure. |
| `fs.unlink` | Delete a single file (not a directory). |
| `fs.copyFile` | Copy a file from a source path to a destination path, overwriting the destination. |
| `fs.rename` | Move or rename a file or directory from a source path to a destination path (also the atomic-write commit step for temp files moved into tracked paths). |
| `fs.realpath` | Resolve a path to its canonical form, returning it relative to the context root (sandboxed callers) or as an absolute host path (unrestricted callers). |
| `fs.ensureMaterialized` | Materialize the given workspace path(s)/repo(s) (or 'all') into the context working folder. Context folders are SPARSE — only what is materialized exists on disk — so call this for the narrowest scope you need (a repo path like 'panels/chat', a section like 'panels', or specific paths) before reading them OUTSIDE the fs.* API (e.g. a grep/find subprocess). fs.* reads materialize on demand automatically. |
| `fs.truncate` | Truncate (or zero-extend) a file to the given byte length (default 0). |
| `fs.readlink` | Read a symlink's target; absolute targets are relativized to the context root to avoid leaking host paths. |
| `fs.chmod` | Change a path's Unix permission bits (mode). |
| `fs.utimes` | Set a path's access and modification timestamps (seconds since the epoch). |
| `fs.grep` | Search file contents under the context root for a regex pattern (the first argument), returning matching lines with optional context; uses ripgrep when available with a pure-JS fallback, skipping .git, node_modules, symlinks, and binary files. |
| `fs.glob` | Find files whose path matches a glob pattern (the first argument) under the context root, returned newest-first by mtime; skips .git, node_modules, and symlinks. |
| `fs.open` | Open a file with the given flags (default 'r') and optional mode, returning a server-tracked handleId for subsequent handleRead/handleWrite/handleStat/handleClose calls; handles are caller-scoped and auto-close after 5 minutes idle. |
| `fs.handleRead` | Read up to `length` bytes from an open handle at the given position (null reads from the current offset), returning the bytes base64-encoded plus the count actually read. |
| `fs.handleWrite` | Write data (UTF-8 string or base64 binary envelope) to an open handle at the given position (null appends at the current offset), returning the byte count written. |
| `fs.handleClose` | Close an open file handle and release its server-side resources; a no-op if the handle is already gone. |
| `fs.handleStat` | Return metadata (type flags, size, mtime/ctime, mode) for the file behind an open handle. |
| `fs.mktemp` | Create the context's `.tmp/` directory if needed and return a fresh, unused root-relative scratch path under it (for direct fs write-to-temp-then-rename patterns); the file itself is not created, the prefix is sanitized, and the path is not a tracked edit/VCS destination. |

## `gitInterop`

External Git interop: declared remotes and remote project imports

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `gitInterop.setSharedRemote` | Declare or update the external Git remote shared across workspace contexts for a unit, persisting it to meta/natstack.yml and syncing it into the repo's git config; may prompt for capability approval. |
| `gitInterop.removeSharedRemote` | Remove a named shared Git remote declaration for a workspace unit from meta/natstack.yml and sync the repo's git config; may prompt for capability approval. |
| `gitInterop.importProject` | Clone an external Git project into the workspace at the requested path and record its remote in meta/natstack.yml; clones over the network and may prompt for config-write approval. |
| `gitInterop.completeWorkspaceDependencies` | Clone every remote declared in meta/natstack.yml whose unit is not yet present in the workspace, skipping already-present or unsupported paths; returns per-unit imported/skipped/failed results. |

## `notification`

Push notifications to the shell chrome area

Allowed callers: `shell`, `app`, `panel`, `worker`, `do`, `extension`, `server`

| Method | Description |
|--------|-------------|
| `notification.show` | Show a notification in the shell chrome; returns its id (auto-generated when not supplied). |
| `notification.dismiss` | Dismiss the notification with the given id, rejecting any pending waitForAction for it. |
| `notification.reportAction` | Report that the user took an action on a notification, emitting an event and resolving any pending waitForAction. |

## `panelCdp`

Approval-gated server CDP access for panel targets

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`

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
| `panelLog.append` | Forward a batch of panel console/lifecycle records (max 200) from the Electron shell into the server's runtime-diagnostics store. |

## `panelRuntime`

Panel runtime lease coordination

Allowed callers: `shell`, `app`, `server`

| Method | Description |
|--------|-------------|
| `panelRuntime.registerClient` | Register (or refresh) a panel-hosting client session so it can be assigned runtime leases. |
| `panelRuntime.unregisterClient` | Unregister a client session by id, releasing any leases it held and reassigning default CDP hosts as needed. |
| `panelRuntime.getSnapshot` | Get the current lease snapshot (version + all active panel runtime leases). |
| `panelRuntime.acquire` | Acquire the runtime lease for a panel entity. Succeeds for the current holder or an unleased entity; otherwise returns acquired:false with the existing lease. |
| `panelRuntime.takeOver` | Forcibly take over a panel entity's runtime lease, revoking and closing any conflicting holder's connection. |
| `panelRuntime.release` | Release the lease for a panel entity held by the given connection id. No-op unless the connection matches the current holder. |

## `panelTree`

Server-mediated panel tree handles and control operations

Allowed callers: `panel`, `worker`, `do`, `shell`, `server`, `app`

| Method | Description |
|--------|-------------|
| `panelTree.list` | List the children of a panel (or the root panels when the parent id is null/omitted). |
| `panelTree.roots` | List all root-level panels in the tree. |
| `panelTree.getTreeSnapshot` | Return a full snapshot of the panel tree (revision plus root panels). |
| `panelTree.getFocusedPanelId` | Return the id of the currently focused panel, or null if none is focused. |
| `panelTree.create` | Create a new panel from a workspace source path, optionally nested under a parent and focused. |
| `panelTree.ensureLoaded` | Ensure the panel's runtime is loaded (building/restoring it if needed) without changing focus. |
| `panelTree.focus` | Focus a panel, loading its runtime first if it is not already loaded. |
| `panelTree.getRuntimeLease` | Return the current runtime lease held on a panel (which host/connection owns it), or null if unleased. |
| `panelTree.getStateArgs` | Return the validated state-args currently bound to a panel. |
| `panelTree.setStateArgs` | Replace a panel's state-args; returns the resulting validated state-args. |
| `panelTree.reload` | Reload a panel's view in place, keeping its current snapshot. |
| `panelTree.close` | Close a panel, removing it (and its subtree) from the tree. |
| `panelTree.archive` | Archive a panel, removing it from the active tree while preserving its history. |
| `panelTree.unload` | Unload a panel's runtime/view to free resources while keeping the panel in the tree. |
| `panelTree.movePanel` | Reparent and/or reposition a panel among its siblings (drag-and-drop move). |
| `panelTree.navigate` | Navigate an existing panel to a new source path (optionally changing ref/context), returning the new panel descriptor or null. |
| `panelTree.navigateHistory` | Move a panel backward (-1) or forward (1) through its navigation history, returning the resulting panel descriptor or null. |
| `panelTree.takeOver` | Take over a panel's runtime lease for the calling client, focusing it on this host. |
| `panelTree.openDevTools` | Open developer tools for a panel, optionally docked to a side or detached. |
| `panelTree.rebuildPanel` | Rebuild a panel's runtime artifacts from source without reloading its view. |
| `panelTree.rebuildAndReload` | Rebuild a panel's runtime artifacts from source and then reload its view. |
| `panelTree.updatePanelState` | Update a panel's live navigation state (url, page title, loading/back/forward flags) from the rendering surface. |
| `panelTree.snapshot` | Return the current snapshot/configuration of a single panel. |
| `panelTree.callAgent` | Invoke a panel's in-process agent method (e.g. _agent.snapshot/_agent.tree/_agent.setMode) with optional arguments. |
| `panelTree.metadata` | Return the full Panel metadata for a panel id, or null if it does not exist. |
| `panelTree.getCollapsedIds` | Return the ids of panels that are currently collapsed in the tree UI. |
| `panelTree.setCollapsed` | Set whether a panel is collapsed in the tree UI. |
| `panelTree.expandIds` | Expand (un-collapse) a set of panels in the tree UI. |

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
| `push.register` | Register a device's push token for a client id, persisting it so it survives server restarts. |
| `push.unregister` | Remove the persisted push registration for a client id; returns whether one existed. |

## `runtime`

Runtime entity creation and retirement

Allowed callers: `panel`, `app`, `shell`, `server`, `worker`, `do`

| Method | Description |
|--------|-------------|
| `runtime.createEntity` | Create a runtime entity (panel, app, worker, DO, or session) and commit its durable identity. Reuses/reactivates an existing row for the same canonical key. Returns the entity handle (id + runtime targetId). |
| `runtime.retireEntity` | Retire a single entity, firing cleanup hooks. With removeContext, also delete the context folder when no other live entity shares the context. |
| `runtime.listEntities` | List live entities (id, kind, source, contextId, title, createdAt). |
| `runtime.resolveContext` | Return the contextId for an entity (or null if unknown). Cached read; falls back to DO. |
| `runtime.createContext` | Create a full logical workspace context branch. Every context presents the whole workspace tree; per-repo ctx heads are created lazily as edits are made. Use vcs.contextStatus to inspect uncommitted changes, ahead/behind repos, and deleted refs. |
| `runtime.cloneContext` | Clone a context's durable state — every worker/DO's storage plus the VCS working snapshot (committed + uncommitted) — into a fresh, isolated context. Returns the new contextId and the source→clone entity map. The caller drives any per-entity rewiring (e.g. a fork re-rooting logs at a point) on the returned clones; the clones are launched parented to the caller, so the caller may freely destroyContext them. |
| `runtime.destroyContext` | Retire every entity in a context and delete its folder + VCS state. Free for your own context or one you fully own (every active entity was launched by you); gated when destroying another agent or panel's existing context. |

## `shellApproval`

Shell-owned consent approval queue

Allowed callers: `shell`, `app`, `server`

| Method | Description |
|--------|-------------|
| `shellApproval.resolve` | Record the user's decision (once/session/version/repo/deny/dismiss) on a pending approval, resolving its queued request. |
| `shellApproval.resolveBootstrap` | Resolve a pending startup-app (bootstrap unit) approval with an allow-once or deny decision; rejects if the id is not a pending bootstrap approval. |
| `shellApproval.resolveUserland` | Resolve a pending userland approval by selecting one of the presented option values (or 'dismiss'); rejects if the choice was not offered to the user. |
| `shellApproval.submitClientConfig` | Submit the user-entered client-configuration field values for a pending approval, fulfilling its config request. |
| `shellApproval.submitCredentialInput` | Submit the user-entered credential/secret field values for a pending approval, fulfilling its credential-input request. |
| `shellApproval.submitSecretInput` |  |
| `shellApproval.listPending` | List the approvals currently awaiting a decision, used to rehydrate the consent approval bar on mount. |

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
| `tokens.create` | Mint a fresh bearer token for a non-panel caller id with the given caller kind, replacing any existing token for that id. |
| `tokens.ensure` | Return the existing bearer token for a caller id, minting one with the given caller kind only if none exists yet (idempotent). |
| `tokens.revoke` | Revoke the bearer token for a caller id; a no-op if no token is registered for it. |
| `tokens.get` | Look up the current bearer token for a caller id, or null if none is registered. |
| `tokens.rotateAdmin` | Generate a new random admin token, persist it (when persistence is configured) before swapping it in, and return the new value. |

## `vcs`

Workspace version control (GAD-native): commit, status, log, diff

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `vcs.edit` | Record a batch of file edits as UNCOMMITTED WORKING changes on the caller's context head — tracked durably with full provenance, but NOT a commit: no commit-log entry, no head advance, no build, and they never appear in vcs.log. Edits route to their owning repo by path. Make deliberate milestones with vcs.commit. Edits target a `ctx:*` head; `main` advances only via push. |
| `vcs.commit` | Fold the caller context's uncommitted working edits into ONE deliberate, messaged snapshot per repo, advancing each repo's context head and owning exactly those edits (queryable via commitEdits). `message` is mandatory. `exclude` leaves listed paths uncommitted (the inverse of `git add`). A repo with a pending merge commits the resolution. `main` is rejected (push only). |
| `vcs.discardEdits` | Drop a repo's uncommitted working edits on the caller's context head AND clear any in-progress merge, restoring the committed head on disk (abort / stash-drop). |
| `vcs.commitEdits` | List the edit-ops a commit owns (commit → its edits), by commit event id. Index-backed; ordered by the edit replay order. |
| `vcs.fileHistory` | File history / blame: every edit to a path in COMMIT-lineage order (committed commits first, then the uncommitted working tail on the given head). Index-backed. |
| `vcs.commitAncestors` | Walk a commit's ancestry in the event-keyed commit DAG (by commit event id, not state hash — distinct commits can share content). Returns each commit's parents. |
| `vcs.editsByActor` | Every edit authored by an actor (author provenance), across commits — index-backed. |
| `vcs.editsByTurn` | Every edit authored in an agent turn (causal provenance — ties VCS edits to the agentic trajectory). Index-backed. |
| `vcs.editsByInvocation` | Every edit authored in a single tool-call invocation (causal provenance). Index-backed. |
| `vcs.previewBuild` | On-demand build of the caller context's WORKING content (committed head + uncommitted edits), scoped to specific repos or units. Does NOT touch the published EV baseline — builds happen authoritatively only at push. Use for a dev preview without committing. |
| `vcs.readFile` | Read one file's content (text or base64 bytes) at a VCS ref, with its state/content hashes and mode; returns null if the path is absent. Empty ref ⇒ the caller's current head. Pass repoPath to read from a specific repo's head (path repo-relative). |
| `vcs.listFiles` | List every file (path, content hash, mode) at a VCS ref; omit the ref for the caller's current head. Pass repoPath to list a single repo's head. |
| `vcs.revert` | Undo a prior change by forward-applying its inverse patch onto the caller's head, advancing it; target the change by state hash or event id. Pass repoPath to revert on a specific repo's log. |
| `vcs.status` | Unpushed changes on a repo's head relative to that repo's main: the added/removed/changed paths plus the head state and whether it is ahead of main. Not a filesystem scan. repoPath is required (per-repo VCS). |
| `vcs.log` | Commit log for a repo's head, most recent first, capped by limit (default 50). repoPath is required (per-repo VCS). |
| `vcs.diff` | Diff two GAD states by their `state:…` hashes, returning the added/removed/changed files between them. |
| `vcs.resolveHead` | Resolve a ref to its head name and current `state:…` hash on a repo's log. Omit the ref for the caller's current context head; pass "main"/"ctx:…" for an explicit ref, and repoPath to scope to a repo. |
| `vcs.workspaceViewWithRepoAt` | Compose a workspace-rooted state view with one repo replaced by a repo-rooted state hash (or removed when null). Use this to convert a repo state from vcs.log/vcs.commit/vcs.resolveHead into the immutable state ref that build.getBuild expects. |
| `vcs.merge` | Reconcile divergence: pull `main` into the caller's context head on a repo, producing a MERGE COMMIT. Clean (no overlaps) commits with no file resolution; in-file conflicts materialize markers into the context filesystem — resolve via vcs.edit, then vcs.commit seals the merge. Returns the upstream commits + clean/conflict + conflictPaths. After merging, the context head descends from main so push fast-forwards. |
| `vcs.mergeGroup` | Coordinated multi-repo pull: merge each repo's source head into its target (default main). Best-effort per-repo (not the atomic group-push path). |
| `vcs.abortMerge` | Abort a pending (conflicted) merge on a repo's head, restoring its pre-merge tree; this is itself a head write. repoPath is required; omit head for the caller's own context head. |
| `vcs.pendingMerge` | Inspect a repo head's in-progress merge, if any: the source head being merged and its unresolved conflicts; null when no merge is pending. repoPath is required; omit head for the caller's own context head. |
| `vcs.push` | Publish one or more repos from the caller's context head to their main heads — the ONLY way main advances. FAST-FORWARD-ONLY, atomic across repos (all advance or none), build-gated. REJECTS (throws) if the source has uncommitted edits (vcs.commit or vcs.discardEdits first). Returns `pushed`/`up-to-date` with build reports; `diverged` with per-repo structured divergences (upstream commits + clean/conflict + conflictPaths) when main advanced past your base — reconcile with vcs.merge then re-push; or `build-failed` with diagnostics (no head advanced — fix and re-push). Shell/server may pass sourceHead explicitly; context callers may only push their own ctx head. |
| `vcs.pushStatus` | How far each repo's head is ahead of that repo's main: the unpushed change count and per-file changes a push would carry. |
| `vcs.forkRepo` | Fork a repo to a new path, preserving history: the new repo's log descends from the source's lineage (its `log` shows the inherited commits), so you can edit on top of the forked history. The package.json `name` leaf is rewritten to the new path so the fork is build-valid; deeper renames (component/class names) are yours to make, then push. |
| `vcs.deleteRepo` | SEVERE, global-state action: permanently remove a whole repo from the workspace. Distinct from edits — it archives the repo's history (moved to a recoverable archive head) and drops the repo from workspace main, deleting its working tree. Requires explicit user approval every time (a dedicated per-repo deletion grant that the ordinary write grant never covers). REFUSES if other repos depend on this one unless `force` is set (their builds will break). Rejects the `meta` repo and any path with no committed main. |
| `vcs.restoreRepo` | Recover a previously deleted repo by re-pointing its main at its archived history. FAILS if a different repo now occupies that path (re-created since the deletion) rather than clobbering it, and if there is nothing archived to restore. Requires user approval (re-adds the repo to workspace main). |
| `vcs.contextStatus` | Summarize the repos where your full workspace context branch differs from main or needs attention. `forked` = your branch has a committed ctx head for this repo; `uncommitted` = it carries uncommitted WORKING edits (vcs.commit them, or vcs.discardEdits); `ahead` = the committed head has commits not yet in main (push them); `behind` = main advanced past your pinned base (rebase/merge to pick it up); `deleted` = the repo was removed from the workspace (vcs.deleteRepo) while your branch still references it — a push will be refused, so drop/rebase your context or restore the repo. Only repos with changes or drift are returned. |
| `vcs.rebaseContext` | Pull the latest main into your context: 3-way merges main into each repo you've edited, then re-pins your context's base to the current workspace so unedited repos also advance to latest. Use when contextStatus shows repos `behind`. Returns each edited repo's merge status. |
| `vcs.recall` | Semantic recall over the workspace's VCS memory (log summaries, file snippets) matching a query; pass repoPaths to scope to selected repos. Returns ranked snippets with their head/event/path anchors. |

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

Allowed callers: `shell`, `server`, `panel`, `app`, `worker`, `do`

| Method | Description |
|--------|-------------|
| `workerdInspector.listTargets` |  |
| `workerdInspector.getEndpoint` |  |

## `workerLog`

Forward DO console output to the server terminal and the workspace-unit log stream

Allowed callers: `shell`, `panel`, `app`, `server`, `worker`, `do`, `extension`

| Method | Description |
|--------|-------------|
| `workerLog.write` | Forward one DO console line (level + message, plus optional source) to the server terminal and the workspace-unit log stream. |

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

Allowed callers: `shell`, `app`, `panel`, `worker`, `do`, `extension`, `server`

| Method | Description |
|--------|-------------|
| `workspace.getInfo` | Filesystem paths (source, state, contexts) and resolved config for the active workspace. |
| `workspace.list` | List all known workspaces in the catalog with their last-opened timestamps. |
| `workspace.getActive` | Name (id) of the currently active workspace. |
| `workspace.getActiveEntry` | Catalog entry (name + last-opened) for the currently active workspace. |
| `workspace.getConfig` | The active workspace's resolved config (meta/natstack.yml). |
| `workspace.create` | Create and register a new workspace on disk, optionally forking from an existing one; userland callers are approval-gated. |
| `workspace.delete` | Permanently delete a workspace directory and remove it from the catalog; refuses to delete the active workspace and is approval-gated for userland. |
| `workspace.select` | Switch the active workspace, touching the catalog and signalling the host to relaunch into it; disruptive and approval-gated for userland. |
| `workspace.setInitPanels` | Replace the set of panels opened when this workspace starts; approval-gated for userland. |
| `workspace.setConfigField` | Write an arbitrary field into the workspace config (meta/natstack.yml); approval-gated for userland. |
| `workspace.getAgentsMd` | Read the workspace-level meta/AGENTS.md, returning an empty string if it is absent. |
| `workspace.listSkills` | List skills under <workspace>/skills/* with name + description parsed from each SKILL.md frontmatter. |
| `workspace.readSkill` | Return the raw SKILL.md contents for a single skill by name (single-segment names only; path traversal is rejected). |
| `workspace.sourceTree` | Return the workspace source tree, annotating units, launchables, and skills. |
| `workspace.findUnitForPath` | Resolve a workspace-relative path to its owning unit and the path relative to that unit, or null if no unit owns it. |
| `workspace.units.list` | List operational status rows for all workspace units (panels, workers, extensions, apps), including build/health state. |
| `workspace.units.inspector` | Return the devtools inspector URL for a unit by name or source, or null if it has none. |
| `workspace.units.restart` | Restart a workspace unit through its owning manager. |
| `workspace.units.logs` | Query retained log records for a unit, optionally filtered by time/sequence cursor, level, and limit. |
| `workspace.units.diagnostics` | Return combined diagnostics for a unit: current status, recent logs, errors, build events, and buffer capacity. |
| `workspace.units.versions` | List the active build and rollback-capable previous versions for an app unit; userland is restricted to managing its own app. |
| `workspace.units.rollback` | Roll an app unit back to a previous active build (or a specific build key); userland is restricted to managing its own app. |
| `workspace.units.bakeAppDist` | Bake an app unit's active approved build into a packaging payload directory; trusted-chrome callers only. |
| `workspace.recurring.list` | List declarative scheduled jobs from meta/natstack.yml with their durable run state (next/last run, failures, backoff). |
| `workspace.heartbeats.list` | List registered heartbeats with their schedule, channel binding, and run state. |
| `workspace.heartbeats.runNow` | Trigger a heartbeat tick immediately for the selected heartbeat. |
| `workspace.heartbeats.pause` | Pause the selected heartbeat so it stops ticking until resumed. |
| `workspace.heartbeats.resume` | Resume a paused heartbeat so it resumes its schedule. |
| `workspace.hostTargets.list` | List app candidates selectable as the active app for a host target. |
| `workspace.hostTargets.getSelection` | Read the active per-workspace selection for a host target along with whether it is still valid. |
| `workspace.hostTargets.setSelection` | Persist the per-workspace app selection for a host target. |
| `workspace.hostTargets.clearSelection` | Clear the persisted per-workspace app selection for a host target. |
| `workspace.hostTargets.versions` | List retained versions for a specific host-target candidate. |
| `workspace.hostTargets.preparePinnedRef` | Materialize a retained build for a specific ref of a host-target candidate through the build system. |
| `workspace.hostTargets.launch` | Launch or reload the selected target app in this host, returning a ready/preparing/approval-required/unavailable status. |
| `workspace.hostTargets.beginLaunch` | Begin an asynchronous launch session for a host target, returning the initial session snapshot. |
| `workspace.hostTargets.getLaunchSession` | Fetch the current snapshot of a launch session by id, or null if it is unknown. |
| `workspace.hostTargets.resolveLaunchSessionApproval` | Resolve a pending approval on a launch session by allowing it once or denying it, returning the updated snapshot. |
| `workspace.hostTargets.cancelLaunchSession` | Cancel an in-flight launch session by id. |

## `workspace-state`

Workspace slot/entity state (WorkspaceDO).

Allowed callers: `shell`, `app`, `server`, `panel`, `worker`, `do`

| Method | Description |
|--------|-------------|
| `workspace-state.slot.list` | List open slots. |
| `workspace-state.slot.get` | Get a single slot row by id. |
| `workspace-state.slot.history` | Get the history for a slot. |
| `workspace-state.entity.resolveActive` | Resolve a single active entity record by id. |
| `workspace-state.slot.resolveByEntity` | Resolve the OPEN slot id whose current entity is the given runtime-entity (nav) id, or null. Durable nav→slot mapping used to nest launches under the owning panel's tree slot. |
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

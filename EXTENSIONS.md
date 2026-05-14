# Extension Services

> **Status:** Planning document — design resolved, not yet implemented.

NatStack extensions are **Node.js modules that run in a shared host process** alongside the server, activated eagerly at boot. They extend the application itself — adding new RPC services, reacting to system events, and exposing APIs to userland panels and workers — in the spirit of VSCode extensions, not browser extensions.

Extensions are **userland code**. They have access to the same runtime that panels and workers do (`fs`, `ai`, `git`, `panel`, `credentials`, …), and every call they make against those services flows through the same dispatcher and is subject to the same approval policy as a call from a panel or worker. There is no privileged "host authority" tier — being long-lived and in-process doesn't grant extra capability.

## Extensions vs. panels vs. workers

| | Extension | Panel | Worker |
|---|---|---|---|
| Process | Shared extension host (Node) | Isolated webview | Workerd isolate |
| Lifecycle | Activated eagerly on boot | Opened on user navigation | Spawned by request |
| API surface | Userland runtime | Userland runtime | Userland runtime |
| Reachable from outside | Only via the `extensions` RPC service | Direct (URL) | Direct (RPC) |
| Lives at | `{userData}/extensions/installed/<name>/` | `{workspace}/panels/<name>/` (or external URL) | `{workspace}/workers/<name>/` |

What distinguishes an extension is its lifecycle and its API: it activates at boot, stays resident, and exposes methods that other userland code (panels, workers, other extensions) can call via RPC. Everything else about it — what it can do, how it's gated — is the same as any other userland code.

## On-disk layout

Extensions live under the state directory next to `builds/` and `context-scopes/`:

```
{userData}/extensions/
├── installed/                       # active extensions (source on disk)
│   └── @acme/
│       └── git-tools/
│           ├── package.json
│           ├── index.ts
│           └── ...
├── storage/                         # per-extension scratch / state
│   └── @acme/
│       └── git-tools/
└── registry.json                    # name → { version, source, ref, sha, enabled, installedAt, integrity, bundleKey }
```

- Scoped package names map to two-level directory paths (`@acme/git-tools` → `@acme/git-tools/`) consistently in `installed/` and `storage/`.
- `registry.json` is written atomically (tmp + rename) under a per-process serial mutation lock. `bundleKey` records the active build artifact key in `{userData}/builds/` so the build-cache GC treats it as reachable.

There is no separate staging directory: the install pipeline writes the new tree into a sibling `installed/.tmp-<opaque-id>/`, validates and builds it, then atomic-renames over `installed/<name>/` in a single step. Stray `.tmp-*` directories from a crashed install are swept on boot.

Bundles are built JIT via the existing esbuild pipeline (see [BUILD_SYSTEM.md](BUILD_SYSTEM.md)) and the resulting artifact lives in `{userData}/builds/<key>/` keyed by content hash, the same as panels. The extension host pins active `bundleKey`s as GC roots.

`installed/` is the source of truth for what loads at startup. `registry.json` records provenance and enablement so disabled extensions stay on disk without being activated. `storage/<name>/` is exposed to the extension as `ctx.storage` and survives upgrades.

`getUserDataPath()` from `@natstack/env-paths` resolves the base. The same paths work in Electron and headless server modes.

## Extension package layout

```
@acme/git-tools/
├── package.json          # Manifest with natstack.extension field
├── index.ts              # Entry (TypeScript source)
└── ...
```

### Manifest

```json
{
  "name": "@acme/git-tools",
  "version": "1.2.0",
  "natstack": {
    "extension": {
      "displayName": "Git Tools",
      "entry": "index.ts",
      "activationEvents": ["*"]
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `displayName` | string | package name | Human-readable name for UI |
| `entry` | string | `index.ts` | Entry source file (built JIT by esbuild, same pipeline as panels) |
| `activationEvents` | string[] | `["*"]` | When to activate. `"*"` = eager at startup. Reserved for future lazy triggers; values other than `"*"` fail validation in v1. |

The presence of `natstack.extension` in `package.json` is what marks a package as an extension. Manifests are validated against a JSON schema at install time and again at boot; validation failures fail closed (extension is not activated and an error is recorded in the registry).

There is no `main` field and no `dist/` — extensions ship source. The host's esbuild pipeline produces the runtime bundle.

Extensions do not declare each other as dependencies. There is no declarative dependency graph — peer references are resolved entirely at runtime through `ctx.extensions.use(name)` / `onActivate`. Cross-extension type sharing is not a first-class concern in v1; consumers either define the interface they expect or duplicate the type. (See "Future work".)

## Activation contract

```ts
// @acme/git-tools/index.ts
import type { ExtensionContext } from "@natstack/extension";

export interface GitToolsApi {
  blame(path: string): Promise<BlameLine[]>;
}

export async function activate(ctx: ExtensionContext): Promise<GitToolsApi> {
  ctx.log.info("git-tools activating");

  await ctx.storage.mkdir("cache");

  ctx.subscriptions.push(
    ctx.panel.onOpened(p => ctx.log.debug("panel opened", p.id)),
  );

  return {
    async blame(path: string) { /* ... */ return []; },
  };
}

export async function deactivate(): Promise<void> {
  // optional cleanup; subscriptions are auto-disposed
}
```

`activate` returns the extension's **public API** — a plain object whose own enumerable function properties are callable by panels, workers, and other extensions over RPC. There is no per-method registration step and no allowlist captured at activation time. The RPC dispatcher resolves a call by reading `api[method]` and checking `Object.hasOwn(api, method) && typeof api[method] === "function"` at the time of the call. Anything else (`then`, `constructor`, inherited prototype methods, non-function properties) returns `ENOMETHOD`.

Methods can therefore be added to (or removed from) the API after `activate` returns — they become reachable / unreachable on the next call. The API object identity is stable for the lifetime of the activation; to swap it out, call `extensions.reload(name)`.

Returning `void` is valid — the extension is then "fire-and-forget" (only useful for side effects, e.g. registering event handlers).

## `ExtensionContext`

```ts
interface ExtensionContext {
  // Identity
  readonly name: string;          // "@acme/git-tools"
  readonly version: string;

  // Storage helper scoped to {userData}/extensions/storage/<name>/.
  // Convenience wrapper — for general filesystem access use ctx.fs
  // and accept approval prompts like any other userland code.
  readonly storage: ExtensionStorage;

  // Userland runtime — the same client surface panels and workers see.
  // Every call flows through the normal service dispatcher and is subject
  // to the same approval policy.
  readonly fs: FsClient;
  readonly ai: AiClient;
  readonly git: GitClient;
  readonly panel: PanelClient;
  readonly workspace: WorkspaceClient;
  readonly credentials: CredentialsClient;
  readonly db: DbClient;
  readonly webhooks: WebhooksClient;
  readonly approvals: ApprovalsClient;
  readonly notifications: NotificationsClient;
  readonly extensions: ExtensionsClient;

  // Lifecycle. Disposables are disposed in LIFO order on deactivate.
  readonly subscriptions: Disposable[];
  readonly log: Logger;

  // Events (visible to subscribed panels, workers, and other extensions)
  emit(event: string, payload: unknown): void;
}
```

The clients on `ctx` are the **same clients** that `@workspace/runtime` exposes — bound in-process to the dispatcher with `callerKind: "extension"` and `callerId: <extension name>`, so the approval UI can attribute the prompt ("Extension @acme/git-tools wants to …"). There is no separate privileged management surface: when an extension installs another extension it calls `ctx.extensions.install(...)`, which routes through the dispatcher and triggers the same approval prompt a panel would.

## The single `extensions` surface

There is exactly one way to reach an extension from outside the extension host: the dispatcher service named `extensions`. It mounts onto the existing dispatcher and is callable by every userland kind (`panel`, `worker`, `shell`, `extension`).

```ts
// dispatcher
{
  name: "extensions",
  policy: { allowed: ["panel", "worker", "shell", "extension"] },
  methods: {
    invoke:     { args: [z.string(), z.string(), z.array(z.unknown())] },
    list:       { args: [] },
    on:         { args: [z.string(), z.string()] }, // (extName, event) — returns subscription id
    install:    { /* approval-gated */ },
    uninstall:  { /* approval-gated */ },
    setEnabled: { /* approval-gated */ },
    reload:     { /* approval-gated */ },
  },
  async handler(ctx, method, args) {
    if (method === "invoke") {
      const [name, fn, params] = args;
      const entry = registry.get(name);
      if (!entry) throw new RpcError("ENOEXT", `extension not found: ${name}`);
      if (!Object.hasOwn(entry.api, fn) || typeof entry.api[fn] !== "function") {
        throw new RpcError("ENOMETHOD", `${name} does not expose ${fn}`);
      }
      return entry.api[fn](...params);
    }
    // ...
  },
}
```

`invoke`, `list`, and `on` are not approval-gated — they're userland code talking to userland code. The four management methods are approval-gated regardless of caller kind; an extension installing another extension prompts the user just like a panel doing the same thing.

Consumers — panels, workers, and other extensions — use the same thin client from `@workspace/runtime`:

```ts
import { extensions } from "@workspace/runtime";
import type { GitToolsApi } from "@acme/git-tools";

const git = extensions.use<GitToolsApi>("@acme/git-tools");
const lines = await git.blame("/foo.ts");

extensions.on("@acme/git-tools", "indexed", (payload) => {
  // ...
});

// Wait for an extension that may activate later (useful in another extension's activate())
extensions.onActivate<GitToolsApi>("@acme/git-tools", (api) => {
  // ...
});
```

`extensions.use()` returns a `Proxy` that turns property access into `rpc.call("extensions", "invoke", [name, prop, args])`. The proxy's `get` trap returns `undefined` for `then`, `Symbol.toPrimitive`, and other well-known protocol properties, so accidentally `await`ing the proxy itself (instead of a method result) does not round-trip to the extension.

Events ride the existing `RpcEvent` channel. `ctx.emit(event, payload)` in an extension fans out to subscribers via `extensions.on(name, event, cb)`. Internally, extension events are namespaced by extension name on the wire (e.g. `RpcEvent { service: "extensions", event: "<name>::<event>", payload }`) so two extensions emitting the same event name don't collide.

When the caller of `extensions.use()` is itself an extension, the dispatcher may short-circuit the RPC as an in-process function call for efficiency — but the contract is the same and the call is still observable as an `extensions.invoke` for tracing and policy purposes.

Extensions activate in unspecified order. Consumers that need another extension during their own `activate` must use `extensions.onActivate(name, cb)`. There is no declarative dependency graph and no topological sort — extensions wire themselves together explicitly, which removes a class of cycle / version-skew problems.

## Userland extension management

Userland code cannot bypass the extension manager — `installed/` and `storage/` live in the state directory, not the workspace, and panel `fs` is scoped to the context folder. To install, remove, enable, or reload extensions, callers go through the `extensions` service.

Every mutating method requests approval via the existing `approvals` service. Callers always invoke the management method directly; the approvals system itself decides whether to prompt the user, auto-grant from a saved preference, or apply a scoped grant.

```ts
import { extensions } from "@workspace/runtime";

// No approval — registry metadata only
await extensions.list();

// Approval required
await extensions.install({
  source: { kind: "internal-git", repo: "extensions/git-tools", ref: "v1.2.0" },
  // or { kind: "git",     url: "https://github.com/acme/git-tools", ref: "v1.2.0" }
  // or { kind: "tarball", url: "...", sha256: "..." }
  // or { kind: "local",   path: "/abs/path/to/dir" }   // dev convenience
});

await extensions.uninstall("@acme/git-tools");
await extensions.setEnabled("@acme/git-tools", false);
await extensions.reload("@acme/git-tools");          // re-resolve source ref + rebuild + reactivate
```

Approval prompt payloads are structured so the UI can render meaningful consent:

```ts
await approvals.request({
  kind: "extension.install",
  callerId: ctx.callerId,                          // includes which panel/worker/extension asked
  detail: {
    name: "@acme/git-tools",
    version: "1.2.0",
    source: { kind: "internal-git", repo: "extensions/git-tools", ref: "v1.2.0" },
    integrity: "sha256-...",
  },
});
```

Extensions drive installs the same way panels do, by calling `ctx.extensions.install(...)`. They are not exempt from approval — the user always sees who is asking.

| Method | Approval | Notes |
|--------|----------|-------|
| `list` | No | Returns `{name, version, enabled, displayName}[]` from `registry.json` |
| `install` | `extension.install` | See pipeline below |
| `uninstall` | `extension.uninstall` | Deactivates, removes `installed/<name>/`, updates registry; `storage/<name>/` is retained unless `purge: true` |
| `setEnabled` | `extension.toggle` | Persisted in registry; on disable, calls `deactivate()` and unloads |
| `reload` | `extension.reload` | Re-resolves the source ref, rebuilds, reactivates. Subscribers see an `extensions:reloaded` event before old subscriptions go dead. |

There is no `readFile` / `writeFile` over RPC. Source authoring happens against the source — internal git, an external git repo, or (for development) a local path. To push changes into the running system: commit, then call `reload`. This keeps the registry honest about provenance and removes the implicit "RPC write triggers reactivation" side effect.

## Install pipeline

1. **Approval granted** → fetch source into `installed/.tmp-<opaque-id>/`.
   - `internal-git`: clone/update from the workspace's internal git server. Record `repo` (path inside the internal git) and `sha` (resolved commit).
   - `git`: shallow clone, then `git rev-parse` to resolve the user-supplied ref (branch / tag / sha) to its commit sha. Record both `ref` (what the user asked for) and `sha` (what got installed).
   - `tarball`: stream + verify `sha256` (required for tarball sources).
   - `local`: copy (or symlink in dev). No integrity check.

2. **Validate** the temp directory against the manifest schema. Fail-closed on any error — the temp dir is removed.
   - `package.json` parses and contains `natstack.extension`.
   - `entry` resolves inside the directory (no `..` escape).
   - `activationEvents`, if present, contains only `"*"` in v1.

3. **Resolve dependencies** via the existing `build-artifacts/` pipeline (content-addressed `node_modules`, shared with panels).

4. **JIT build**: run esbuild on `entry` with target `node`, format `cjs`, Node built-ins externalized, and **inline source maps enabled** so runtime stack traces and the Node inspector point at the original TypeScript. The bundle lands at `{userData}/builds/<key>/extension.js` keyed by content hash. Build failures abort the install and remove the temp dir.

5. **Atomic promote**: rename `installed/.tmp-<opaque-id>/` → `installed/<name>/` (replacing any prior tree). Write `registry.json` atomically (tmp + rename) with the new `bundleKey`. Pin the `bundleKey` as a build-cache GC root.

6. **Activate**: `extensionHost.activate(name)` — `require()` the built bundle, call `activate(ctx)`, store the returned API in the registry.

7. **Emit** `extensions:installed` over the event channel.

Uninstall reverses: `deactivate()` → dispose subscriptions (LIFO) → evict from `require.cache` → `rm -rf installed/<name>/` → release the `bundleKey` GC pin → update registry → emit `extensions:uninstalled`. The built bundle is now eligible for build-cache GC; if a panel build still references it, it stays.

Reload is `uninstall + install` against the same source descriptor in one approval (`extension.reload`). The original `ref` is re-resolved against the source — branch refs move forward, pinned shas/tags don't.

### Integrity & pinning

| Source | Input ref | Stored | Mutable after install? |
|--------|-----------|--------|------------------------|
| `internal-git` | branch / tag / sha | resolved commit sha | No — reload re-resolves |
| `git`  | branch / tag / sha | resolved commit sha | No — reload re-resolves |
| `tarball` | URL + required `sha256` | sha256 of fetched bytes | No |
| `local` | path | path | Yes (dev convenience) |

This matches the lockfile pattern: users supply ergonomic refs, the registry stores what actually got installed.

## Activation lifecycle

- **Boot**:
  1. Sweep `installed/.tmp-*` directories left over from a crashed install.
  2. Walk `installed/`, cross-check against `registry.json`. Entries in `installed/` not present in the registry are orphans (a previous install that crashed before committing the registry) — they're logged and removed. Entries in the registry but missing from `installed/` are marked `error`.
  3. Filter by `registry.enabled` and activate. Activation order is unspecified; consumers requiring another extension use `extensions.onActivate`.
  4. Call `activate(ctx)` on each. Throws are caught, logged, marked `error` in the registry, and emitted as `extensions:error` events (so a notifications panel or status UI can surface them). One extension's failure does not block others.
- **Eager only for v1**. `activationEvents` is plumbed through but only `"*"` is accepted; other values fail validation.
- **Hot install**: a freshly installed extension activates immediately — no app restart. Module cache is clean for a new package.
- **Hot reload**: `reload` deactivates → disposes `ctx.subscriptions` in LIFO order → walks `require.cache` and deletes every entry whose resolved path is under the extension's built bundle directory in `builds/<bundleKey>/` (the bundle is a single file plus chunk assets, all under one key, so the eviction set is tight) → re-resolves the source ref → rebuilds → reactivates. Anything an extension registered outside `ctx.subscriptions` (raw `process.on(...)` listeners, setInterval timers, references held by other modules) leaks across a reload — extensions are expected to use `ctx.subscriptions` for everything. If an extension turns out to leak references in practice, the fix is in the extension, not the host.
- **Crash**: an extension throwing during `activate` is marked errored and does not block others. Crashes during a method call propagate as RPC errors to the caller; they do not take down the host. Uncaught exceptions in extension-registered event handlers are caught by a host-level `process.on("uncaughtException")` listener that logs, attributes to the extension if attributable, and continues — it does not crash the process.

## Dispatcher integration

Minimal change to `packages/shared/src/serviceDispatcher.ts`:

- Add `"extension"` to `CallerKind`.
- `ServiceContext.callerId` for an extension call is the extension name (`@acme/git-tools`).
- Every existing service definition gets `"extension"` added to its `policy.allowed` list explicitly — easier to read than a global rule, and forces an opt-in audit of every service.
- Log lines from service calls are tagged with the extension name as `callerId`.

Because extensions use the same client surface as panels and workers, their calls hit the same approval pipeline. No service does anything different based on `callerKind === "extension"` — the kind is purely an attribution label for logs and approval prompts.

The dispatcher does **not** root `fs` differently for extensions. `ctx.fs` is the same client a panel sees, subject to the same per-context constraints and approvals. The scoped `{userData}/extensions/storage/<name>/` view is provided by `ctx.storage`, a thin wrapper built in `packages/extension-host/`. The dispatcher stays oblivious.

## Extension host process

A new package `packages/extension-host/`:

```
packages/extension-host/
├── src/
│   ├── index.ts          # boot, sweep tmp dirs, walk installed/, activate all
│   ├── registry.ts       # in-memory map of name → { api, manifest, subs, bundleKey }
│   ├── context.ts        # ExtensionContext factory (binds runtime clients, ctx.storage)
│   ├── installer.ts      # install / uninstall / reload pipeline, registry.json atomic writes
│   ├── service.ts        # dispatcher service ("extensions") handler — invoke / on / management
│   └── loader.ts         # require + cache eviction
```

The host runs in-process with the server (single Node process). It mounts its `extensions` service onto the existing dispatcher. The Electron main process consumes the same package — there is one extension host per running NatStack instance, regardless of mode.

## Future work

Out of scope for v1, kept as forward-compat anchors:

- **Lazy activation**: the `activationEvents` field is plumbed through but only `"*"` is honored. Other triggers (`"onPanel:<source>"`, `"onCommand:<id>"`, …) can be added without breaking the manifest.
- **Per-workspace extensions**: if project-pinned versions become useful, a per-workspace install location (`{workspace}/.natstack/extensions/`) can layer over the per-user one. Resolution order: workspace > user. Not built yet.
- **Cross-extension type sharing**: today consumers either define interfaces themselves or duplicate types. A future iteration might auto-generate an aggregate `.d.ts` from active extensions' exports, or formalize a "types module" field in the manifest.
- **Per-extension `Module` isolation**: if hot-reload reference leaks become a real problem in practice, revisit loading each extension in its own `Module` instance or `vm` context.
- **npm registry as a source**: currently internal-git / git / tarball / local only. npm can be added as a fifth `source.kind` if there's demand.
- **Extensions shipping panels**: deliberately out of scope. Extensions register RPC APIs; if a UI is wanted, a separate panel can call into the extension. Revisit only if a concrete need appears.

## See also

- [PANEL_SYSTEM.md](PANEL_SYSTEM.md) — panel architecture
- [STATE_DIRECTORY.md](STATE_DIRECTORY.md) — `{userData}/` layout
- [PERMISSIONS.md](PERMISSIONS.md) — userland permission requirements (extensions are subject to these like any other userland code)
- [BUILD_SYSTEM.md](BUILD_SYSTEM.md) — `build-artifacts/` dep resolution (reused by extension installer)

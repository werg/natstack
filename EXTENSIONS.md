# Extension Services

> **Status:** Planning document — design resolved, not yet implemented.

NatStack extensions are **trusted Node.js modules** that run in a shared host process alongside the server. They extend the application itself — adding new RPC services, reacting to system events, and exposing APIs to userland panels — in the spirit of VSCode extensions, not browser extensions.

Extensions are **not** sandboxed. They run with the same authority as the core host: full filesystem access, the full service surface (`fs`, `ai`, `git`, `panel`, `credentials`, ...), and free communication with each other.

## Extensions vs. Panels

| | Extension | Panel |
|---|---|---|
| Trust | Trusted (full host authority) | Userland (sandboxed) |
| Process | Shared extension host (Node) | Isolated webview |
| Lifecycle | Activated eagerly on app / server start | Opened on user navigation |
| API surface | All core services unrestricted | Subset, gated by service policy |
| Talks to | Other extensions (in-process), host services, panels (via RPC) | Host services, parent panel, extensions (via RPC, mediated) |
| Lives at | `{userData}/extensions/installed/<name>/` | `{workspace}/panels/<name>/` (or external URL) |

Extensions and panels solve different problems. A panel is a UI surface a user navigates to; an extension is a background capability that augments the runtime.

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
├── staged/                          # in-flight installs (atomic-renamed on success)
│   └── <opaque-id>/                 # swept on boot
├── storage/                         # per-extension scratch / state
│   └── @acme/
│       └── git-tools/
├── node_modules/                    # symlink farm: <name> → ../installed/<name>
│   └── @acme/
│       └── git-tools -> ../../installed/@acme/git-tools
└── registry.json                    # name → { version, source, ref, sha, enabled, installedAt, integrity, bundleKey }
```

- Scoped package names map to two-level directory paths (`@acme/git-tools` → `@acme/git-tools/`) consistently in `installed/`, `storage/`, and `node_modules/`.
- `staged/` entries use opaque random ids (no scope) and are swept on boot in case the previous run crashed mid-install — same pattern as `blobs/tmp/`.
- `node_modules/` is a symlink farm refreshed on every install/uninstall. It lets cross-extension imports (`import type { GitToolsApi } from "@acme/git-tools"`) resolve for both the TS language server in the IDE and the host's esbuild step. Symlinks point at the source dirs in `installed/`, so types track the installed version automatically.
- `registry.json` is written atomically (tmp + rename) under a per-process serial mutation lock. `bundleKey` records the active build artifact key in `{userData}/builds/` so the build-cache GC treats it as reachable.

Bundles are not stored here — extensions are built JIT via the existing esbuild pipeline (see [BUILD_SYSTEM.md](BUILD_SYSTEM.md)) and the resulting artifact lives in `{userData}/builds/<key>/` keyed by content hash, the same as panels. The extension host pins active `bundleKey`s as GC roots.

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
      "activationEvents": ["*"],
      "requires": ["@acme/auth-helper"]
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `displayName` | string | package name | Human-readable name for UI |
| `entry` | string | `index.ts` | Entry source file (built JIT by esbuild, same pipeline as panels) |
| `activationEvents` | string[] | `["*"]` | When to activate. `"*"` = eager at startup. Reserved for future lazy triggers (`"onPanel:<source>"`, `"onCommand:<id>"`, ...). |
| `requires` | string[] | `[]` | Other extensions this one depends on. Honored for **activation order and type resolution only**, never for runtime bundling. |

The presence of `natstack.extension` in `package.json` is what marks a package as an extension. Manifests are validated against a JSON schema at install time and again at boot; validation failures fail closed (extension is not activated and an error is recorded in the registry).

There is no `main` field and no `dist/` — extensions ship source. Typed API consumers (other extensions, panels) import the package as a normal TypeScript package; the host's esbuild pipeline produces the runtime bundle.

**`requires` vs `dependencies`**: declare other extensions in `natstack.extension.requires`, never in npm `dependencies`. `dependencies` would cause npm tooling to try to install the extension from a registry and would bundle a private copy into the bundle. `requires` is resolved by the host: at build time, esbuild marks listed extensions as **external** (no bundling), and at runtime the consumer looks them up via `ctx.extensions.get(name)`.

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
    ctx.host.panel.onOpened(p => ctx.log.debug("panel opened", p.id)),
  );

  return {
    async blame(path: string) { /* ... */ return []; },
  };
}

export async function deactivate(): Promise<void> {
  // optional cleanup; subscriptions are auto-disposed
}
```

`activate` returns the extension's **public API**. The returned object is snapshotted at activation: the host records `Object.keys(api).filter(k => typeof api[k] === "function")` as the **exposed method allowlist**. Calls from panels (and other extensions over RPC) can only target a name in that allowlist; anything else returns `ENOMETHOD`. Non-function properties on the returned object are not reachable from outside. Returning `void` is valid — the extension is then "fire-and-forget" (only useful for side effects, e.g. registering event handlers).

## `ExtensionContext`

```ts
interface ExtensionContext {
  // Identity
  readonly name: string;          // "@acme/git-tools"
  readonly version: string;

  // Storage helper scoped to {userData}/extensions/storage/<name>/.
  // Convenience wrapper — extensions are trusted and may also use ctx.host.fs
  // to read/write anywhere on the host filesystem.
  readonly storage: ExtensionStorage;

  // Host service surface — same client API as the panel runtime, unrestricted.
  // ctx.host.fs is the full filesystem, NOT rooted at ctx.storage.
  readonly host: {
    fs: FsClient;
    ai: AiClient;
    git: GitClient;
    panel: PanelClient;
    workspace: WorkspaceClient;
    credentials: CredentialsClient;
    db: DbClient;
    webhooks: WebhooksClient;
    approvals: ApprovalsClient;
    notifications: NotificationsClient;
    extensions: ExtensionManagementClient; // install/uninstall/setEnabled/readFile/writeFile, no approvals
  };

  // Peer extensions — in-process direct calls, not RPC.
  readonly extensions: {
    get<T = unknown>(name: string): T | undefined;
    onActivate<T = unknown>(name: string, cb: (api: T) => void): Disposable;
    list(): ExtensionInfo[];
  };

  // Lifecycle. Disposables are disposed in LIFO order on deactivate.
  readonly subscriptions: Disposable[];
  readonly log: Logger;

  // Events (visible to subscribed panels and other extensions)
  emit(event: string, payload: unknown): void;
}
```

`host.*` is the same client library the panel runtime exposes, bound in-process to the dispatcher with `callerKind: "extension"`. No new API surface to learn — except `host.extensions`, which is the **privileged** management surface available to extensions (no approval prompts; that's what distinguishes it from the `extensions` RPC service panels call).

## Extension-to-extension communication

Same process, direct function calls — no RPC:

```ts
const git = ctx.extensions.get<GitToolsApi>("@acme/git-tools");
if (git) {
  const lines = await git.blame("/foo.ts");
}

// Wait for an extension that may activate later:
ctx.subscriptions.push(
  ctx.extensions.onActivate("@acme/git-tools", (api: GitToolsApi) => {
    // register integrations
  }),
);
```

**Activation order**: the host topologically sorts on `natstack.extension.requires`. Extensions without a dependency relation activate in unspecified order, so consumers without `requires` declarations must use `onActivate`. A cycle in `requires` fails closed — every extension in the cycle is skipped and marked `error` in the registry; extensions outside the cycle activate normally.

**Runtime resolution is always via the registry**, never via Node module resolution. The bundler treats names listed in `requires` as externals; the host wraps each external in a stub that calls `ctx.extensions.get(name)` on access. This is what avoids the "two copies of B" problem that would arise from declaring extensions as npm `dependencies`.

## Panel → extension (the only RPC boundary)

A single dispatcher service `extensions` routes calls into the registry:

```ts
// dispatcher
{
  name: "extensions",
  policy: { allowed: ["panel", "shell", "extension"] },
  methods: {
    invoke: { args: [z.string(), z.string(), z.array(z.unknown())] },
    list:   { args: [] },
    on:     { args: [z.string(), z.string()] }, // (extName, event) — returns subscription id
    // ...management methods (install, uninstall, setEnabled, readFile, writeFile)
  },
  async handler(ctx, method, args) {
    if (method === "invoke") {
      const [name, fn, params] = args;
      const entry = registry.get(name);
      if (!entry) throw new RpcError("ENOEXT", `extension not found: ${name}`);
      if (!entry.exposed.has(fn)) {
        throw new RpcError("ENOMETHOD", `${name} does not expose ${fn}`);
      }
      return entry.api[fn](...params);
    }
    // ...
  },
}
```

`entry.exposed` is the allowlist captured at activation (see "Activation contract"). The handler never reaches outside it, so `then`, `constructor`, `toString`, and prototype methods are unreachable.

Panels get a thin client in the runtime:

```ts
import { extensions } from "@workspace/runtime";
import type { GitToolsApi } from "@acme/git-tools";

const git = extensions.use<GitToolsApi>("@acme/git-tools");
const lines = await git.blame("/foo.ts");

extensions.on("@acme/git-tools", "indexed", (payload) => {
  // ...
});
```

`extensions.use()` returns a `Proxy` that turns property access into `rpc.call("extensions", "invoke", [name, prop, args])`. The proxy's `get` trap returns `undefined` for `then`, `Symbol.toPrimitive`, and other well-known protocol properties, so accidentally `await`ing the proxy itself (instead of a method result) does not round-trip to the extension. No per-method registration on the extension side — anything in the allowlist captured from `activate`'s return value is callable.

Events ride the existing `RpcEvent` channel. `ctx.emit(event, payload)` in an extension fans out to panels currently subscribed via `extensions.on(name, event, cb)`. Internally, extension events are namespaced by extension name on the wire (e.g. `RpcEvent { service: "extensions", event: "<name>::<event>", payload }`) so two extensions emitting the same event name don't collide.

## Userland extension management

Userland code cannot bypass the extension manager — `installed/` and `storage/` live in the state directory, not the workspace, and panel `fs` is scoped to the context folder. To install, remove, enable, or inspect extensions, panels call the **same `extensions` service** but on its management methods.

Every mutating method requests approval via the existing `approvals` service. Callers always call `approvals.request(...)` and never branch on granularity — the approvals system itself decides whether to prompt the user, auto-grant from a saved preference, or apply a scoped grant. Granularity is a property of the approvals UX, not of the extensions service.

```ts
import { extensions } from "@workspace/runtime";

// No approval — registry metadata only
await extensions.list();

// Approval required
await extensions.install({
  source: { kind: "git", url: "https://github.com/acme/git-tools", ref: "v1.2.0" },
  // or { kind: "tarball", url: "...", sha256: "..." }
  // or { kind: "local",   path: "/abs/path/to/dir" }     // dev convenience
});

await extensions.uninstall("@acme/git-tools");
await extensions.setEnabled("@acme/git-tools", false);

// Reading and writing extension files (e.g. for an extension-manager panel)
await extensions.readFile("@acme/git-tools", "README.md");
await extensions.writeFile("@acme/git-tools", "config.json", buf);
```

Approval prompt payloads are structured so the UI can render meaningful consent:

```ts
await approvals.request({
  kind: "extension.install",
  callerId: ctx.callerId,
  detail: {
    name: "@acme/git-tools",
    version: "1.2.0",
    source: { kind: "git", url: "...", ref: "v1.2.0" },
    integrity: "sha256-...",
  },
});
```

Reads and writes of extension files are also gated — extensions are trusted code, may contain credentials, and may be re-executed at next activation, so granting blanket userland access would defeat the trust boundary.

| Method | Approval | Notes |
|--------|----------|-------|
| `list` | No | Returns `{name, version, enabled, displayName}[]` from `registry.json` |
| `install` | `extension.install` | See pipeline below |
| `uninstall` | `extension.uninstall` | Deactivates, removes `installed/<name>/`, updates registry, removes the `node_modules/<name>` symlink; `storage/<name>/` is retained unless `purge: true` |
| `setEnabled` | `extension.toggle` | Persisted in registry; on disable, calls `deactivate()` and unloads |
| `readFile` | `extension.read` | Path constrained to `installed/<name>/`; rejects `..` segments after normalization |
| `writeFile` | `extension.write` | Path constrained to `installed/<name>/`. **Side effect**: on success the extension is reloaded — `deactivate()` → rebuild (new `bundleKey`) → `activate()` — so the write takes effect immediately. `package.json` is never modified by `writeFile`. |

Reads and writes do not affect the `installed/` snapshot's `version`; the registry's `bundleKey` is updated to reflect the new build, but `package.json` is the user's source of truth.

Extensions themselves call the same management surface via `ctx.host.extensions` without going through `approvals` — this is what lets a trusted "marketplace" extension drive installs.

## Install pipeline

1. **Approval granted** → fetch source into `extensions/staged/<opaque-id>/`.
   - `git`: shallow clone, then `git rev-parse` to resolve the user-supplied ref (branch / tag / sha) to its commit sha. Record both `ref` (what the user asked for) and `sha` (what got installed) in `registry.json`.
   - `tarball`: stream + verify `sha256` (required for tarball sources).
   - `local`: copy (or symlink in dev). No integrity check.
2. **Validate** the staged directory against the manifest schema. Fail-closed on any error — the staged dir is left in place for inspection (it will be swept on next boot if not retried).
   - `package.json` parses and contains `natstack.extension`.
   - `entry` resolves inside the directory (no `..` escape).
   - All names in `requires` already exist in the registry, otherwise install fails with `EMISSINGDEP`.
3. **Resolve dependencies** via the existing `build-artifacts/` pipeline (content-addressed `node_modules`, shared with panels). `requires` entries are *not* resolved here — they're externals.
4. **JIT build**: run esbuild on `entry` with target `node`, format `cjs`, Node built-ins externalized, and each name in `requires` marked external. The bundle lands at `{userData}/builds/<key>/extension.js` keyed by content hash. Build failures abort the install.
5. **Atomic promote**: rename `staged/<opaque-id>/` → `installed/<name>/`. Refresh the `extensions/node_modules/<name>` symlink. Write `registry.json` atomically (tmp + rename) with the new `bundleKey`. Pin the `bundleKey` as a build-cache GC root.
6. **Activate**: `extensionHost.activate(name)` — `require()` the built bundle, wrap `requires` externals as registry lookups, call `activate(ctx)`, snapshot the exposed-method allowlist from the returned API, store in the registry.
7. **Emit** `extensions:installed` over the event channel.

Uninstall reverses: `deactivate()` → dispose subscriptions (LIFO) → evict from `require.cache` → `rm -rf installed/<name>/` → remove `node_modules/<name>` symlink → release the `bundleKey` GC pin → update registry → emit `extensions:uninstalled`. The built bundle is now eligible for build-cache GC; if a panel build still references it, it stays.

Upgrade = uninstall + install in one approval (`extension.upgrade`). On upgrade the original `ref` is re-resolved against the source — branch refs move forward, pinned shas/tags don't.

### Integrity & pinning

| Source | Input ref | Stored | Mutable after install? |
|--------|-----------|--------|------------------------|
| `git`  | branch / tag / sha | resolved commit sha | No — upgrade re-resolves |
| `tarball` | URL + required `sha256` | sha256 of fetched bytes | No |
| `local` | path | path | Yes (dev convenience) |

This matches the lockfile pattern: users supply ergonomic refs, the registry stores what actually got installed.

## Activation lifecycle

- **Boot**:
  1. Sweep `staged/` — remove any leftover directories from a previous run that crashed mid-install.
  2. Walk `installed/`, cross-check against `registry.json`. Entries in `installed/` not present in the registry are ignored and logged (recoverable: re-install). Entries in the registry but missing from `installed/` are marked `error`.
  3. Refresh the `node_modules/` symlink farm to match `installed/`.
  4. Filter by `registry.enabled`, topologically sort by `requires`. Cycles fail-closed: every extension in the cycle is marked `error` and skipped; extensions outside the cycle proceed normally.
  5. Call `activate(ctx)` on each in order. Throws are caught, logged, marked `error` in the registry, and emitted as `extensions:error` events (so a notifications panel or status UI can surface them). One extension's failure does not block others.
- **Eager only for v1**. The manifest `activationEvents` field defaults to `["*"]`; other values are accepted for forward-compat but currently produce a warning and are treated as `["*"]`.
- **Hot install**: a freshly installed extension activates immediately — no app restart. Module cache is clean for a new package.
- **Hot uninstall / upgrade**: deactivate → dispose `ctx.subscriptions` in LIFO order → walk `require.cache` and delete every entry whose resolved path is under the extension's built bundle directory in `builds/<bundleKey>/` (the bundle is a single file plus chunk assets, all under one key, so the eviction set is tight) → optional re-activate. Anything an extension registered outside `ctx.subscriptions` (raw `process.on(...)` listeners, setInterval timers, references held by other modules) leaks across an upgrade — extensions are expected to use `ctx.subscriptions` for everything. If an extension turns out to leak references in practice, the fix is in the extension, not the host. (We may revisit per-extension `Module` isolation later if this becomes a recurring problem.)
- **Crash**: an extension throwing during `activate` is marked errored and does not block others. Crashes during a method call propagate as RPC errors to the caller; they do not take down the host. Uncaught exceptions in extension-registered event handlers are caught by a host-level `process.on("uncaughtException")` listener that logs, attributes to the extension if attributable, and continues — it does not crash the process.

## Dispatcher integration

Minimal change to `packages/shared/src/serviceDispatcher.ts`:

- Add `"extension"` to `CallerKind`.
- `ServiceContext.callerId` for an extension call is the extension name (`@acme/git-tools`).
- No blanket bypass — every existing service definition gets `"extension"` added to its `policy.allowed` list explicitly. Easier to read than a global rule.
- Log lines from service calls are tagged with the extension name as `callerId`.

The dispatcher does **not** root `fs` differently for extensions. `ctx.host.fs` is the unrestricted client. The scoped `{userData}/extensions/storage/<name>/` view is provided by `ctx.storage`, a wrapper built in `packages/extension-host/`. The dispatcher stays oblivious.

No other behavior differs between an extension call and a panel call.

## Extension host process

A new package `packages/extension-host/`:

```
packages/extension-host/
├── src/
│   ├── index.ts          # boot, sweep staged/, walk installed/, activate all
│   ├── registry.ts       # in-memory map of name → { api, exposed, manifest, subs, bundleKey }
│   ├── context.ts        # ExtensionContext factory (binds host clients, ctx.storage)
│   ├── installer.ts      # install / uninstall / upgrade pipeline, registry.json atomic writes
│   ├── service.ts        # dispatcher service ("extensions") handler — invoke / on / management
│   ├── loader.ts         # require + cache eviction, requires-as-externals wrapping
│   ├── linker.ts         # extensions/node_modules/ symlink farm management
│   └── topo.ts           # topological sort over requires, cycle detection
```

The host runs in-process with the server (single Node process). It mounts its `extensions` service onto the existing dispatcher. The Electron main process consumes the same package — there is one extension host per running NatStack instance, regardless of mode.

## Future work

Out of scope for v1, kept as forward-compat anchors:

- **Lazy activation**: the `activationEvents` field is plumbed through but only `"*"` is honored. Other triggers (`"onPanel:<source>"`, `"onCommand:<id>"`, ...) can be added without breaking the manifest.
- **Per-workspace extensions**: if project-pinned versions become useful, a per-workspace install location (`{workspace}/.natstack/extensions/`) can layer over the per-user one. Resolution order: workspace > user. Not built yet.
- **Untrusted / sandboxed extensions**: today all extensions are trusted. If we ever want to install third-party untrusted extensions, the cleaner path is a separate sandboxed-extension kind with its own policy-gated context, not retrofitting capabilities onto the trusted variant. Today's trusted extensions stay trusted forever.
- **Per-extension `Module` isolation**: if hot-upgrade reference leaks become a real problem in practice, revisit loading each extension in its own `Module` instance or `vm` context. Not worth the complexity until there's evidence we need it.
- **npm registry as a source**: currently git / tarball / local only. npm can be added as a fourth `source.kind` if there's demand.
- **Extensions shipping panels**: deliberately out of scope. Extensions register RPC APIs; if a UI is wanted, a separate panel can call into the extension. Revisit only if a concrete need appears.

## See also

- [PANEL_SYSTEM.md](PANEL_SYSTEM.md) — panel architecture
- [STATE_DIRECTORY.md](STATE_DIRECTORY.md) — `{userData}/` layout
- [PERMISSIONS.md](PERMISSIONS.md) — userland permission requirements (extensions bypass these, by design)
- [BUILD_SYSTEM.md](BUILD_SYSTEM.md) — `build-artifacts/` dep resolution (reused by extension installer)

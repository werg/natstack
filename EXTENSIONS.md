# Extension Services

> **Status:** v1 implemented. The `@natstack/extension`, `@natstack/extension-host` packages and the canary `image-service` and `typecheck-service` extensions are live; a few items in "Future work" remain deferred.

NatStack extensions are **long-lived Node processes** that run alongside the server and expose RPC APIs to userland panels and workers. They extend the application itself — adding new RPC services, reacting to system events, and exposing callable surfaces to userland — in the spirit of VSCode extensions, not browser extensions.

Extensions are **trusted, first-party-installed Node code**. They get two ways to do work, and they choose which to use per call:

- The **userland runtime** (`ctx.fs`, `ctx.credentials`, …): same host-substrate clients panels and workers see, plus extension-only helpers for approving extension-owned actions against the original caller. Calls flow through the dispatcher with `callerKind: "extension"` and are attributed to the extension. Extension APIs decide themselves when a user-visible approval is needed.
- **Raw Node** (`import "node:fs"`, `child_process`, native addons, sockets, anything Node can do): direct, unprompted, ambient. Authorized once at install time by the elevated approval and not asked again.

A given extension can use both. The trade-off is the extension author's call: route through `ctx.fs` for visibility and user-attributable auditing, ask the original panel/worker caller for an extension-specific decision, or call Node directly for silent operations the user has already broadly consented to. Per-call approvals initiated by extensions are useful for user intent and transparency, not as a security boundary against the extension itself — the install consent is what actually grants capability.

Every extension install, every accepted source change to an installed extension's active branch, and every explicit dependency update goes through an **elevated approval flow** — a visually distinct, informed-consent prompt that calls out the trust level being granted. That is the boundary.

Each extension runs in its **own forked Node process** (`utilityProcess.fork` in Electron, `child_process.fork` in standalone). Isolation is for **robustness, not security**: a buggy extension that crashes, leaks memory, segfaults a native addon, or hangs the event loop affects only its own process and can be respawned without touching the host.

## Extensions vs. panels vs. workers

| | Extension | Panel | Worker |
|---|---|---|---|
| Process | Per-extension Node process | Isolated webview | Workerd isolate |
| Runtime | Full Node + userland runtime | Userland runtime (browser) | Userland runtime (workerd) |
| Lifecycle | Eager activation at server boot | Opened on user navigation | Spawned by request |
| Reachable from outside | The `extensions` RPC service | Direct (URL) | Direct (RPC) |
| Lives at | `workspace/extensions/<scope>/<name>/` | `workspace/panels/<name>/` | `workspace/workers/<name>/` |
| Trust grant | Elevated approval (informed-consent UX) | Standard approvals per call | Standard approvals per call |

Extensions are the only userland kind with full Node access. Panels and workers run inside V8 isolates with no host-Node primitives.

## Workspace layout

Extensions are workspace units like panels and workers. Each is its own git repo inside `workspace/extensions/`:

```
workspace/extensions/
└── @acme/
    └── git-tools/
        ├── package.json          # Manifest with natstack.extension field
        ├── index.ts              # Entry (TypeScript source)
        └── ...
```

By convention, workspace-internal extensions use the `@workspace-extensions/*` scope. Cross-extension imports are not first-class in v1 (see Future work).

There is no per-user `{userData}/extensions/installed/` tree. Source lives in workspace git (every extension is a workspace unit, even those originally fetched from a remote source — they're cloned into `workspace/extensions/<name>/` at install time). Bundles live in `{userData}/builds/<key>/` keyed by content hash. Per-extension scratch lives at `{userData}/extensions/storage/<workspaceId>/<name>/`.

The registry is a small JSON in workspace state. It holds **operational state only** — never approval state. The single source of truth for "did the user consent to run this code" is the approvals system; the registry never duplicates it. Each entry has this canonical shape:

```ts
interface RegistryEntry {
  name: string;                  // "@workspace-extensions/git-tools"
  version: string;
  source: ExtensionSource;       // workspace repo + ref
  installedAt: number;

  activeEv: string | null;       // workspace-source EV of the approved/running build
  activeSourceHash: string | null;
  activeBundleKey: string | null;
  activeDependencyEvs: Record<string, string>; // workspace deps pinned into active bundle
  activeExternalDeps: Record<string, string>;  // npm deps + versions captured at approval time
  activeRuntimeDepsKey: string | null; // persisted external dependency lock/materialization

  enabled: boolean;
  status: "running" | "stopped" | "error" | "pending-approval" | "building";
  lastError: string | null;
}
```

Approval is action-based, not build-hash-based. Installing an extension, pushing to an installed extension's active branch, and explicitly updating an extension's dependency set are the approval boundaries. Build hashes/content keys remain internal build-cache and integrity details; they are not the durable approval subject. On approval, the manager records the resulting bundle and dependency materialization as active and starts/restarts the extension process.

A `BUILD_CACHE_VERSION` bump in buildV2 may change the cache **build key**, but it does not create a new user approval by itself. The user approves extension install/update/push actions, not our cache version.

## Manifest

```json
{
  "name": "@workspace-extensions/git-tools",
  "version": "1.2.0",
  "private": true,
  "type": "module",
  "natstack": {
    "displayName": "Git Tools",
    "entry": "index.ts",
    "sourcemap": true,
    "extension": {
      "activationEvents": ["*"]
    }
  },
  "dependencies": {
    "@workspace/runtime": "workspace:*"
  }
}
```

The manifest follows the **shared workspace-unit shape**: top-level keys under `natstack.*` are common to every unit kind, and a single kind-specific sub-block (`natstack.extension`, `natstack.worker`, `natstack.panel`) declares what kind the unit is. A unit must have exactly one kind-specific sub-block.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `natstack.displayName` | string | package name | Human-readable name. Shared across all unit kinds. |
| `natstack.entry` | string | `index.ts` (extension), `index.tsx` (panel), `index.ts` (worker) | Entry source file. Shared across kinds. |
| `natstack.sourcemap` | boolean | `true` | Inline sourcemaps in the bundle. Shared across kinds (mandatory `true` for extensions in v1). |
| `natstack.extension.activationEvents` | string[] | `["*"]` | When to activate. `"*"` = eager at startup. Other values fail validation in v1. |
The presence of `natstack.extension` is what marks the unit as an extension to the package graph. Manifests are validated against a JSON schema at install time and again at boot; validation failures fail closed (extension is not activated and an error is recorded in the registry).

No `dist/` — extensions ship TypeScript source, the workspace build pipeline produces the runtime bundle. Cross-extension type sharing is not a first-class concern in v1.

This shape is harmonized with workers and panels (today's panel manifests use a flat `natstack.{title, entry, ...}` layout that should converge to the same `natstack.*` shared + `natstack.panel.*` kind-specific shape in a follow-up pass). See "Workspace-unit conventions" below for the broader contract.

## Build pipeline integration

Extensions are first-class buildV2 units. In `src/server/buildV2/packageGraph.ts`, `GraphNode["kind"]` gains `"extension"`; the package graph scans `workspace/extensions/` and discovers extension units alongside packages, panels, workers, and templates. Extension source pushes on the active branch are gated before the ref is updated; dependency changes do not automatically rebuild extensions. Effective-version computation, source extraction from git, and shared external-deps installation otherwise behave like other buildable units.

The new `extension` build kind is a node-target ESM build modeled on the worker build at `builder.ts:1443`. Concretely:

- `platform: "node"`, `target: "node20"`, `format: "esm"`, `splitting: false`, single `bundle.js`.
- Reuses `prepareBuildEnv`, source extraction via `git archive`, transitive external-deps install, and the workspace resolve plugin.
- Reads the manifest from the extracted source tree (not `node.manifest`) so ref-pinned builds use the manifest at the requested commit. Same source-of-truth pattern as the worker build.
- Plugins: workspace resolve (node conditions: `["import", "default"]`), TS extension plugin, dedupe plugin. No workerd-specific shims (crypto, buffer, node-stub plugins are dropped — Node provides these natively).
- `mainFields: ["module", "main"]` fallback for packages without an `exports` field.
- Native addons externalized via `KNOWN_NATIVE_EXTERNALS` (`*.node`, `fsevents`, `bufferutil`, `utf-8-validate`, `node-pty`, `cpu-features`, `@parcel/watcher`). Extensions resolve externalized packages at runtime from a per-extension runtime dependency install keyed by `(resolved deps lock hash, platform, arch, node ABI)`.
- **Inline sourcemaps always on** so stack traces and the Node inspector point at the original TypeScript.
- Output: `bundle.js` plus a generated `package.json` (`{"type":"module"}`), stored under `{userData}/builds/<key>/`.

Runtime dependency layout is separate from the existing shared `external-deps` cache used during bundling. Build-time `ensureExternalDeps(...)` continues to install with scripts disabled so panels/workers remain safe. Extension builds first resolve an extension dependency lock/materialization record; that record is persisted with the active bundle. Activation runs an extension-specific dependency materialization step for that exact lock. That step may run package lifecycle scripts because the user has already granted the extension native-code trust; its result is linked into the bundle directory as `node_modules` (or the process is launched with an equivalent resolver hook) so Node's ESM resolver can satisfy imports that esbuild left external. A failed runtime dependency install leaves the extension in `error` with the install log attached to `lastError`.

The stale `agent` build kind described in `BUILD_SYSTEM.md` was never actually implemented in `builder.ts` and never reached `GraphNode["kind"]`. It corresponded to a removed `workspace/agents/` directory. The `extension` kind takes the slot the docs reserved for "node-target ESM", and stale references in `BUILD_SYSTEM.md` and the comment header of `packageGraph.ts` are removed in the same change.

## Activation contract

```ts
// workspace/extensions/@acme/git-tools/index.ts
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
    async blame(path: string) {
      const invocation = ctx.invocation.current();
      if (invocation?.userlandCaller) {
        const decision = await ctx.approvals.requestForCaller({
          subject: { id: "git-tools:blame", label: "Git blame" },
          title: "Allow Git Tools to inspect blame data?",
          summary: `Requested by ${invocation.userlandCaller.callerId}`,
          options: [
            { value: "allow", label: "Allow", tone: "primary" },
            { value: "deny", label: "Deny", tone: "danger" },
          ],
        });
        if (decision.kind !== "choice" || decision.choice !== "allow") {
          throw Object.assign(new Error("Denied"), { code: "EACCES" });
        }
      }
      /* ... */
      return [];
    },
  };
}

export async function deactivate(): Promise<void> {
  // optional cleanup; subscriptions are auto-disposed
}
```

`activate` returns the extension's **public API** — a plain object whose own enumerable function properties are callable from the host via RPC. There is no per-method registration step and no allowlist captured at activation time. The dispatcher resolves a call by reading `api[method]` and checking `Object.hasOwn(api, method) && typeof api[method] === "function"` at the time of the call. Anything else (`then`, `constructor`, inherited prototype methods, non-function properties) returns `ENOMETHOD`.

The API object is held by the extension process, not the host. The host knows the extension exposes some surface (recorded for `list`), and routes invocations across the wire.

Every invocation is delivered with a host-stamped `ExtensionInvocation` envelope. The extension method signature stays ergonomic (`api.method(...args)`); the child runtime wraps the method call in `AsyncLocalStorage`, and extension code reads the active envelope from `ctx.invocation.current()`. This is how extensions learn who asked them to do work and decide whether to prompt.

```ts
interface ExtensionInvocation {
  requestId: string;
  extensionName: string;
  method: string;

  // The immediate RPC caller that invoked this extension.
  caller: {
    callerId: string;
    callerKind: "panel" | "worker" | "shell" | "extension" | "http";
    connectionId?: string;
  };

  // Present only when the immediate caller is a panel/worker.
  // This is the principal used by ctx.approvals.requestForCaller(...).
  // Extension-to-extension calls do not inherit an upstream panel identity:
  // the downstream extension sees callerKind "extension" and no userlandCaller.
  // If caller consent matters, the upstream extension asks for it before
  // delegating.
  userlandCaller?: {
    callerId: string;
    callerKind: "panel" | "worker";
    repoPath: string;
    effectiveVersion: string;
  };
}
```

This avoids making extension APIs ambient privileged services by accident. An extension may intentionally expose an unauthenticated API, but it has enough caller context to make that an explicit decision. The host does not impose a blanket approval gate on `extensions.invoke`; the extension owns its authorization policy.

Returning `void` is valid — the extension is then fire-and-forget (only useful for side effects, e.g. registering event handlers).

## `ExtensionContext`

```ts
interface ExtensionContext {
  // Identity
  readonly name: string;          // "@workspace-extensions/git-tools"
  readonly version: string;

  // Per-extension scratch, scoped to {userData}/extensions/storage/<workspaceId>/<name>/.
  readonly storage: ExtensionStorage;

  // Userland runtime — at parity with what panels and workers get today.
  // Dispatched back to the host over the extension's WebSocket connection.
  // Calls here are attributed to the extension. Extension APIs that need
  // explicit user intent call ctx.approvals.requestForCaller(...) using the
  // current invocation envelope. For silent ambient work, import
  // "node:fs" etc. directly. ctx.fs for extensions is NOT context-scoped —
  // it covers the whole host filesystem, matching the raw-Node access the
  // extension already has.
  //
  // The long-term shape is narrower than this: only host-substrate clients
  // (fs, workspace, workers, credentials, approvals, notifications,
  // extensions) genuinely belong here. The capability clients (git
  // user-facing methods, webhooks subscriptions) are migration candidates
  // that should become extensions and be reached via ctx.extensions.use(...)
  // instead. The current list matches the panel/worker runtime today;
  // entries drop as each capability migrates. See "Migration candidates".
  //
  // `ctx.workers.resolveDurableObject(source, className, key)` returns and
  // grants a Durable Object target. `ctx.rpc.call(targetId, method, ...args)`
  // then dispatches through unified RPC. Useful for extensions whose
  // canonical surface wraps a workerd-backed store (e.g. browser-data).
  //
  // `ctx.panel` and `ctx.db` were considered for the substrate set but are
  // not exposed in v1: the panel orchestration service is shell-only and
  // there is no host "db" service. Either could land later as an extension.
  readonly fs: FsClient;
  readonly git: GitClient;
  readonly workspace: WorkspaceClient;
  readonly rpc: RpcClient;                  // unified RPC for explicit targets
  readonly workers: WorkersClient;          // userland service/DO discovery
  readonly credentials: CredentialsClient;
  readonly webhooks: WebhooksClient;
  readonly approvals: ApprovalsClient;
  readonly notifications: NotificationsClient;
  readonly extensions: ExtensionsClient;

  // Current inbound extension invocation, if execution is inside an API method
  // or fetch handler. Backed by AsyncLocalStorage in the child runtime.
  readonly invocation: ExtensionInvocationClient;

  // Lifecycle. Disposables are disposed in LIFO order on deactivate.
  readonly subscriptions: Disposable[];

  // Structured logger. ctx.log.{info,warn,error,debug}(message, fields?)
  // writes records to the extension's stdout/stderr; the host captures them
  // and routes into the workspace-wide log stream keyed by
  // (workspaceId, unitName, kind). See "Workspace-unit conventions" below.
  // Direct console.log / console.error also work and are captured the same way.
  readonly log: Logger;

  // Health reporting. The extension self-reports its operational health,
  // surfaced on workspace.units status rows. Default state immediately
  // after activate() resolves is "healthy"; the extension can downgrade
  // (or upgrade back) at any time. See "Workspace-unit conventions →
  // Health states" for the contract.
  readonly health: HealthClient;

  // Events (visible to subscribed panels, workers, and other extensions)
  emit(event: string, payload: unknown): void;
}

interface HealthClient {
  report(state: "healthy" | "degraded" | "unhealthy", detail?: HealthDetail): void;
  // Convenience wrappers — same as report() with the corresponding state.
  healthy(detail?: HealthDetail): void;
  degraded(detail: HealthDetail): void;       // detail required — must say why
  unhealthy(detail: HealthDetail): void;      // detail required — must say why
}

interface HealthDetail {
  summary: string;                 // one-line description for the status row
  reasons?: string[];              // optional bullets shown when the user drills in
  retryAt?: number;                // epoch ms — if set, the UI shows a countdown
}

interface ExtensionInvocationClient {
  current(): ExtensionInvocation | null;
}

interface ApprovalsClient {
  // Existing panel/worker approval client methods remain available where
  // applicable. Extensions also get this helper:
  //
  // Submit a userland approval request against the active invocation's
  // userlandCaller, using the same namespaced ApprovalQueue /
  // UserlandApprovalGrantStore path panels and workers use today. The host
  // supplies the principal from the invocation envelope and the issuer from
  // the extension identity; the extension supplies only the local subject,
  // copy, details, and options. Throws ENOCALLER when there is no immediate
  // panel/worker principal to ask.
  requestForCaller(req: UserlandApprovalRequest): Promise<UserlandApprovalChoice>;
}
```

Clients on `ctx` are bound through the extension process's WebSocket connection to the dispatcher with `callerKind: "extension"` and `callerId: <extension name>`. Host-service calls are attributed to the extension for logs. When an extension asks its caller for a userland approval, the prompt shows both sides: the original panel/worker principal being asked, and the extension that issued the request.

`ctx.approvals.requestForCaller(...)` is the extension-specific approval path. It reuses the existing userland approval request system, including the same subject/options model, grant storage, pending queue, and shell UI. The key difference is principal and issuer derivation: panels and workers still call `userlandApproval.request` directly and the service derives both the principal and default issuer from `ServiceContext`; extensions call through the extension host, and the host derives the principal from the current `ExtensionInvocation.userlandCaller` and the issuer from the extension identity. The extension never sends `repoPath`, `effectiveVersion`, `callerKind`, or issuer identity as trusted input.

**Parity now, narrower later.** The starting set above mirrors what `@workspace/runtime` already exposes to panels and workers, so an extension has feature parity with the rest of userland from day one and no consumer of the runtime has to learn a new shape. The longer-term target is narrower: only host *substrate* (`fs`, `workspace`, `workers`, `credentials`, `approvals`, `notifications`, `extensions`) genuinely belongs on `ctx.*`. The capability clients (`ai`, the user-facing portion of `git`, the `webhooks` subscription surface) are migration candidates that should become extensions in their own right and be reached via `ctx.extensions.use(...)` once that work lands. Each capability migration drops its entry from `ctx.*` across all three runtimes (panel, worker, extension) in the same change. The principle: `ctx.*` is what the host *has to* provide; anything that's a discrete capability — even one shipped by default — eventually moves out.

Node's standard library is available globally inside the extension process — `import * as fs from "node:fs"`, child processes, native addons all work normally. There is no host-mediated wrapper; the extension is running in a real Node process.

## Process model

Each extension runs in its own forked Node process. The host owns an `ExtensionProcessManager` (a sibling to `WorkerdManager`) that:

- Spawns the process via `packages/process-adapter/` — `utilityProcess.fork` in Electron, `child_process.fork` in standalone Node.
- Hands the child an environment containing the gateway URL, the bundle path, a per-extension WebSocket token, and the extension's identity.
- Waits for a `ready` handshake (a message after the extension finishes `activate` and the WebSocket is connected).
- Forwards `extensions.invoke` calls from the dispatcher to the extension process's WebSocket with a host-stamped `ExtensionInvocation` envelope.
- Routes the extension's outbound RPC calls (`ctx.fs.write(...)` etc.) into the dispatcher as ordinary client calls.
- Detects crashes, applies the crash policy (below), and respawns or marks `error`.

Per-extension cost: a fresh Node process (~30–100 MB RSS startup, ~150–500 ms cold start). Acceptable at expected scale.

### Transport

Same WebSocket the panels use. The extension process dials the gateway with its per-extension token; from the dispatcher's perspective it looks like another RPC client, distinguished only by `callerKind: "extension"`. Host → extension calls (`extensions.invoke`) ride the same channel in reverse, as RPC events. No new transport is introduced.

### Crash policy

If an extension process exits unexpectedly (non-zero exit, signal, ready-handshake timeout), the manager respawns it with exponential backoff: `1s, 2s, 4s, 8s, 16s`. If five consecutive spawn attempts fail within 60 seconds, the extension is marked `error` in the registry, an `extensions:error` event is emitted, and a notification surfaces the failure to the user. After that, only an explicit `extensions.reload(name)` will attempt activation again.

"Unexpected" is defined by the ready handshake: if the extension exited *before* sending `ready`, treat as a crash regardless of exit code. If it exited *after* `ready` with exit code 0, treat as intentional deactivation — no respawn, status `stopped` — until the next host restart or manual reload. Any non-zero exit code, or any signal-induced termination, is always a crash.

## Reaching extensions from userland

Extensions have two callable surfaces. The **RPC** surface (the `extensions` dispatcher service) is the canonical one — every extension has it, and it's where the read/lifecycle methods (`list` / `reload`) live. Installing and enabling extensions is declarative — `meta/natstack.yml` is the only surface (see [Declared extension set and management](#declared-extension-set-and-management)); there are no imperative `install` / `uninstall` / `setEnabled` / `update` RPCs. The **HTTP fetch** surface is optional: an extension that wants to be reachable like a worker can export a default `fetch` handler, and the gateway will route `/_r/ext/<name>/*` to it.

### RPC: the `extensions` service

There is exactly one RPC entry point: the dispatcher service named `extensions`. It mounts onto the existing dispatcher and is callable by every userland kind (`panel`, `worker`, `shell`, `extension`).

```ts
// dispatcher
{
  name: "extensions",
  policy: { allowed: ["panel", "worker", "shell", "extension"] },
  methods: {
    invoke:     { args: [z.string(), z.string(), z.array(z.unknown())] },
    invokeStream: { args: [z.string(), z.string(), z.array(z.unknown())] },
    streamingMethods: { args: [z.string()] },
    list:       { args: [] },
    on:         { args: [z.string(), z.string()] }, // (extName, event) — returns subscription id
    reload:     { /* approval-gated; restarts active approved build */ },
  },
}
```

`invoke`, `list`, and `on` are not host approval-gated — they're userland code talking to userland code. `invoke` is still caller-aware: the host stamps the immediate caller and, when available, the original panel/worker principal into the invocation envelope delivered to the extension. The extension decides whether the requested method needs an approval and calls `ctx.approvals.requestForCaller(...)` when it does. There are no imperative management methods: extensions are installed/enabled by declaring them in `meta/natstack.yml`, and the reconciler grants newly declared extensions through the joint approval flow. `reload` is approval-gated, and extension main/master push acceptance uses the extension-specific approval treatment described below.

Consumers — panels, workers, and other extensions — use the same thin client from `@workspace/runtime`:

```ts
import { extensions } from "@workspace/runtime";
import type { GitToolsApi } from "@workspace-extensions/git-tools";

const git = extensions.use<GitToolsApi>("@workspace-extensions/git-tools");
const lines = await git.blame("/foo.ts");

extensions.on("@workspace-extensions/git-tools", "indexed", (payload) => {
  // ...
});
```

`extensions.use()` returns a `Proxy` that turns property access into `rpc.call("main", "extensions.invoke", [name, prop, args])`. The proxy's `get` trap returns `undefined` for `then`, `Symbol.toPrimitive`, and other well-known protocol properties. Calls to a non-existent or stopped extension fail with `ENOEXT` at invocation time; the proxy itself is always defined.

Extension-to-extension calls are intentionally not delegated as the original panel/worker. The downstream extension sees the immediate extension caller and decides whether to serve that extension. If a panel/worker approval is needed for the composite operation, the upstream extension requests it before making the downstream call.

Events ride the existing `RpcEvent` channel. `ctx.emit(event, payload)` in an extension fans out to subscribers via `extensions.on(name, event, cb)`. Internally, extension events are namespaced by extension name on the wire (`RpcEvent { service: "extensions", event: "<name>::<event>", payload }`) so two extensions emitting the same event name don't collide.

Extensions activate independently. There is no coordination API in v1: calls to an extension that is not ready fail with `ENOTREADY` / `ENOEXT`, and callers that care should retry later.

### `ExtensionsClient` surface

The same client is exposed to panels and workers via `@workspace/runtime`, and to extensions via `ctx.extensions`:

```ts
interface ExtensionsClient {
  // Calling an extension
  use<K extends ExtensionName>(name: K, options?: { streamingMethods?: Iterable<string> }): WorkspaceExtensions[K];
  on(name: ExtensionName, event: string, cb: (payload: unknown) => void): Disposable;
  list(): Promise<RegistryEntry[]>;

  // Lifecycle — install/enable is declarative (meta/natstack.yml), not an API.
  reload(name: ExtensionName): Promise<void>;                    // restart active approved build
}
```

### HTTP fetch (optional)

An extension can additionally expose an HTTP handler by including a default export with a `fetch` method, matching the worker convention. If present, the gateway routes matching requests to the extension process.

```ts
import type { ExtensionContext, ExtensionFetchContext } from "@natstack/extension";

let ctx: ExtensionContext;

export async function activate(_ctx: ExtensionContext): Promise<MyApi> {
  ctx = _ctx;
  // ... setup, return RPC API
}

export default {
  async fetch(request: Request, _ctx: ExtensionFetchContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") return Response.json({ ok: true });
    return new Response("Not Found", { status: 404 });
  },
};
```

One route namespace is available to an extension that exposes `fetch`:

**Auto-prefix** `/_r/ext/<extension-name>/*` is always available, no manifest declaration needed. Internal consumers (panels, workers, other extensions) use this to reach the extension over HTTP. There are no custom top-level HTTP routes in v1.

#### Fetch-handler semantics

- `request` and the returned `Response` use the standard Fetch API types.
- The `ExtensionFetchContext` passed to `fetch` is the same activated `ExtensionContext` the extension received at `activate`, plus a `waitUntil(promise)` method for fire-and-forget background work the host should wait on before considering the response complete. The activated `ctx` and the fetch `ctx` are not different objects; this is one long-lived context, not a per-request one.
- The host marshals each Request to the extension process over the existing WebSocket as a structured "fetch envelope" frame, awaits the Response, and proxies bytes back to the caller. Small bodies travel inline as base64; larger bodies are transferred through file-backed envelopes so they do not hit the old 10 MB frame cap. Fully live chunk streaming over the WebSocket envelope is still future work.
- Fetch handlers also run under `ctx.invocation.current()`. Auto-prefix requests get the authenticated caller in the envelope and `userlandCaller` when that caller is a panel/worker.
- A request that arrives before the extension finishes `activate`, while it's in `pending-approval`, or while it's in `error` gets a 503 with a descriptive body. No queueing.
- The fetch handler runs in the same process as `activate` — they share state, can call each other's helpers, can share connection pools. If you want a route to call into the extension's RPC API for free, just call your API methods directly inside `fetch`.

The fetch handler is **optional**. Extensions without a default export `fetch` have no HTTP route registered. The RPC surface is the canonical one; fetch is for cases where another part of NatStack or a userland HTTP-shaped consumer wants fetch-call ergonomics.

Implementation note: the current `RouteRegistry` only owns `/_r/` worker/service dispatch. Extension fetch adds one entry to that layer:

- an `extension-auto` route kind under `/_r/ext/<encoded-name>/*`, with caller-token auth.

Consumers reach the auto-prefix HTTP surface the same way they reach any internal route, using the existing `@workspace/runtime` fetch helpers.

## Extension approvals — informed-consent UX

NatStack already requests approval for git pushes. Extensions add one special case to that existing path: a push to an installed extension's active branch (`main` / `master` in v1) uses extension-specific copy and decision handling, because accepting that push changes trusted native code. No separate build-hash approval key is introduced.

Two extension-specific approval sub-kinds cover the non-git management cases:

1. **`extension.install`** — user-initiated. The user just typed `extensions.install(...)` or clicked Install in a manager UI; they're at the keyboard, focused on the action, and asked for code to be installed. The prompt is forward-looking and informational: "Here's what you asked to install. Confirm."
2. **`extension.update`** — user-initiated dependency refresh. Dependency-only changes never trigger this prompt automatically; the manager offers an explicit update action instead.

Source updates are handled by the git push approval flow, not by `extensions.update`. The push is the user's intent signal and the approval decision is scoped to that git write. If approved, the push lands; the extension manager then rebuilds and activates from the new branch state. If denied, the push fails and no extension state changes.

Extension-owned per-call approvals are standard userland approvals submitted with `ctx.approvals.requestForCaller(...)`. They reuse the same approval pipeline panels and workers use, but the trusted principal comes from the current invocation envelope rather than from extension-supplied input. Host services reached through other `ctx.*` clients are still called as `callerKind: "extension"` and may apply their own service-specific policy; they are not the primary authorization mechanism for extension APIs. Disable, enable, reload, and uninstall are also standard.

### Namespaced userland approval artifacts

Userland approval artifacts are namespaced for every issuer, not only extensions. A pending request, persisted grant, notification cancel key, and audit record all carry:

```ts
interface UserlandApprovalIssuer {
  kind: "panel" | "worker" | "extension";
  id: string;              // callerId for panel/worker, extension name for extension
  repoPath?: string;       // present for panel/worker issuers
  effectiveVersion?: string;
}

interface NamespacedUserlandApprovalSubject {
  issuer: UserlandApprovalIssuer;
  local: UserlandApprovalSubject;  // the subject supplied by userland code
}
```

The durable key is `canonicalKey(["userland-grant", principal.callerId, issuer.kind, issuer.id, local.id])`. Direct panel/worker calls to `userlandApproval.request(...)` get `issuer = principal`; extension calls to `requestForCaller(...)` get `issuer = { kind: "extension", id: extensionName }`. UI copy shows both: "Panel X is being asked by extension Y", or for direct panel/worker requests simply "Panel X requests your decision". This prevents two independent pieces of userland from sharing a grant just because they chose the same local subject id.

### Approval payload

Install and explicit dependency-update prompts share the same payload shape. Fields that don't apply to a kind are `null` or empty arrays.

```ts
await approvals.request({
  kind: "extension.install",   // or "extension.update"
  category: "extension-management",
  callerId: approvalIssuer.callerId,
  detail: {
    name: "@workspace-extensions/git-tools",
    version: "1.2.0",
    source: { kind: "workspace-repo", repo: "extensions/git-tools", ref: "v1.2.0" },

    // Build context, shown for diagnostics only. Not an approval key.
    ev: "ev_2a9f...",                // workspace-source EV, shown for diff/debug context
    previousEv: "ev_117c...",        // source EV currently running; null on install

    // Diff layers
    extensionDiff: {                 // null on install or dependency-only update
      sha: "abc123...",
      previousSha: "def456...",
      stat: { filesChanged: 7, insertions: 142, deletions: 11 },
      // Provenance — null for dependency-only updates.
      commit: {
        author: { name: "...", email: "..." },
        committer: { name: "...", email: "..." },
        message: "fix blame regression on submodules",
        timestamp: 1715000000,
      },
      push: null,
    },
    workspaceDepChanges: [           // populated only for explicit dependency update
      { name: "@workspace/runtime", fromEv: "ev_a1...", toEv: "ev_b2...",
        sha: "...", previousSha: "...",
        stat: { filesChanged: 3, insertions: 18, deletions: 4 },
        commit: { author: {...}, committer: {...}, message: "...", timestamp: 1715000000 },
        push: { pushedAt: 1715000010, pushedBy: "...", ref: "refs/heads/main" } },
    ],
    externalDepChanges: [            // empty when package.json/lockfile is unchanged
      { name: "zod", fromVersion: "3.22.4", toVersion: "3.23.8" },
    ],

    // Capabilities surfaced prominently in the prompt
    integrity: "sha256-...",
    capabilities: ["node:fs", "node:child_process", "node:net", "userland:*"],
  },
});
```

### Shared UI requirements

These apply to extension install/update approvals and to the extension-specific git push prompt:

- **Visually distinct from regular approvals.** Different card style, different icon, more spacing, plain-language framing.
- **Show all populated diff layers**, each collapsible. Sections with no changes are hidden, not shown empty.
- **Decision options**: `once` and `deny` are always offered. For extension source pushes, `session` is offered with the user-facing label "dev session"; when picked it stores a session-scope decision in the existing git-push approval system, scoped to this extension repo and active branch. Subsequent extension `main` / `master` pushes during the window auto-grant. No build-hash-scoped grant is stored.
- **Deferred default**: the default action when the prompt is dismissed (window closed, navigated away) is `deny`, never grant.

### Install prompt (`extension.install`)

The user just initiated this. The prompt is informational and forward-looking.

- **Title and lead**: "Install **@acme/git-tools** v1.2.0?" Then on a second line, the capability sentence: "This will run as native code on your machine with access to your filesystem, network, and ability to launch other programs."
- **Provenance section is short**: the internal git repo and ref the user supplied. There's no commit-author surprise to disclose; the user selected the workspace repo/ref.
- **Verb pair**: "Install and run" / "Don't install".

### Update prompt (`extension.update`)

`extension.update` is only for explicit dependency refreshes. Source updates use the git push approval flow.

- **Title and lead**: "**@acme/git-tools** dependency update." Then on a second line: "This will rebuild the extension against newer approved workspace or external dependencies."
- **Dependency changes** are the primary content. A push to `@workspace/runtime` does not automatically enqueue extension approvals; the extension manager can show that `@acme/git-tools` has an available dependency update, and the user chooses whether to run it.
- **Diff sections** show workspace and external dependency diffs.
- **Verb pair**: "Update and run" / "Cancel".

### Extension push prompt

The existing git push approval UI gets extension-specific treatment when the push targets an installed extension's `main` / `master` branch.

- **Title and lead**: "**@acme/git-tools** source push." Then on a second line: "Accepting this push updates trusted native extension code."
- **Git context**: repo, ref, pushing identity, and any commit summary already available to the git server's push approval path. The prompt does not need to build or hash the candidate bundle before asking.
- **Verb pair**: "Allow push" / "Reject push". Rejecting fails the git push.
- **Dev-session decision**: "Allow extension pushes to @acme/git-tools without asking, for the next 4 hours" stores a session grant in the git push approval system, scoped to this extension repo and active branch.

### Dependency update path

A push to a non-extension unit (typically a shared library) can make newer extension builds available, but it does not automatically rebuild or reload extensions. Installed extensions continue running the build they were approved for, including the workspace dependency EVs captured in `activeDependencyEvs` and the external dependency materialization pointed to by `activeRuntimeDepsKey`.

The manager may surface an available-update indicator when the current workspace graph or an explicit external-dependency refresh would change the extension's runtime inputs. The user can choose `extensions.update(name)` / "Update extension", which resolves the current dependency graph, builds the candidate, and submits `extension.update`. On grant, that build becomes active. On deny or dismissal, nothing changes; the existing extension keeps running.

### Git push gate

Pushes to installed extension repos are branch-sensitive:

- **`main` / `master`**: gated before the ref is updated. Deny/dismissal/timeout fails the git push.
- **Other branches**: accepted like ordinary workspace git refs and do not affect the running extension.
- **Non-extension repos**: never trigger extension approvals automatically.

The git server already requests approval for pushes. Extension push gating is a special case inside that existing approval path: when the target repo is an installed extension and the target branch is `main` / `master`, the approval copy and audit category identify it as a trusted extension source update. No pre-receive build, quarantine-object inspection, or build-hash approval key is required.

For an extension `main`/`master` push:

1. Authenticate and perform normal write authorization.
2. If the repo is an installed extension and the ref is `refs/heads/main` or `refs/heads/master`, request the existing git push approval with extension-specific copy/category.
3. On grant or active dev-session auto-grant: allow the git push.
4. On deny, dismissal, or timeout: reject the git push. The branch ref remains unchanged and the old extension keeps running.
5. After an accepted push completes, the extension manager rebuilds from the updated branch. If build and activation succeed, it records the new bundle as active and replaces the running process. If build or activation fails, the previous active bundle keeps running and `lastError` records the failed update.

This means **no source push to an active extension branch can land without explicit push approval**. Dependency-only changes are deliberately outside this path; they are handled by explicit update.

**Headless mode**: enabled extensions with an active bundle start normally on boot; their approval happened at install, source-push, or explicit update time. Extension main/master pushes still require the existing git push approval and fail if no approval UI can answer within the receive timeout.

## Declared extension set and management

The extensions a workspace uses are **declared** in `meta/natstack.yml` under `extensions:`. That list is the single source of truth and the only install/enable/disable/uninstall surface — there is no imperative `extensions.install` / `setEnabled` / `uninstall` / `update` API. The registry remains server-managed operational state; the declared set drives it.

```yaml
# meta/natstack.yml
extensions:
  - source: extensions/@workspace-extensions/git-tools   # repo path or package name
    ref: main          # optional, defaults to "main"
    enabled: true       # optional, defaults to true; false = installed but stopped
```

The server **reconciles** the registry against the declared set at two moments:

- **Workspace startup.** Already-approved declared extensions start immediately. Any declared extension that is not yet approved is surfaced in **one joint, elevated approval** listing every unapproved extension with a per-extension overview (source, version, EV, granted native capabilities). Boot does not block on the decision — the prompt is presented (desktop approval bar and mobile push), and each extension builds and activates when the set is approved. Denial leaves them pending until the next startup or meta edit.
- **A push to `meta/`.** If the pushed `meta/natstack.yml` adds extensions, the change is gated by a **single combined approval** that shows both the workspace-config write and the new-extension overview (the same prompt on desktop and mobile). Approving allows the push and activates the newly-trusted extensions without a second prompt; denying rejects the push. Removing an extension from the list stops and removes it on reconcile (storage retained); no approval is needed beyond the gated meta write itself.

The remaining userland surface is read/diagnostic only:

```ts
import { extensions } from "@workspace/runtime";

await extensions.list();                                   // No approval — registry metadata
await extensions.reload("@workspace-extensions/git-tools"); // Approval-gated; restarts active build
```

| Method | Approval | Notes |
|--------|----------|-------|
| `list` | No | Returns `RegistryEntry[]` (full canonical shape from "Workspace layout") |
| `reload` | `extension.reload` | Restarts the active approved build; rebuilds if the dependency graph changed |

Source iteration still happens by editing in `workspace/extensions/<name>/` and pushing `main` / `master`; that push is gated by the existing source-push approval, with a 4-hour dev-session grant to avoid the per-push prompt while iterating. There is no `readFile` / `writeFile` over the RPC surface. Dependency changes are adopted on the next reconcile (startup or meta push) or via `reload`.

## Activation lifecycle

- **Boot**:
  1. Read the registry. For each enabled extension with an active bundle, spawn that bundle.
  2. Wait for the ready handshake (timeout: 10s), call `activate(ctx)` over the wire, record the exposed API metadata, and set `status = "running"`.
  3. Throws during `activate` are caught, logged, marked `error` in the registry, and emitted as `extensions:error` events. The process is killed. One extension's failure does not block others.
- **Eager only for v1**. `activationEvents` is plumbed through but only `"*"` is accepted; other values fail validation.
- **Boot reconcile**: the registry is reconciled against the declared `extensions:` set. Approved declared extensions start; unapproved ones surface in the joint approval (non-blocking) and activate on grant; undeclared registry entries are stopped and removed.
- **Newly declared (meta push)**: the combined meta-push approval gates the push; on grant the manager builds and activates the newly-declared extensions. Removing a declaration stops and removes the extension.
- **Extension source push**: a `main` / `master` push is approved before the ref moves. After receive completes, the manager records the approved build as active and replaces the running process.
- **Dependency changes**: adopted on the next reconcile (startup or meta push), or via `reload`. They do not auto-reload a running extension on their own.
- **Hot reload**: `reload` restarts the currently active approved build, rebuilding if the dependency graph changed.
- **Crash**: handled by the crash policy above. The process boundary contains the failure; the host keeps running.

## Dispatcher and approval integration

Core dispatcher changes:

- Add `"extension"` to `CallerKind`.
- `ServiceContext.callerId` for an extension call is the extension name.
- Existing service definitions are reviewed one by one. Host-substrate services extensions need (`workspace`, `credentials`, `notifications`, `events`, etc.) explicitly add `"extension"` to `policy.allowed`; shell/admin-only services do not get extension access by default.
- `CodeIdentityResolver`, approval shared types, `UserlandApprovalGrantStore`, approval copy, and `userlandApprovalService` stay panel/worker-principal based. They are extended only enough for an extension-host internal call to submit `ApprovalQueue.requestUserland(...)` using a host-stamped `ExtensionInvocation.userlandCaller`.
- Approval prompts initiated by extensions use the standard userland prompt style, **not** the elevated one — elevated prompts are reserved for install, dependency update, and extension source-push events. The standard prompt's caller-attribution string surfaces both the panel/worker being asked and the extension asking. The prompt is fundamentally a user-intent mechanism (the extension chose to ask the caller) rather than a security boundary against already-installed Node code.

`ctx.fs` for an extension is **unrestricted** — it covers the whole host filesystem, matching the ambient `node:fs` access the extension already has. There is no per-context root and no path scoping. This is a deliberate departure from panel/worker semantics; per-context rooting would be theater, since the extension can write anywhere via `node:fs` directly. The userland `ctx.fs` exists for callers that want auditable, user-attributable writes; the unrestricted scope makes that path strictly more capable than scoped, not less.

## Extension host package

A new package `packages/extension-host/`:

```
packages/extension-host/
├── src/
│   ├── index.ts                  # boot, walk registry, spawn enabled extensions
│   ├── registry.ts               # in-memory map + registry.json atomic writes
│   ├── processManager.ts         # ExtensionProcessManager (sibling to WorkerdManager)
│   ├── childRuntime.ts           # entry shipped into the child process — sets up WS,
│   │                             # imports the bundle, calls activate, handles invokes
│   ├── service.ts                # dispatcher service ("extensions") handler — invoke / on / management
│   └── installer.ts              # install / uninstall / update / reload pipeline + git-push gate integration
```

`childRuntime.ts` is the entry actually executed by the forked process. It reads the bundle path and gateway URL from `process.env`, opens the WebSocket, loads the ESM bundle with `await import(pathToFileURL(bundlePath).href)`, calls `module.activate(ctx)`, and serves invoke requests by looking up the returned API object. The user's bundle is loaded as a normal Node module — no `vm.createContext`, no sandbox — `vm.createContext` adds nothing once the process boundary is in place.

The host runs in-process with the server. It mounts the `extensions` dispatcher service onto the existing dispatcher. The Electron main process consumes the same package — there is one extension host per running NatStack instance regardless of mode.

`childRuntime.ts` also handles the fetch envelope frames described in "HTTP fetch (optional)" — when the host forwards an HTTP request, the child invokes the bundle's default-export `fetch`, awaits the Response, and frames the bytes back.

## Workspace-unit conventions

Extensions are one kind of **workspace unit**, alongside workers and panels. The conventions in this section apply to all kinds — they are not extension-specific — and represent the surfaces that should converge as workers and panels migrate to match. Implementation may land incrementally; the contract is the target.

### Manifest shape

Shared keys at `natstack.*` (`displayName`, `entry`, `sourcemap`, …). One kind-specific sub-block (`natstack.extension`, `natstack.worker`, `natstack.panel`) declares the kind. A unit has exactly one kind-specific sub-block. The discriminator is **block presence**, not a separate `kind` field.

Documented in the unit's `package.json`, validated at install/boot, lives in workspace git. See "Manifest" above for the extension-specific table.

### Unified status surface

A workspace-wide RPC, mounted on the dispatcher as `workspace.units`:

```ts
interface UnitsClient {
  list(): Promise<UnitStatus[]>;
  watch(): AsyncIterable<UnitStatus[]>;       // observable for UIs
  inspector(name: string): Promise<{ url: string } | null>;  // dev only
  restart(name: string): Promise<void>;       // approval-gated for extensions
}

interface UnitStatus {
  kind: "extension" | "worker" | "panel";
  name: string;
  displayName: string;
  ev: string;
  lastBuiltAt: number;
  status: "running" | "stopped" | "error" | "pending-approval" | "building";
  lastError: string | null;
  bindings?: Record<string, unknown>;          // worker-specific (DOs, env, …)
  pendingApproval?: { kind: string; submittedAt: number };  // extension install/update
  availableUpdate?: { reason: "dependency"; checkedAt: number }; // extension-specific
  respawn?: { attempts: number; nextAttemptAt: number | null };
  inspectorUrl?: string;                       // when the unit was launched with --inspect
  health?: UnitHealth;                         // self-reported when status === "running"
}

interface UnitHealth {
  state: "healthy" | "degraded" | "unhealthy";
  summary: string;
  reasons?: string[];
  reportedAt: number;
  retryAt?: number;
}

```

This is the single surface a "running units" panel reads from. Pending install/update approvals surface as `pendingApproval`; extension source-push approvals stay in the git push UI. Dependency-only refreshes surface as `availableUpdate` until the user chooses to update. Crash respawn state surfaces in `respawn`. Build state surfaces as `building`. Self-reported operational health surfaces in `health` (see below). The panel sees all unit kinds in one inventory and is allowed to assume the schema is uniform.

`workspace.units` is read by panels and extensions via the standard dispatcher policy. `restart` for extensions is approval-gated and restarts the currently active approved build; it does not implicitly adopt dependency changes.

### Health states

`status` reports **lifecycle** state (is this unit running at all?); `health` reports **operational** state (is the running unit doing its job?). The two are independent: a `running` extension can be `degraded` (e.g. its upstream FCM credentials expired, but it's still serving cached state).

Extensions self-report via `ctx.health.report(state, detail)` or the convenience wrappers `ctx.health.healthy()` / `degraded(detail)` / `unhealthy(detail)`. The host writes the latest report to `UnitStatus.health`; consumers of `workspace.units.list()` and `watch()` see it.

| State | Meaning | `detail` required |
|-------|---------|---|
| `healthy` | Operating normally. The default immediately after `activate()` resolves, until the extension says otherwise. | No |
| `degraded` | Partially functional. Some callers may get correct results, others may get errors or stale data. The extension is *still trying*. | Yes — must explain what's degraded |
| `unhealthy` | Cannot do its job. Calls into this extension will likely fail until something changes. | Yes — must explain why |

`HealthDetail.summary` is a one-line description shown on the status row (`"FCM credentials expired"`, `"native libvips missing — falling back to JS encoder"`). `reasons` is an optional list of bullet points shown when the user expands the row. `retryAt` (epoch ms), when set, indicates when the extension expects the situation to resolve and gives the UI material to render a countdown.

Workers report health through the same channel (via their own runtime hook); panels are out of scope today. The unified status surface is allowed to assume `health` is present and recent for any `running` unit; an extension that crashes between health reports stays at its last reported state until its `status` flips.

Health is **observability**, not a gate. The host does not refuse calls to an `unhealthy` extension — it surfaces the state so consumers and users can decide. An extension that wants to refuse inbound calls in some condition should throw / return errors itself.

### Logs

Every workspace unit's logs flow to a single workspace-wide stream keyed by `(workspaceId, unitName, kind)`. Records have a uniform schema:

```ts
interface UnitLogRecord {
  workspaceId: string;
  unitName: string;
  kind: "extension" | "worker" | "panel";
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
  source?: "stdout" | "stderr" | "ctx.log" | "console";
}
```

For extensions, `ctx.log` writes to this stream; bare `console.log` / `console.error` are also captured (the runtime intercepts stdout/stderr in the forked process and lifts each line into a record). Workers' `console.*` flow into the same stream by capturing workerd's output. Panels are out of scope today but the same schema accommodates browser-console mirroring later.

A single log-viewer panel reads the stream filtered by unit, with severity and time-range filters. The log stream is also addressable by `workspace.units.logs(name, { since, level })` for programmatic consumption.

### Debugger

In development mode each extension process is launched with `--inspect=0` (random port). The chosen URL is exposed as `inspectorUrl` on `UnitStatus`; the running-units panel renders "Open Inspector" as a single click. Sourcemaps are inlined (`sourcemap: true` is the mandatory default for extensions), so the debugger lands in the original TypeScript.

Workers expose workerd's inspector through the same `UnitStatus.inspectorUrl` field — different underlying protocol, same UI affordance. The user clicks "Open Inspector" and the host opens whichever URL is appropriate.

In production mode (`NATSTACK_PROD=1` or equivalent), `--inspect` is not enabled and `inspectorUrl` is `null`. This is purely a dev convenience.

### Reload UX

Reload behavior is intentionally different by unit kind:

- **Workers**: rebuilt on push; the next inbound request hits the new bundle. No prompt — workerd's sandbox is the boundary.
- **Panels**: rebuilt on push; the next page load hits the new bundle. No prompt — the panel's per-call approvals already gate any sensitive operation.
- **Extensions**: source pushes to `main` / `master` are approved before the branch ref moves, then the approved build reloads. Dependency changes do not auto-reload extensions; they only surface an available update until the user chooses to update. The `dev-session` decision is the explicit opt-in to a workers-like source-push loop while actively iterating on an extension.

The status surface, log stream, and inspector affordance described above are what make the three reload modes feel like one system from the user's perspective. The trust-shape difference is intentional and visible only in the elevated approval prompt.

## Migration candidates

A survey of `src/server/services/` against the extension fit criteria suggests the following migration order. The first two are the canaries that exercise every feature this plan introduces; later ones are nice-to-have rather than load-bearing.

### Canaries

1. **`imageService`** — first migration. Exercises:
   - The "extension replaces in-tree service" pattern. Existing `ctx.image.*` call sites migrate mechanically to `extensions.use<ImageApi>("@workspace-extensions/image-service").*` — a one-time codemod. After migration `ctx.image` is gone from the host runtime; consumers reach the image extension explicitly through `extensions.use`. Swapping implementations later means uninstalling and installing a different extension at the same canonical name.
   - Pure compute, no statefulness — minimal blast radius if it goes sideways.

2. **`typecheckService`** — second migration. Compute-heavy, long-running TS server. Tests an extension that holds substantial in-memory state across many calls.

### Follow-on (after canaries land)

3. **`pushService` + `approvalPushBridge`** — FCM push for mobile shells. Optional capability (only relevant if mobile push is wanted), self-contained, has its own credentials needs. Good test of `ctx.credentials` from an extension and of long-lived outbound connections.

4. **`browserDataService`** — migrated to `@workspace-extensions/browser-data`. Bookmarks/history/cookies still persist through `BrowserDataDO`; the extension owns the public API, shell-only enforcement, import completion events, and operational health reporting.

5. **`webhookIngressService`** — deferred until custom/public HTTP routes exist. Webhook URLs must be at fixed, upstream-configured paths (`/webhooks/github`, `/webhooks/stripe`), not under `/_r/ext/*`.

### Workspace-wide refactors (touch panels and workers, not just extensions)

These are migrations where the current in-host service is exposed on `ctx.*` to *all* userland — panels, workers, and (until now in this doc) extensions. Migrating them means dropping the `ctx.*` entry across the panel/worker runtime too, and codemodding every consumer to `extensions.use(...)`. The blast radius is much larger than for imageService, so they're deliberately not first canaries.

6. **AI runtime client** — removed from the runtime surface instead of migrated. The chat agent path already owns current model execution, and there were no active runtime callers left for the old package/client.

7. **Legacy workspace Git service** — removed. Workspace repo state uses the GAD-native `vcs` surface, while explicit external Git import/export lives behind `gitInterop`.

8. **`webhooks` consumer surface** — once `webhookIngressService` eventually lands as an extension, the corresponding `ctx.webhooks` subscription client also goes away in favor of `extensions.use<WebhookApi>("@workspace-extensions/webhook-ingress")`.

### Will need new design work before migrating

9. **`egressProxy`** — needs a port-allocation primitive (no current design for "extension binds its own listening port and publishes it"). Defer until a raw TCP port-claim mechanism is added.

### Must stay in-host

Listed here so future readers don't waste time considering them:

- **Dispatcher, route registry, transport, `ServiceContainer`** — the substrate extensions plug into.
- **Approvals system** (`approvalQueue`, `shellApprovalService`, `userlandApprovalService`, `capabilityPermission`, `capabilityGrantStore`) — the single source of truth for user consent.
- **Auth and identity** (`authService`, `tokensService`, `deviceAuthStore`, `codeIdentityResolver`) — every RPC's caller identity flows through these.
- **Build pipeline** (`buildService`, buildV2) — builds the extensions.
- **Worker lifecycle** (`workerdService`, `workerService`, `workerLogService`) — co-equal infrastructure.
- **Panel orchestration** (`workspace-sync`, `PanelStoreDO`).
- **Core services other services use** (`blobstoreService`, `scopeService`, `metaService`, `notificationService`).
- **Credential storage** (`credentialService`, `credentialLifecycle`) — host-rooted trust. Additional credential *backends* (hardware tokens, etc.) could be extensions; the core stays.
- **`auditService`** — security audit log. Could technically be an extension, but making auditing optional weakens it as a property. Keep in-host.

### Gaps surfaced by the migration plan

The imageService and typecheckService canaries cover the RPC migration shape and long-lived process state. Additional gaps the rest of the migration plan flags, **not addressed in v1**:

- **Custom/public HTTP routes.** Required for webhookIngressService and OAuth callbacks. Defer until a candidate forces it.
- **Port-claim mechanism for non-HTTP listeners.** Required for egressProxy. Defer until a candidate forces it.
- **Scheduled-work primitive.** Email-sync-style "poll every 5 minutes, survive restarts" — works today with `setInterval` plus self-managed persistence, but ergonomically wants a `ctx.schedule(name, intervalOrCron, handler)` helper that uses the extension's storage. Defer; not blocking the first migrations.

A "named capabilities" / `provides` mechanism was considered and rejected: paths suffice. The canonical name for a given capability (e.g. `@workspace-extensions/image-service`) is a convention, swapping implementations means uninstalling and installing a different extension at the same name, and migration from an in-host service drops `ctx.image` in favor of explicit `extensions.use(...)` calls at the call sites. Introducing a host-side capability registry would add provider conflict resolution, missing-provider semantics, and asymmetry in `ctx.*` (some entries host-direct, others extension-routed) — none of which buy more than the path-based convention already does.

## Future work

Out of scope for v1, kept as forward-compat anchors:

- **Lazy activation**: the `activationEvents` field is plumbed through but only `"*"` is honored.
- **Custom/public HTTP routes**: top-level gateway paths such as `/webhooks/github`. Needed for webhookIngressService and OAuth callbacks, deliberately out of v1.
- **Port-claim mechanism**: raw TCP/UDP listeners. Needed for egressProxy and any future protocol-bridge extension. Same install-time conflict and elevated-approval surfacing.
- **Scheduled-work primitive**: `ctx.schedule(name, intervalOrCron, handler)` with restart-survival via the extension's storage scope. Email-sync-style use cases work today with `setInterval` + self-managed persistence, but the ergonomics could be much better.
- **HTTP fetch streaming**: large extension fetch request/response bodies are now file-backed instead of base64-buffered in the RPC frame. Fully live chunk streaming over the WebSocket fetch envelope remains a bigger frame protocol change.
- **Per-workspace extension catalogs**: today extensions are workspace units. A central catalog of vetted extensions could layer on top.
- **Cross-extension type sharing**: today consumers either define interfaces themselves or duplicate types. A generated aggregate `.d.ts` from active extensions becomes pressing once a few services migrate.
- **Resource limits**: per-extension RSS caps and CPU quotas. The OS can enforce these via `setrlimit`-equivalents; not wired in v1.
- **Extensions shipping panels**: deliberately out of scope. Extensions register RPC APIs and HTTP routes; a separate panel can call into the extension.
- **Config schema in manifest**: `natstack.extension.config: <jsonschema>` paired with a host-rendered generic config UI. Several migration candidates (push, browserData, image) have user-tweakable settings; shipping a panel per extension is heavy.

## Related cleanup

The same change set removes stale `agent` build-kind references:

- `BUILD_SYSTEM.md` removes the "Agent build (node target)" subsection and the `workspace/agents/` directory entry.
- `src/server/buildV2/packageGraph.ts` header comment (lines 1–7) drops the `workspace/agents/` reference.
- `STATE_DIRECTORY.md` removes the "agents only" qualifier on the `package.json` entry in the build-store sentinel.

## See also

- [PANEL_SYSTEM.md](PANEL_SYSTEM.md) — panel architecture
- [STATE_DIRECTORY.md](STATE_DIRECTORY.md) — `{userData}/` layout
- [PERMISSIONS.md](PERMISSIONS.md) — userland permission requirements (extensions are subject to these for userland-runtime calls; their full-Node access is granted by the elevated install approval)
- [BUILD_SYSTEM.md](BUILD_SYSTEM.md) — buildV2 pipeline (extensions are a node-target ESM build kind alongside panel and worker)

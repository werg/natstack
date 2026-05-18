---
name: extensiondev
description: Author NatStack extensions — long-lived Node processes that expose RPC APIs (and optionally HTTP fetch handlers) to panels, workers, and other extensions. Covers manifest, activate(), the ctx surface, approvals, the dev push loop, debugging.
---

# Extension Development Skill

NatStack extensions are workspace units that live alongside panels and workers but run in their own forked Node process with **full Node access** (`node:fs`, `child_process`, native addons). They are the canonical way to add a new RPC API, replace an in-host service, or wrap a long-running native dependency.

If you're calling an existing extension from a panel or worker, you don't need this skill — see `paneldev/TOOLS.md` for `extensions.use(name)` patterns. This skill is for **writing** an extension.

## Files

| Document | Content |
|----------|---------|
| [AUTHORING.md](AUTHORING.md) | Workspace layout, `package.json`, `activate(ctx)`, the API contract, the `ctx.*` surface |
| [APPROVALS.md](APPROVALS.md) | `ctx.invocation.current()`, `ctx.approvals.requestForCaller(...)`, how extensions decide when to prompt |
| [FETCH.md](FETCH.md) | Optional default-export `fetch` handler and the `/_r/ext/<name>/*` route |
| [DEV_LOOP.md](DEV_LOOP.md) | Workspace git push as the dev signal, dev-session approval, inspector, log stream |
| [MIGRATIONS.md](MIGRATIONS.md) | Migrating an in-host service into an extension (the canary pattern) |

## When to write an extension

- You want a callable API that needs **Node**: filesystem, child processes, native or WASM modules, long-lived sockets, large in-memory state.
- You're replacing an in-tree `src/server/services/*` service that doesn't need to be in-host (the spec lists migration candidates — see [MIGRATIONS.md](MIGRATIONS.md)).
- You want a fetch endpoint that has trusted ambient access to the user's machine.

If a worker (workerd isolate) is sufficient, prefer that — workers are cheaper and have the workerd sandbox as a real boundary. Extensions trade that boundary for full Node access; the trust grant is the elevated install approval.

## Critical rules

1. **`workspace/extensions/<scope>/<name>/`** is the location. The package must be `private: true` and `type: "module"`, and the `package.json` must have `natstack.extension` (validated at install **and** boot — bad manifests fail closed).
2. **`activate(ctx)` returns a plain object.** Its own enumerable function properties become RPC methods. Inherited methods, `then`, and non-function properties are skipped.
3. **`ctx.fs` for an extension is unrestricted** — it covers the whole host filesystem. This is not a sandbox; it exists for *auditable* writes. For silent ambient work, import `node:fs` directly. The install approval is the trust boundary.
4. **Use `ctx.approvals.requestForCaller(...)`** for any operation the user should explicitly authorize per call. The host derives the principal from `ctx.invocation.current()`; you supply the local subject, copy, and options.
5. **Prefer ESM**. For external CommonJS packages, use default imports + destructure (`import pkg from "x"; const { fn } = pkg`). Named imports from CJS are blocked.
6. **No `console.log` in production paths.** Use `ctx.log.{debug,info,warn,error}` so logs land in the workspace-unit stream (`workspace.units.logs(name)`). `console.*` is captured too, but as `source: "stdout"` / `"stderr"` instead of structured records.
7. **Source pushes are the dev signal.** Push to the extension repo's `main` (or `master`) — the user gets an extension push approval and the manager rebuilds + replaces the running process. There is no `extensions.reload` for source changes.

## Quick start

```ts
// workspace/extensions/@workspace-extensions/hello/package.json
{
  "name": "@workspace-extensions/hello",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "natstack": {
    "displayName": "Hello",
    "entry": "index.ts",
    "sourcemap": true,
    "extension": { "activationEvents": ["*"] }
  }
}
```

```ts
// workspace/extensions/@workspace-extensions/hello/index.ts
import type { ExtensionContext } from "@natstack/extension";

export async function activate(ctx: ExtensionContext) {
  ctx.log.info("hello activating");
  return {
    async greet(name: string) {
      return `hello, ${name}`;
    },
  };
}
```

Install from a panel or worker:

```ts
import { extensions } from "@workspace/runtime";
await extensions.install({
  source: { kind: "internal-git", repo: "extensions/@workspace-extensions/hello", ref: "HEAD" },
});
const hello = extensions.use<{ greet(name: string): Promise<string> }>("@workspace-extensions/hello");
await hello.greet("world");
```

The first `install` triggers an **elevated approval** ("Install and run / Don't install") because the extension runs as native code.

## Common tasks

| Task | How |
|------|-----|
| Scaffold a new extension | Copy from `docs/extensions/templates/{minimal,plain-js-dep,external-cjs,native-wasm}/` |
| Read manifest rules | See [AUTHORING.md](AUTHORING.md) — `natstack.extension` shape, `dependencyMode` |
| Decide when to prompt the user | See [APPROVALS.md](APPROVALS.md) — `requestForCaller` + grant lookup |
| Add an HTTP endpoint | See [FETCH.md](FETCH.md) — default-export `fetch` handler |
| Push edits and pick up changes | See [DEV_LOOP.md](DEV_LOOP.md) — git push, dev-session, inspector |
| Migrate from `src/server/services/*` | See [MIGRATIONS.md](MIGRATIONS.md) — canary pattern, `extensions.use(...)` codemod |
| Inspect an extension's status / health / logs | `workspace.units.list()`, `workspace.units.logs(name)`, `workspace.units.inspector(name)` |
| Force restart (no source change) | `extensions.reload(name)` — approval-gated, restarts the active approved build |

## Reference material

- [EXTENSIONS.md](../../../EXTENSIONS.md) — the canonical spec (manifest, ABI, approval flow, migration candidates, future work)
- [docs/extensions/runtime.md](../../../docs/extensions/runtime.md) — manifest + entry-shape reference
- [docs/extensions/generated-code.md](../../../docs/extensions/generated-code.md) — rules for code-generators emitting extensions
- [docs/extensions/templates/](../../../docs/extensions/templates/) — four working scaffolds
- Existing canary extensions (read these for working examples):
  - `workspace/extensions/@workspace-extensions/image-service/`
  - `workspace/extensions/@workspace-extensions/typecheck-service/`
  - `workspace/extensions/@workspace-extensions/browser-data/`

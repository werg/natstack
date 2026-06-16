# Dev loop

Extension source authoring happens in the shared workspace VCS state, like any
other workspace unit. Saving files locally doesn't restart anything — a
committed workspace state advance is the dev signal.

## The flow

1. Edit files under `workspace/extensions/<name>/`.
2. Commit the workspace state with `vcs.commit` or the workspace-dev helpers.
3. The state advance triggers the extension-specific approval prompt.
4. On approve, the manager rebuilds the bundle, replaces the running process, and runs `activate(ctx)` again.
5. On deny, the main-head advance is rejected and the old extension keeps running.

There is no "save file → hot reload" path. Context-head work does not affect
the running extension until it is published into `main`.

## Dev-session approval

The source approval offers three choices:

- **Allow update** — accept this source update.
- **Reject update** — reject the main-head advance and keep the old extension running.
- **Allow extension updates to `<name>` without asking, for the next 4 hours** — the dev-session grant. Stored against the extension identity and consulted before re-prompting.

Pick dev-session while actively iterating. It expires automatically; the next source update outside the 4h window prompts again.

This is the one place the extension trust model loosens for ergonomics. Source
updates for extensions are privileged — review what you're publishing before
granting a session.

## Committing from a panel or worker

```ts
import { commitWorkspace } from "@workspace-skills/workspace-dev";

await commitWorkspace("extensions/hello", "Add greet method");
```

`commitWorkspace` from the `workspace-dev` skill delegates to `vcs.commit` and
works on extension units the same way it works on panel/worker units. The first
commit can prompt; subsequent commits in a dev session auto-accept.

## Inspector (dev mode only)

In dev mode each extension process is launched with `--inspect=0` (random port). The inspector URL surfaces on `workspace.units.list()` and `workspace.units.inspector(name)`:

```ts
const info = await workspace.units.inspector("@workspace-extensions/hello");
// { url: "ws://127.0.0.1:48273/abc-…" }
```

Opening that URL attaches Chrome DevTools to the extension process. Sourcemaps are inlined (required), so breakpoints land in the original TypeScript.

In production mode (`NATSTACK_PROD=1` or `NODE_ENV=production`), `--inspect` is disabled and `inspector(name)` returns `null`.

## Status, health, logs

The unified status surface (`workspace.units.list()`) is the right tool for "is my extension running" introspection. It returns one row per workspace unit (panels, workers, extensions) with:

- `status` — lifecycle: `running`, `stopped`, `building`, `error`, `pending-approval`
- `health` — self-reported operational state (see `ctx.health` in [AUTHORING.md](AUTHORING.md))
- `respawn` — when the manager is mid-backoff after a crash, this shows `{ attempts, nextAttemptAt }`
- `pendingApproval` — set when a declaration/update approval is in flight
- `availableUpdate` — set when current workspace state would change the extension's runtime inputs (a dependency source update, an external-dep bump)
- `lastBuiltAt` — best-effort epoch ms of the active bundle
- `lastError` — populated on `error` status
- `inspectorUrl` — dev-only

`workspace.units.logs(name, { since?, level?, limit? })` returns recent log records for any unit. `workspace.units.diagnostics(name, { limit?, errorLimit?, since?, level? })` returns the same bounded log stream plus a separate error-only buffer, dropped counts, and the current unit status row.

Extension records from `ctx.log`, extension process stdout/stderr, worker/DO `console.*`, and panel lifecycle diagnostics share the same persisted diagnostic history. The history is retained under the workspace state directory with separate bounds for general logs and errors, so noisy info logs do not evict the error trail.

## Restart without a source change

```ts
await extensions.reload("@workspace-extensions/hello");
```

Approval-gated. Restarts the _currently active approved build_ — does not pull dependency changes. Use this after editing in-process state (env vars, on-disk config) that the extension reads at `activate()` time.

To adopt dependency changes (a `@workspace/runtime` commit, an `npm` version bump), the extension must rebuild — and rebuilds happen only on reconcile, at workspace startup or when `meta/natstack.yml` is committed. `extensions.reload(name)` restarts the _active approved build_ and does **not** rebuild, so it won't pick up dependency changes on its own, and dependency commits don't auto-reload a running extension either.

## Common failure shapes

| Symptom                             | Cause                                                                   | Fix                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `MANIFEST_KIND`                     | `package.json` is missing `natstack.extension` (or has two kind blocks) | Add exactly one `natstack.extension` block                                    |
| `MANIFEST_ACTIVATION`               | `activationEvents` is not `["*"]`                                       | Lazy activation is future work — must be `["*"]` in v1                        |
| Stays in `error` after update       | `activate()` threw                                                      | Check `lastError` on `workspace.units.list()`; look at the inspector log      |
| `Cannot find module ...` at runtime | Dep was externalized but missing from runtime install                   | Set `dependencyMode: "external"` and confirm the package is in `dependencies` |
| `Named export ... not found`        | ESM imported a named export from a CJS package                          | Use `import pkg from "x"; const { fn } = pkg;`                                |
| `require is not defined`            | Code crossed an ESM/CJS boundary in a bundled dep                       | Switch the dep to `dependencyMode: "external"`                                |
| 503 from `/_r/ext/<name>/*`         | Extension is `pending-approval`, `building`, or `error`                 | Approve the declaration/update or check `lastError`                           |
| 413 from fetch endpoint             | Request body exceeded 32 MB                                             | Split the upload or stream to disk via `ctx.fs`                               |

## Remove a Declaration

Remove the extension's entry from the `extensions:` list in `meta/natstack.yml` and commit the workspace state. The next reconcile stops the process and deletes its registry entry; the per-extension storage scratch is retained. The workspace source tree stays until you remove those files separately. Userland approval grants the extension received persist (they're keyed by `(principal, extension-name)`); re-declaring under the same name reuses them. The declared set is authoritative.

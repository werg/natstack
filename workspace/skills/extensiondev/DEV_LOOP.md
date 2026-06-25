# Dev loop

Extension source authoring happens in the per-repo workspace VCS, like any
other workspace unit. Each extension is its own versioned repo
(`extensions/<name>`). The loop is **build-on-push**: `vcs.edit` (via the
`edit`/`write` tools) lands WORKING content on your per-repo context head with no
build and no restart; `vcs.commit({ message })` snapshots it; pushing that repo
into its `main` (a build-gated, ff-only `main`-head advance) is the dev signal.

## The flow

1. Edit files under `workspace/extensions/<name>/` with the `edit`/`write`
   tools — each edit lands on your context head as WORKING content. Nothing
   builds or restarts.
2. Optionally dev-build your working content first:
   `vcs.previewBuild({ repoPaths: ["extensions/<name>"] })` — surfaces
   `file:line:col` diagnostics without committing or writing a baseline.
3. Commit the working edits: `vcs.commit({ message: "…" })`.
4. Push the extension repo into its `main`: `vcs.push({ repoPaths: ["extensions/<name>"] })`.
5. The push is build-gated; on a successful build the `main`-head advance triggers the extension-specific approval prompt.
6. On approve, the manager rebuilds the bundle, replaces the running process, and runs `activate(ctx)` again.
7. On deny, the main-head advance is rejected and the old extension keeps running.

A `build-failed` push advances nothing and returns structured `file:line:col`
diagnostics — fix those (edit → commit) and re-push. `vcs.push` rejects outright
if you still have uncommitted edits — commit first. There is no "save file → hot
reload" path. Working and committed context-head work does not affect the running
extension until it is pushed into its `main`.

## Dev-session approval

The source approval offers three choices:

- **Allow update** — accept this source update.
- **Reject update** — reject the main-head advance and keep the old extension running.
- **Allow extension updates to `<name>` without asking, for the next 4 hours** — the dev-session grant. Stored against the extension identity and consulted before re-prompting.

Pick dev-session while actively iterating. It expires automatically; the next source update outside the 4h window prompts again.

This is the one place the extension trust model loosens for ergonomics. Source
updates for extensions are privileged — review what you're pushing before
granting a session.

## Pushing from a panel or worker

Edits to extension source land on your per-repo context head as WORKING content
(the `edit`/`write` tools apply through `vcs.edit`). To make them affect the
running extension, commit them and push the extension repo into its `main`:

```ts
import { vcs } from "@workspace/runtime";

await vcs.commit({ message: "fix hello extension", repoPaths: ["extensions/<name>"] });
await vcs.push({ repoPaths: ["extensions/<name>"] });
```

`vcs.push` works on extension repos the same way it works on panel/worker repos;
the build-gated, ff-only `main`-head advance is what triggers the rebuild. A
`build-failed` push advances nothing and returns `file:line:col` diagnostics to
fix; a push with uncommitted edits is rejected (commit first). The first push can
prompt; subsequent pushes in a dev session auto-accept.

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

To adopt dependency changes (a `@workspace/runtime` push, an `npm` version bump), the extension must rebuild — and rebuilds happen only on reconcile, at workspace startup or when `meta/natstack.yml` is pushed into its `main`. `extensions.reload(name)` restarts the _active approved build_ and does **not** rebuild, so it won't pick up dependency changes on its own, and dependency pushes don't auto-reload a running extension either.

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

Remove the extension's entry from the `extensions:` list in `meta/natstack.yml` (the `edit`/`write` tools land the change as working content), then `vcs.commit({ message })` and push the `meta` repo into its `main` (`vcs.push({ repoPaths: ["meta"] })`). The next reconcile stops the process and deletes its registry entry; the per-extension storage scratch is retained. The workspace source tree stays until you remove those files separately. Userland approval grants the extension received persist (they're keyed by `(principal, extension-name)`); re-declaring under the same name reuses them. The declared set is authoritative.

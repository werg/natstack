# Dev loop

Extension source authoring happens **in the workspace git repo for the extension**, like any other workspace unit. Saving files locally doesn't restart anything — the **push** is the dev signal.

## The flow

1. Edit files under `workspace/extensions/<name>/`.
2. Commit and push to the extension repo's `main` (or `master`).
3. The git server sees an extension push and triggers the extension-specific approval prompt.
4. On approve, the manager rebuilds the bundle, replaces the running process, and runs `activate(ctx)` again.
5. On deny, the push fails — the branch ref doesn't move and the old extension keeps running.

There is no "save file → hot reload" path. Pushes to **other** branches don't affect the running extension.

## Dev-session approval

The push approval offers three choices:

- **Allow push** — accept this push.
- **Reject push** — fail the push, keep old extension running.
- **Allow extension pushes to `<name>` without asking, for the next 4 hours** — the dev-session grant. Stored against `(extension, repo, branch)` and consulted before re-prompting.

Pick dev-session while actively iterating. It expires automatically; the next push outside the 4h window prompts again.

This is the one place the extension trust model loosens for ergonomics. Source pushes to extension branches are a privileged operation, not a normal git write — review what you're pushing before granting a session.

## Pushing from a panel or worker

```ts
import { commitAndPush } from "@workspace-skills/workspace-dev";

await commitAndPush("extensions/hello", "Add greet method");
```

`commitAndPush` from the `workspace-dev` skill delegates to
`git.publishWorkspaceRepo` and works on extension repos the same way it works on
panel/worker repos. The first push will prompt; subsequent pushes in a dev
session auto-accept.

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
- `availableUpdate` — set when current workspace state would change the extension's runtime inputs (a dep push, an external-dep bump)
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

To adopt dependency changes (a `@workspace/runtime` push, an `npm` version bump), the extension must rebuild — and rebuilds happen only on reconcile, at workspace startup or when `meta/natstack.yml` is pushed. `extensions.reload(name)` restarts the _active approved build_ and does **not** rebuild, so it won't pick up dependency changes on its own, and dependency pushes don't auto-reload a running extension either.

## Common failure shapes

| Symptom                             | Cause                                                                   | Fix                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `MANIFEST_KIND`                     | `package.json` is missing `natstack.extension` (or has two kind blocks) | Add exactly one `natstack.extension` block                                    |
| `MANIFEST_ACTIVATION`               | `activationEvents` is not `["*"]`                                       | Lazy activation is future work — must be `["*"]` in v1                        |
| Stays in `error` after push         | `activate()` threw                                                      | Check `lastError` on `workspace.units.list()`; look at the inspector log      |
| `Cannot find module ...` at runtime | Dep was externalized but missing from runtime install                   | Set `dependencyMode: "external"` and confirm the package is in `dependencies` |
| `Named export ... not found`        | ESM imported a named export from a CJS package                          | Use `import pkg from "x"; const { fn } = pkg;`                                |
| `require is not defined`            | Code crossed an ESM/CJS boundary in a bundled dep                       | Switch the dep to `dependencyMode: "external"`                                |
| 503 from `/_r/ext/<name>/*`         | Extension is `pending-approval`, `building`, or `error`                 | Approve the declaration/update or check `lastError`                           |
| 413 from fetch endpoint             | Request body exceeded 32 MB                                             | Split the upload or stream to disk via `ctx.fs`                               |

## Remove a Declaration

Remove the extension's entry from the `extensions:` list in `meta/natstack.yml` and push. The next reconcile stops the process and deletes its registry entry; the per-extension storage scratch is retained. The workspace source tree stays — you'd `git rm` that separately. Userland approval grants the extension received persist (they're keyed by `(principal, extension-name)`); re-declaring under the same name reuses them. The declared set is authoritative.

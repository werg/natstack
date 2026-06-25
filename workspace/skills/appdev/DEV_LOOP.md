# App Development Loop

The dev loop is **build-on-push**: you edit working content, optionally preview a
dev build, then commit and push. Builds are authoritative only at push — `main`
advances only via a build-gated, fast-forward-only push.

The three layers:

- **edit** (`vcs.edit`, or the `edit`/`write` tools) — applies a change to your
  WORKING content on your context head. No commit, no build, not in `vcs.log`.
  A stray `fs.writeFile` that never lands on the head is not an edit.
- **commit** (`vcs.commit({ message })`) — folds your uncommitted working edits
  into a per-repo snapshot on the context head. Still no build; `main` does not
  move.
- **push** (`vcs.push({ repoPaths })`) — fast-forward-only advance of `main`,
  gated on a successful build of the committed content. This is the only step
  that produces an authoritative app build.

Between edit and commit you can run an on-demand **preview build** with
`vcs.previewBuild({ repoPaths })` — it builds your WORKING content so you can
catch type/build errors before committing, and it does NOT write an EV baseline
or advance any head.

## Standard Loop

1. Edit files under `apps/<name>` with the `edit`/`write` tools (which apply
   through `vcs.edit`) — each edit lands on your context head as WORKING content.
   No build runs.
2. Run focused type/tests where available. Use
   `vcs.previewBuild({ repoPaths: ["apps/<name>"] })` to dev-build your working
   content and surface `file:line:col` diagnostics without committing.
3. Commit the working edits: `vcs.commit({ message: "…" })`.
4. Push the app repo into its `main` (build-gated, ff-only):
   `vcs.push({ repoPaths: ["apps/<name>"] })`. The push triggers the
   authoritative build; on success `main` advances.
5. Approve the app install/update/source-change prompt if the trusted identity
   changed.
6. Use the target-specific update prompt to adopt the new build, or keep the
   currently loaded build until you are ready.

A `build-failed` push advances nothing and returns structured `file:line:col`
diagnostics — fix those (edit → commit) and re-push. A `diverged` push means
`main` moved under you; reconcile with `vcs.merge("apps/<name>")` (commit any
conflict resolution), then push again. `vcs.push` rejects outright if you still
have uncommitted edits — commit first.

For context agents, this means making edits through the workspace `edit`/`write`
tools (which apply through `vcs.edit`) rather than direct shell file writes, then
committing and pushing. See `workspace-dev/TOOLS.md` for common helper patterns.

In development, app reconciliation prints an app status diagnostic with source,
target, active EV, build key, source HEAD, and clean/dirty state. Here
"dirty" means the repo's context head has committed changes ahead of `main` (or
uncommitted working edits) that the running trusted app build does not yet
include — not filesystem dirtiness. Set `NATSTACK_APP_DEV_STATUS=0` to silence
the diagnostic, or `NATSTACK_APP_DEV_STATUS=1` to force it outside
`NODE_ENV=development`.

## Approval Behavior

App approvals are unit approvals. They are about trusting the app build and its
declared capabilities, not per-call user intent.

Approval can be required when:

- a new app is declared
- app source changes
- target changes
- capabilities change
- dependencies or external dependency versions change
- React Native provider identity changes
- source ref changes

If a changed app remains in `pending-approval`, the old active app may continue
to be used until the update is approved, depending on the reconcile path.

## Update Errors And Rollback

Push-gated rebuilds keep the previous active app build until the new build
validates. If the build or target validation fails, the push reports
`build-failed`, the previous active build stays in use, the app status becomes
`error`, `apps:status` includes the active build key and effective version that
remain in use, and `apps:lifecycle` emits `type: "update-error"` with the
failure message. The shell and mobile clients surface these events through their
notification/toast surfaces.

Successful app updates record the replaced build in app version history and emit
`apps:lifecycle` with `type: "update-available"`. Adoption is explicit for
already-loaded clients:

- desktop Electron apps keep the current view loaded and show a notification
  with `Load update` and, when available, `Roll back`
- mobile apps show a native prompt with `Install`, `Later`, and `Roll back`
  when rollback history exists
- terminal apps restart automatically when they are already running; otherwise
  the new trusted build remains available until the host target is launched or
  `workspace.units.restart(appName)` starts it

Clients can call `workspace.units.versions(appName)` to inspect the current and
previous builds, and `workspace.units.rollback(appName, { buildKey? })` to
switch the app back to a previous trusted build. Omitting `buildKey` rolls back
to the most recent previous version.

The workspace target picker also supports pinning a host target to a retained
build or to a specific commit/ref. Use this when the latest desktop, mobile, or
terminal app is broken and the host needs to recover on a known-good version.
Pinned targets do not follow newer committed states automatically: approved newer builds
are retained in history, then the host target is restored to the pinned build.
Choose `Follow latest` in the picker to resume normal update adoption.

## Electron App Loop

For Electron apps:

- Confirm the app declares only supported Electron host capabilities.
- For shell/chrome apps, confirm `panel-hosting` is present.
- Verify panel layout, titlebar/sidebar, overlays, menu actions, notifications,
  pair-link handling, and event subscriptions.
- If the app is the shell, test with both local startup and remote startup when
  the change touches pairing or server connection state.

Common failure modes:

- shell app loaded as ordinary app view and sized like panel content
- missing `panel-hosting` blocks view service methods
- missing app event subscriber breaks shell event subscriptions
- unsupported capability rejects app loading
- app source edited via a stray `fs.writeFile` that never landed on the head (use `edit`/`write`), so the working content — and the push build — did not change
- edits left uncommitted, so `vcs.push` rejected them (run `vcs.commit({ message })` first)
- changes committed but never pushed, so `main` and the active build did not advance

## React Native App Loop

For mobile apps:

- Keep native host bootstrap and workspace app responsibilities separate.
- Clean-install pairing must work in the shipped bootstrap before the workspace
  app bundle is available.
- Workspace mobile app should connect through native-held credentials and
  short-lived principal grants.
- Test platform-specific bundles; do not assume Android and iOS artifacts are
  always both present in dev/provider builds.
- Validate OS-level permissions and native module availability separately from
  app capabilities.

Useful smoke path:

1. Start a pairable server.
2. Install or launch a clean mobile host.
3. Open a `natstack://connect?...` link.
4. Verify native bootstrap completes pairing.
5. Verify the host fetches the current platform bundle and reloads into the
   workspace app.
6. Verify the workspace app can refresh a principal grant and connect RPC.

## Terminal App Loop

For terminal apps:

- Expect `apps:available` with `launchMode: "terminal-process"`.
- Use `workspace.units.restart(appName)` to start or restart an available
  terminal app.
- Expect `available` when the build is trusted but no process is running, and
  `running` when the runner has spawned the process.
- Inspect stdout/stderr with `workspace.units.logs(appName)`.
- Test pushed updates and rollback while the terminal app is running; the runner
  should replace the process with the selected trusted build.

Terminal app source should be written as a clean Node ESM entry that reads the
runner-provided `NATSTACK_TERMINAL_APP_*` environment, connects with the
provided RPC grant, and handles shutdown messages from the runner.

## Debugging Headless App State

Use the admin helper when testing a server without a desktop shell:

```bash
node scripts/natstack-admin.mjs --url http://localhost:39139 --admin-token "$NATSTACK_ADMIN_TOKEN" approvals list
node scripts/natstack-admin.mjs --url http://localhost:39139 --admin-token "$NATSTACK_ADMIN_TOKEN" approvals approve version
node scripts/natstack-admin.mjs --url http://localhost:39139 --admin-token "$NATSTACK_ADMIN_TOKEN" units list
node scripts/natstack-admin.mjs --url http://localhost:39139 --admin-token "$NATSTACK_ADMIN_TOKEN" units restart @workspace-apps/remote-cli
node scripts/natstack-admin.mjs --url http://localhost:39139 --admin-token "$NATSTACK_ADMIN_TOKEN" units logs @workspace-apps/remote-cli --limit 120
```

For a full terminal app smoke:

```bash
pnpm test:terminal-app-smoke
```

That command builds the app, starts an ephemeral server, launches the built-in
remote CLI terminal app, asserts it reaches `running`, verifies a pairing invite
appears in logs, and shuts the server down cleanly.

## Updating Docs And Skills

When app architecture changes, update:

- this `appdev` skill
- `onboarding/WORKSPACE_STRUCTURE.md`
- `docs/trusted-workspace-units.md`
- `system-testing/SELF_IMPROVEMENT.md` if the change affects agent repair loops

# App Development Loop

Workspace app source is built from git commits. Editing files locally is not
enough.

## Standard Loop

1. Edit files under `apps/<name>`.
2. Run focused type/tests where available.
3. Commit the app repo.
4. Push through the workspace git server.
5. Approve the app install/update/source-push prompt if the trusted identity
   changed.
6. Wait for rebuild/reconcile.
7. Use the target-specific update prompt to adopt the new build, or keep the
   currently loaded build until you are ready.

For context agents, this usually means using workspace git/runtime APIs rather
than direct shell git commands. See `paneldev/TOOLS.md` for common git helper
patterns.

In development, app reconciliation prints an app status diagnostic with source,
target, active EV, build key, source HEAD, and clean/dirty state. Dirty app
source means the running trusted app build does not include those uncommitted
changes yet. Set `NATSTACK_APP_DEV_STATUS=0` to silence the diagnostic, or
`NATSTACK_APP_DEV_STATUS=1` to force it outside `NODE_ENV=development`.

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

Push-triggered rebuilds keep the previous active app build until the new build
validates. If the build or target validation fails, the app status becomes
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
- terminal apps restart automatically when they are already running or when
  `autostart: true`; otherwise the new trusted build remains available until
  `workspace.units.restart(appName)` starts it

Clients can call `workspace.units.versions(appName)` to inspect the current and
previous builds, and `workspace.units.rollback(appName, { buildKey? })` to
switch the app back to a previous trusted build. Omitting `buildKey` rolls back
to the most recent previous version.

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
- app source edited but not committed/pushed, so build did not change

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
- Test push updates and rollback while the terminal app is running; the runner
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

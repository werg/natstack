# App Testing

App changes can affect startup, trust, pairing, and host UX. Use focused tests
for the target you changed, then run broader smoke checks for shared code.

## Focused Local Commands

From the NatStack application checkout:

```bash
pnpm type-check
```

Electron app/shell view changes:

```bash
pnpm vitest run \
  src/main/appOrchestrator.test.ts \
  src/main/panelView.app.test.ts \
  src/main/viewManager.test.ts \
  src/main/ipcDispatcher.test.ts \
  src/main/services/viewService.test.ts
```

App host, trusted unit, pairing, and bootstrap changes:

```bash
pnpm vitest run \
  src/server/appHost.test.ts \
  src/server/services/authService.test.ts \
  packages/unit-host/src/index.test.ts
```

Build artifact/provider changes:

```bash
pnpm vitest run src/server/buildV2
```

Pairing scripts:

```bash
pnpm vitest run tests/pair-server.test.ts
```

## Electron Shell Smoke Checklist

Verify:

- shell app loads as full-window chrome
- sidebar/titlebar are not hidden by panel-content bounds
- panel switching still shows exactly one panel content view
- overlays hide panel content when active
- theme CSS reaches hosted views
- event subscriptions work after startup and reconnect
- incoming pair links reach the shell app
- unsupported app capabilities fail before view load

## Mobile Smoke Checklist

Verify:

- clean install can consume `natstack://connect`
- bootstrap shows the target server URL and requires Pair/Cancel confirmation
- native bootstrap pairs before workspace app bundle exists
- active workspace bundle registers the native root component name requested by
  Android/iOS
- native host fetches only the current platform artifact
- integrity verification fails closed on bad artifacts
- workspace app connects with a principal grant
- approval notifications and in-app approval sheet still work
- app remains recoverable when no active mobile bootstrap exists

## Terminal Smoke Checklist

Verify:

- terminal target builds a Node ESM primary artifact
- `apps:available` includes `launchMode: "terminal-process"`
- status is `available` before launch and `running` after the runner starts it
- `workspace.units.restart(appName)` starts or replaces the process
- stdout/stderr are visible through `workspace.units.logs(appName)`
- rollback switches to a retained terminal build and returns the app to
  `available` or `running` according to whether the process is launched

Run the packaged smoke when terminal runtime, app host, pairing, or process
supervision changes:

```bash
pnpm test:terminal-app-smoke
```

## Approval And Trust Checks

When capabilities or dependency identity change, test:

- new declaration requires approval
- denied approval leaves app inactive or at previous active build
- approved update becomes active
- source push approval works for app repos
- capability denial surfaces clearly
- newly created template workspaces activate their initial trusted app and
  extension set without a headless approval dead end

## Regression Areas

Pay special attention to:

- shell app identity: app principal vs shell host authority
- layout model: host chrome vs panel content
- event delivery: local IPC subscriber and server replay
- mobile bootstrap: no credentials yet vs already paired
- remote startup: revoked device credential recovery
- platform-specific RN artifacts

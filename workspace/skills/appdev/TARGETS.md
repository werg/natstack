# App Targets

NatStack app targets define how a trusted workspace app is built, delivered,
and activated.

## Electron Target

Manifest:

```json
{
  "natstack": {
    "app": {
      "target": "electron",
      "renderer": "index.tsx",
      "capabilities": ["notifications"]
    }
  }
}
```

The Electron target is built as a browser app and loaded into an Electron
`WebContentsView` with the app preload. It is not a panel, even though it uses
the same low-level view infrastructure.

Important behavior:

- App IPC identity is `callerKind: "app"` and `callerId` is the app package
  name.
- Host capabilities are derived from the approved app manifest.
- Updates to an already-loaded Electron app use `adoptionPolicy: "prompt"`.
  The existing view stays loaded until the user chooses `Load update` from a
  notification or the App updates settings section.
- `panel-hosting` app views are full-window host chrome and are not panel
  content. They must not be sized to the panel content rectangle.
- Ordinary Electron apps should not declare `panel-hosting`; otherwise they get
  host-view authority.
- Shell app changes can break core UX: panel layout, title bar, overlays,
  pairing links, menus, notifications, and app event subscriptions.

Use `panel-hosting` only for shell-like apps that own panel layout and host
chrome. The built-in shell currently declares:

```json
[
  "native-menus",
  "notifications",
  "open-external",
  "window-management",
  "panel-hosting",
  "incoming-pair-links",
  "connection-management"
]
```

## React Native Target

Manifest:

```json
{
  "natstack": {
    "app": {
      "target": "react-native",
      "renderer": "App.tsx",
      "rnComponentName": "NatStack",
      "rnHostAbi": "rn-host-1",
      "capabilities": ["notifications", "open-external"]
    }
  }
}
```

The React Native target is built through a registered build provider. The
server exposes an app bootstrap to the native host; the native host selects the
artifact for its current platform, verifies integrity, writes it to native-owned
storage, and reloads React Native onto that bundle.

Important behavior:

- The shipped native bootstrap must be able to pair a clean install before a
  workspace app bundle exists.
- Native code owns durable device credentials.
- The workspace mobile app uses a short-lived principal grant, not the long-lived
  refresh token.
- The bootstrap may contain one platform artifact or multiple platform
  artifacts. The native host selects the current platform.
- Platform primary artifacts must have `platform: "android"` or `platform:
"ios"` and an integrity string.
- Provider identity is part of trust. Missing provider identity fails closed.
- Updates are installed through a native prompt. Choosing `Install` prepares and
  activates the current trusted bundle; choosing `Roll back` switches the server
  to the previous trusted build, then activates that bundle.

## Terminal Target

Manifest:

```json
{
  "natstack": {
    "app": {
      "target": "terminal",
      "entry": "index.ts",
      "capabilities": ["connection-management"]
    }
  }
}
```

The terminal target builds a Node ESM entry artifact and can be launched by the
server as a supervised app process. The server emits `apps:available` with
`launchMode: "terminal-process"`. Disabled or stopped terminal apps report
`available`; launched terminal apps report `running`.

Important behavior:

- The runner starts the approved primary `.mjs` artifact with Node.
- The app authenticates over `/rpc` with a one-time app principal grant.
- Runtime identity is `callerKind: "app"` and `callerId` is the app package
  name, for example `@workspace-apps/remote-cli`.
- The runner passes bootstrap env vars:
  `NATSTACK_TERMINAL_APP_ID`, `NATSTACK_TERMINAL_APP_SOURCE`,
  `NATSTACK_TERMINAL_APP_BUILD_KEY`,
  `NATSTACK_TERMINAL_APP_EFFECTIVE_VERSION`,
  `NATSTACK_TERMINAL_APP_GATEWAY_URL`,
  `NATSTACK_TERMINAL_APP_RPC_TOKEN`, and
  `NATSTACK_TERMINAL_APP_CONNECTION_ID`.
- Terminal builds remain available after activation until the host target is
  launched or `workspace.units.restart(appName)` starts the process.
- Push updates and rollback replace the process if it is already running.
- stdout/stderr are available through `workspace.units.logs(appName)`.

Use terminal apps for trusted CLI clients, remote-server setup helpers, and
pairing/client-management flows that should run with app capabilities rather
than shell authority.

## Target Selection

Use:

- `electron` for trusted desktop client UI.
- `react-native` for mobile client UI delivered to the native host.
- `terminal` for trusted CLI/client processes.

Do not use apps for ordinary user panels. Apps carry stronger trust and approval
implications than panels.

Host target selection is intentionally local operational state, not workspace
configuration. A workspace may contain multiple apps for the same target under
`apps/*`; the user chooses which app the current host should run through the
workspace/host target picker. The selection is stored under the workspace state
directory and can differ per workspace and per client install. Do not write
these bindings into `meta/natstack.yml`.

Selection modes:

- `follow-ref`: the host follows the app's current approved build.
- `pinned-build`: the host stays on a retained build key until the user selects
  `Follow latest` or picks another build.
- `pinned-commit`: the host asks the git-backed build system to materialize a
  specific commit/ref, then pins the resulting build key.

Pinned selections are recovery tools as well as dev tools. If a newer push is
approved while a target is pinned, the server records the newer build in
rollback history and restores the pinned build as the active host target. The
user can return to normal update adoption by switching that target back to
`follow-ref`.

Host-target management RPC is shell-only (`shell`, `shell-remote`, `server`).
Panels, workers, extensions, and ordinary apps should not change which trusted
app a native host executes. They may still receive app lifecycle events and
should honor `selectedForHost` when deciding whether a notification applies to
the current host.

## Lifecycle Status Semantics

All app targets use the same workspace-unit status vocabulary, with
target-specific meaning at the activation edge:

| Status             | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `pending-approval` | A declared app build needs trust approval before it can be activated     |
| `building`         | The server is producing or validating the next build                     |
| `available`        | A trusted build is active and launchable, but no process/view is running |
| `running`          | The selected trusted build is currently hosted by its target runtime     |
| `stopped`          | The app process/view is not currently running                            |
| `error`            | Build, validation, activation, or process supervision failed             |

Target-specific notes:

- Electron shell apps usually report `running` because the host view is loaded.
  Electron updates are prompt-adopted so an already loaded view can continue to
  use the old trusted build until the user selects `Load`.
- React Native apps report the active trusted bundle from the server
  perspective. The native host still owns whether that bundle has been fetched
  and installed on a particular device.
- Terminal apps report `available` after build activation and `running` only
  while the supervised Node process is alive.

`apps:lifecycle` carries the cross-target event stream:

- `available`: first trusted build became active
- `update-available`: a newer trusted build replaced the active build, or is
  ready for prompt adoption
- `update-error`: the attempted update failed and the previous build remains
  the effective version
- `rolled-back`: the active build was switched to a retained previous build

Clients should use `target`, `source`, `appId`, `buildKey`, `canRollback`, and
`selectedForHost` from lifecycle payloads to decide whether a prompt applies to
the current host.

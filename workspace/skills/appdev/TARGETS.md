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
- `autostart: true` starts the process after activation. `autostart: false`
  keeps the build available until `workspace.units.restart(appName)` starts it.
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

# Trusted Workspace Units And Client Auth

NatStack treats trusted workspace units as declared, approved source units with
stable package identity. Trust is not derived from a special filesystem segment:

- `@workspace-apps/foo` lives at `workspace/apps/foo`
- `@workspace-extensions/bar` lives at `workspace/extensions/bar`

The package name is the code identity. The flat source path is the repo layout.

For authoring guidance, see `workspace/skills/appdev/SKILL.md`.

## Unit Kinds

- Panels are user-facing workspace surfaces.
- Workers and Durable Objects are userland runtime code.
- Extensions are trusted Node service units.
- Apps are trusted client units with an explicit target:
  - `electron` runs as a hosted shell view.
  - `react-native` is delivered to the native mobile host through a signed build
    provider bootstrap.
  - `terminal` currently produces a Node ESM artifact. It is intentionally
    `artifact-only` until terminal app launch orchestration is made first-class.

## App Update Adoption

Trusted app activation is server-side; client adoption is target-specific.

- Electron clients keep an already-loaded app view on the current build when a
  new trusted build arrives. The shell surfaces `Load update` and `Roll back`
  actions through notifications and the App updates settings section.
- React Native clients use a native prompt. `Install` prepares and activates the
  current trusted bundle; `Roll back` switches the server to a retained previous
  build before activating it.
- Terminal clients are artifact-only today. Updates are announced as new trusted
  artifacts rather than host-supervised process replacements.

The protocol surface is `apps:available`, `apps:status`, `apps:lifecycle`,
`workspace.units.versions`, and `workspace.units.rollback`. Rollback history is
retained per app with a bounded retention limit and old artifacts remain
servable while they are retained.

## Device And Principal Model

Remote clients use two layers of identity:

- A `DeviceCredential` is long-lived and native/client-held. It contains a
  device id and refresh token.
- A `PrincipalGrant` is short-lived and scoped to one concrete runtime
  principal, such as a React Native app principal.
- A `PairingInvite` is one-time bootstrap material used to create a new device
  credential.
- `ConnectionInfo` describes the server URL clients should use for HTTP/RPC and
  pairing deep links.

Desktop remote shells refresh a `shell-remote` token from their device
credential. Mobile native hosts refresh a principal grant with
`/_r/s/auth/refresh-principal-grant` and `principal: "react-native-app"`.

## Capability Checks

Capabilities are declared in the app manifest and checked at the service
boundary. `connection-management` is required for app callers that mint pairing
invites through `auth.createPairingInvite`.

Shell, shell-remote, and server callers are trusted host principals for this
operation. App callers must be active and running with the requested capability.
Capability denial is returned with code `EACCES`.

## Compatibility Routes

`/_r/s/auth/refresh-app-grant` remains available as a compatibility alias for
older mobile clients. New clients must use `/_r/s/auth/refresh-principal-grant`.
The alias returns deprecation headers so logs and tests can detect stale clients.

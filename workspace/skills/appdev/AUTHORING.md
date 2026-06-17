# App Authoring

Trusted workspace apps live under `apps/` and use flat source paths:

| Package name                 | Source path       |
| ---------------------------- | ----------------- |
| `@workspace-apps/shell`      | `apps/shell`      |
| `@workspace-apps/mobile`     | `apps/mobile`     |
| `@workspace-apps/remote-cli` | `apps/remote-cli` |
| `@workspace-apps/foo`        | `apps/foo`        |

Do not add a package scope segment to the filesystem path. The path
`apps/@workspace-apps/foo` is wrong.

## Package Manifest

Each app is a normal package with a `natstack.app` manifest in `package.json`:

```json
{
  "name": "@workspace-apps/foo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "natstack": {
    "displayName": "Foo",
    "app": {
      "target": "electron",
      "renderer": "index.tsx",
      "capabilities": ["notifications"]
    }
  }
}
```

Fields:

- `name`: stable app principal identity. Must use `@workspace-apps/<name>`.
- `natstack.displayName`: user-facing name in approval and unit surfaces.
- `natstack.app.target`: one of `electron`, `react-native`, or `terminal`.
- Target entry:
  - `electron`: `renderer`
  - `react-native`: `renderer`, plus mobile metadata such as
    `rnComponentName` and `rnHostAbi`
  - `terminal`: `entry`
- `natstack.app.capabilities`: explicit host/service privileges.

## Workspace Declaration

Apps are trusted workspace units and should be declared in `meta/natstack.yml`
when they are part of the workspace runtime:

```yaml
apps:
  - source: apps/shell
    ref: main
```

Declaration fields:

- `source`: repo path such as `apps/shell`, or the app package name when
  supported by the resolver.
- `ref`: git ref to build. Defaults to `main` when omitted.

Changing declared apps, source, ref, dependency EVs, external dependencies,
capabilities, provider identity, or active build identity can re-gate approval.

## Build Identity

App builds are content-addressed and approved as trusted units. The build
identity includes:

- unit kind and package name
- source repo and ref
- effective version of the app
- transitive dependency effective versions
- external dependency versions
- app capabilities
- target/provider metadata where applicable

This means adding a capability, changing a dependency, changing the React Native
provider, or committing app source can require a new approval before the app is
active.

## Runtime Update Protocol

Apps should subscribe to `apps:lifecycle` when they need to show update state in
their own UI. Relevant event types are:

- `update-available`: a new trusted build is active on the server and can be
  loaded by clients. Payload includes app id, source, target, build key,
  effective version, previous build metadata, `canRollback`, and an
  `adoptionPolicy`.
- `update-error`: a committed build failed to build or validate. The previous
  active build remains selected. Payload includes the error and rollback
  availability.
- `rolled-back`: the server switched the app back to a previous trusted build.

Adoption policies are target-aware. `prompt` means the client should keep its
currently loaded build and ask the user when to adopt the new one. `immediate`
is used for first load, user-requested rollback, and terminal process
replacement. Terminal apps are supervised by the server runner once started.

For explicit version controls, call `workspace.units.versions(appName)` to list
current/previous app builds and `workspace.units.rollback(appName, { buildKey?
})` to restore one. Shell can manage all app units; ordinary app callers can
manage their own app unit.

Host notifications can include typed app commands:

- `{ type: "app.applyUpdate", appId }`
- `{ type: "app.rollback", appId, buildKey? }`
- `{ type: "workspace.restartUnit", name }`

Prefer these structured commands over encoding app ids in action strings.
Desktop shell also exposes a durable App updates section in connection settings
for pending updates, retained rollback versions, and recent app update errors.

## Source And Imports

Use workspace dependencies for shared code:

```json
{
  "dependencies": {
    "@workspace/react": "workspace:*",
    "@natstack/rpc": "workspace:*",
    "@natstack/shared": "workspace:*"
  }
}
```

Guidelines:

- Keep app-only UI in `apps/<name>`.
- Put reusable cross-target logic in `packages/`.
- Keep native host code outside `workspace/apps/mobile`; the workspace mobile
  app should consume native host APIs through its service wrappers.
- Do not import server/main internals from workspace app code.
- Edit app source via the `edit`/`write` tools (or `vcs.applyEdits`): each edit
  commits to your context head and projects to disk atomically, so it is
  build-ready immediately (edit-first — no separate commit step). Do not edit
  via `fs.writeFile` and expect it to update the active build.

## Choosing Apps vs Panels vs Extensions

Use an app when the code is a trusted client runtime:

- the desktop shell UI
- the mobile workspace shell loaded by a native host
- a future terminal client
- a client that owns pairing or principal-grant flows

Use a panel when the code is an ordinary workspace surface shown inside the
shell. Use an extension when the code needs trusted Node/server-side access or
long-lived service behavior. Use a worker/DO when an isolate service is enough.

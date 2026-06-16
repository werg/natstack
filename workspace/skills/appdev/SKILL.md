---
name: appdev
description: Author NatStack trusted workspace apps for Electron, React Native, and terminal targets, including manifests, capabilities, pairing/client auth, build artifacts, approval flow, and development workflow.
---

# App Development Skill

Use this skill when creating or modifying trusted workspace apps under `apps/`.
Apps are trusted client units with explicit target runtimes. They are different
from panels, workers, and extensions:

- Panels are ordinary user-facing workspace surfaces.
- Workers and Durable Objects are userland runtime services.
- Extensions are trusted Node service units.
- Apps are trusted client runtimes that can become shell/mobile/terminal
  principals.

## Files

| Document                               | Content                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| [AUTHORING.md](AUTHORING.md)           | Package layout, manifest shape, source paths, dependencies, and declaration rules |
| [TARGETS.md](TARGETS.md)               | Electron, React Native, and terminal target contracts                             |
| [CAPABILITIES.md](CAPABILITIES.md)     | Capability declarations and what each app capability unlocks                      |
| [DEV_LOOP.md](DEV_LOOP.md)             | Edit, commit, approve, rebuild, reload, and debugging workflow                   |
| [MOBILE.md](MOBILE.md)                 | Native mobile host bootstrap, pairing, principal grants, and RN build artifacts   |
| [REMOTE_CLIENTS.md](REMOTE_CLIENTS.md) | Server pairing, remote shells, terminal-client direction, and credential model    |
| [TESTING.md](TESTING.md)               | Focused checks and smoke scenarios for app changes                                |

## Critical Rules

1. `@workspace-apps/foo` maps to `apps/foo`, not `apps/@workspace-apps/foo`.
2. App identity comes from `package.json` package name plus the approved build
   identity, not from a special filesystem path.
3. App code is trusted client code. Add capabilities deliberately and keep the
   capability list no broader than the target needs.
4. Workspace app builds come from committed VCS states. Editing a file has no
   runtime effect until the app unit is committed with `vcs.commit` or the
   workspace-dev `commitWorkspace` wrapper.
5. Electron shell apps that manage panel layout must declare `panel-hosting`.
6. React Native workspace apps are loaded by the shipped native host bootstrap;
   clean-install pairing must work before the workspace app bundle is available.
7. Terminal apps run as supervised Node processes only after they are selected
   for launch or explicitly restarted through `workspace.units.restart(appName)`.

## Quick Start

Create an app repo under `apps/<name>` with package name
`@workspace-apps/<name>`, then declare the app in `meta/natstack.yml`:

```yaml
apps:
  - source: apps/my-app
    ref: main
```

Minimal Electron app package:

```json
{
  "name": "@workspace-apps/my-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "natstack": {
    "displayName": "My App",
    "app": {
      "target": "electron",
      "renderer": "index.tsx",
      "capabilities": ["notifications"]
    }
  },
  "dependencies": {
    "@natstack/rpc": "workspace:*",
    "@natstack/shared": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```

For shell/mobile/remote-client work, read [TARGETS.md](TARGETS.md),
[CAPABILITIES.md](CAPABILITIES.md), and [REMOTE_CLIENTS.md](REMOTE_CLIENTS.md)
before editing.

## Related Skills

- Use `workspace-dev` for ordinary panels and workers.
- Use `extensiondev` for trusted Node service units.
- Use `system-testing` after app changes that affect startup, pairing, shell
  UX, mobile bootstrap, or client auth.

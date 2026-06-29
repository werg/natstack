# natstack CLI

`natstack` is the unified terminal entrypoint for remote server and mobile setup.

## Development

For ongoing source checkout work, use the live TypeScript entrypoint:

```sh
pnpm install
pnpm cli --help
pnpm cli remote serve --host tailscale --port 3030
pnpm cli mobile install --launch
```

`pnpm cli ...` runs `src/cli/client.ts` through `tsx`, so CLI source changes are
picked up without rebuilding or relinking. It also sets
`NATSTACK_SERVER_ENTRY=live`, so pairing and mobile-dev commands start the
standalone server from `src/server/index.ts`.

```sh
pnpm server:live --help
```

Electron local mode still uses the bundled `dist/server-electron.cjs`; rebuild
after Electron or local-child-server changes.

## Install

For a stable command on your PATH, install from npm:

```sh
npm install -g @natstack/app        # GUI + the `natstack` CLI dispatcher
# headless server box (CLI + daemon, no Electron):
npm install -g @natstack/server
```

`@natstack/app` provides `natstack` (bare invocation launches the GUI; subcommands
run the CLI) and `natstack-server`. `@natstack/server` provides `natstack-server`
plus the `natstack` CLI for pairing/remote management on a headless box. Update
with `@latest`.

From a source checkout, run the built CLI directly without a global install:

```sh
node dist/cli/client.mjs --help     # or: pnpm cli --help
```

## Remote

Start a phone/laptop pairing server:

```sh
natstack remote serve --host tailscale --port 3030
# or, during source development:
pnpm cli remote serve --host tailscale --port 3030
```

Pair this terminal, choose a workspace, start the terminal app, and mint new invites:

```sh
natstack remote pair "natstack://connect?url=...&code=..."
natstack remote workspaces
natstack remote select dev
natstack terminal start --pair "natstack://connect?url=...&code=..."
natstack terminal start
natstack remote invite
natstack remote status
natstack remote logout
```

Pairing saves a durable device credential. After pairing, desktop, mobile, and
terminal hosts all choose a workspace, ask the server to launch their selected
host target, and show the same privileged workspace-unit approval before
running workspace code.

Desktop pairing and workspace selection happen in the desktop bootstrap UI.
`terminal start` runs fully in the CLI; use `--yes` only for automation that
should approve each startup request once.

Credentials are stored in `~/.config/natstack/cli-credentials.json` with file
mode `0600`. The CLI does not use a system keyring.

## Mobile

Build/install the trusted internal Android APK:

```sh
natstack mobile build
natstack mobile install --launch
# or:
pnpm cli mobile install --launch
```

Start the phone pairing server over Tailscale:

```sh
sudo tailscale serve --bg 3030
natstack mobile pair --host tailscale --port 3030
```

Run the local Android dev loop:

```sh
natstack mobile dev
natstack mobile logs
```

Run a clean installed-app pairing smoke against an emulator or attached device:

```sh
natstack mobile smoke
natstack mobile smoke --avd Pixel_8
```

Useful flags:

- `--device <adb-serial>` targets a specific Android device.
- `--host tailscale|lan|<host>` chooses the phone-reachable route.
- `--dev` on `natstack mobile pair` offers a disposable template workspace named
  `dev` after pairing.

See [remote-server.md](./remote-server.md) for deployment details and
[mobile-vpn.md](./mobile-vpn.md) for Tailscale/mobile notes.

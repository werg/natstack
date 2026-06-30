# natstack CLI

`natstack` is the unified terminal entrypoint for remote server and mobile setup.

## Development

For ongoing source checkout work, use the live TypeScript entrypoint:

```sh
pnpm install
pnpm cli --help
pnpm cli remote serve --port 3030
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

For a stable command on your PATH, build and link the package bin:

```sh
pnpm build
pnpm link --global
```

That installs `natstack` and `natstack-server` from `package.json`. The global
link continues to point at this checkout, but it runs built files from `dist/`;
re-run `pnpm build` after source changes.

If you do not want a global link, use the built file directly:

```sh
node dist/cli/client.mjs --help
```

## Remote

Start a phone/laptop pairing server:

```sh
natstack remote serve --port 3030
# or, during source development:
pnpm cli remote serve --port 3030
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

Start the phone pairing server (pairing is over WebRTC — no Tailscale/HTTPS setup):

```sh
natstack mobile pair --port 3030
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
- `--port <port>` chooses the local pairing server port.
- `--dev` on `natstack mobile pair` offers a disposable template workspace named
  `dev` after pairing.

Remote reach is WebRTC (pair by QR - signaling room + DTLS fingerprint); see
[webrtc-rpc-transport.md](./webrtc-rpc-transport.md) and [webrtc-local-e2e.md](./webrtc-local-e2e.md).

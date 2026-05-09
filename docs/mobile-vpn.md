# Android Phone over VPN

This is the trusted, low-friction workflow for running the NatStack Android app
on a real phone while the server runs on a machine reachable over your VPN.

The workflow uses:

- an **internal Android build** (`com.natstack.mobile.internal`) that allows
  cleartext HTTP to VPN/LAN hosts;
- a **stable gateway port** so the phone can keep using the same server URL;
- a **QR/deep-link pairing command** that saves the server URL and token in the
  app.

## 1. Build and install the phone app

Connect the phone over USB with Android debugging enabled, then run:

```bash
pnpm mobile:install:internal --launch
```

To target a specific adb device:

```bash
pnpm mobile:install:internal --device <adb-serial> --launch
```

To only produce the APK:

```bash
pnpm mobile:apk:internal
```

The APK is written to:

```text
apps/mobile/android/app/build/outputs/apk/internal/app-internal.apk
```

If install fails with `adb does not see any Android device or emulator`, check:

- the phone is connected by USB;
- Developer options are enabled;
- USB debugging is enabled;
- the phone is unlocked;
- the USB debugging authorization prompt on the phone has been accepted.

Confirm from the server machine:

```bash
adb devices -l
```

If more than one device is listed, pass the target serial:

```bash
pnpm mobile:install:internal --device <adb-serial> --launch
```

## 2. Start the server for phone pairing

Make sure the server machine and phone are both connected to the VPN, then run:

```bash
pnpm build
pnpm mobile:pair
```

`mobile:pair` starts `dist/server.mjs` with:

- `--serve-panels`
- `--init`
- `--print-token`
- `--gateway-port 3030`
- a VPN/Tailscale host when one is detected, otherwise a LAN host

The command prints a `natstack://connect?...` deep link and QR code. Scan it
with the Android camera and accept the app's connection prompt.

For UI and panel development, prefer the disposable dev variant:

```bash
pnpm build
pnpm mobile:pair:dev
```

This starts the same phone-reachable gateway, but passes `--ephemeral` to the
server. The server creates a fresh `dev-<random>` workspace from the checked-in
`workspace/` template and deletes it on shutdown, matching the desktop
`pnpm dev` workflow. Use this when you need template or panel CSS changes to be
visible immediately instead of reusing an older persisted mobile workspace.

For panel/WebView diagnostics while using the trusted HTTP workflow, launch the
app and tail its logs:

```bash
pnpm mobile:logs:internal
```

Use `--device <adb-serial>` if more than one Android target is connected.

## Host selection

By default, `mobile:pair` prefers a Tailscale/VPN interface and falls back to a
LAN address. You can be explicit:

```bash
pnpm mobile:pair --host tailscale
pnpm mobile:pair --host lan
pnpm mobile:pair --host 100.x.y.z
pnpm mobile:pair --host pop-os
pnpm mobile:pair --host server.tailnet.ts.net
```

Use a different stable port when needed:

```bash
pnpm mobile:pair --host 100.x.y.z --port 3031
```

Environment equivalents:

```bash
NATSTACK_MOBILE_HOST=100.x.y.z NATSTACK_MOBILE_PORT=3030 pnpm mobile:pair
```

## Workspace selection

Use the normal server workspace flags:

```bash
pnpm mobile:pair --workspace my-workspace
pnpm mobile:pair --workspace-dir /path/to/workspace
```

`--init` is on by default so a missing workspace is created from the template.
Pass `--no-init` to require the workspace to already exist.

For development, use `pnpm mobile:pair:dev` or `pnpm mobile:pair --dev` instead
of a named workspace. Dev mode intentionally cannot be combined with
`--workspace` or `--workspace-dir`, because its purpose is to always start from a
fresh template copy.

## Reconnecting later

The app saves the paired server URL and token in the device credential store.
If the server comes back on the same host and gateway port, the phone can
reconnect without scanning a new QR code.

For a long-running trusted server, the equivalent direct server command is:

```bash
node dist/server.mjs \
  --host 100.x.y.z \
  --gateway-port 3030 \
  --serve-panels \
  --init \
  --print-token
```

Set `NATSTACK_ADMIN_TOKEN` if you want to pin the token yourself. Otherwise the
server persists the generated token under NatStack's central config and reuses
it on later starts.

## Notes

- The internal APK is separate from the release app and shows as
  **NatStack Internal**.
- The internal APK allows HTTP to arbitrary hosts. Use it only on trusted
  networks/VPNs.
- QR pairing accepts HTTP for loopback, private LAN IPs, Tailscale IPs /
  `*.ts.net`, single-label local names such as `pop-os`, and `.local` names.
- Release builds keep the stricter network policy in
  `apps/mobile/android/app/src/main/res/xml/network_security_config.xml`.

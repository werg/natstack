# Android Phone over VPN

This is the trusted, low-friction workflow for running the NatStack Android app
on a real phone while the server runs on a machine reachable over your VPN.

The workflow uses:

- an **internal Android build** (`com.natstack.mobile.internal`) that allows
  cleartext HTTP to VPN/LAN hosts;
- a **stable gateway port** so the phone can keep using the same server URL;
- a **QR/deep-link pairing command** that saves the server URL and token in the
  app;
- **automatic Tailscale serve setup** so the phone connects over HTTPS via
  MagicDNS and OAuth callbacks land on the same URL — no per-machine setup
  beyond a one-time `tailscale set --operator=$USER`.

## Auto-detected Tailscale path (recommended)

If Tailscale is running on the server machine, `pnpm mobile:pair` will detect
the MagicDNS hostname (e.g. `pop-os.tailnet-xyz.ts.net`), provision
`tailscale serve` to forward HTTPS → the local gateway, verify the URL is
actually reachable, and use it as the QR target. The phone connects via
`https://<host>.<tailnet>.ts.net`, panel chrome and OAuth callbacks share the
same URL, and registering OAuth providers becomes a one-time copy-paste of
`https://<host>.<tailnet>.ts.net/_r/s/credentials/oauth/callback`.

First-time requirements:

- **Tailscale Serve enabled on your tailnet.** Serve is a per-tailnet feature
  that has to be turned on once from the admin console. If it isn't, mobile
  OAuth silently falls back to a `localhost` redirect that the phone can't
  reach — see [If the readiness banner says ACTION NEEDED](#if-the-readiness-banner-says-action-needed)
  below.
- HTTPS Certificates feature enabled in your tailnet admin console
  (https://login.tailscale.com/admin/dns). Provisioned `tailscale serve`
  uses Let's Encrypt certs minted via this feature.
- Either run the natstack server as the Tailscale operator
  (`sudo tailscale set --operator=$USER` once, then logout/login or restart),
  or run `sudo tailscale serve --bg <gateway-port>` once manually. Without one
  of these, the auto-provision step prints `permission-denied` and falls back
  to the IP+HTTP gateway URL.

The readiness banner reports what's happening:

```
natstack-server ready:
  …
  Gateway:     http://100.x.y.z:3030                              # IP+HTTP fallback
  Public URL:  https://host.tailnet.ts.net (auto-detected tailscale) (verified reachable)
  Mobile URL:  https://host.tailnet.ts.net                         # what the QR encodes
  OAuth callback (register with each provider):
    https://host.tailnet.ts.net/_r/s/credentials/oauth/callback
  Tailscale: configured `tailscale serve` to forward https://host.tailnet.ts.net/ → 127.0.0.1:3030.
             Persistent across reboots; remove with `tailscale serve reset`.
```

To skip auto-detection (you manage `tailscale serve` yourself, or use a
reverse proxy / Cloudflare Tunnel), pass `--no-vpn-detect` or set
`NATSTACK_NO_VPN_DETECT=1`. Setting `--public-url` also implicitly skips
detection.

### If the readiness banner says ACTION NEEDED

When Tailscale Serve isn't enabled on the tailnet, `pnpm mobile:pair` prints a
bordered block during startup and again right after the QR banner:

```
========================================================================
  ACTION NEEDED — Tailscale Serve is not enabled
========================================================================
  Mobile OAuth needs a public HTTPS URL. Without Tailscale Serve,
  redirects fall back to localhost and won't work on your phone.

  Enable Tailscale Serve (one click):
    https://login.tailscale.com/f/serve?node=<your-node-id>

  Then restart `pnpm mobile:pair`.
========================================================================
```

The activation URL is per-tailnet and is extracted from the daemon's own
"Serve is not enabled" message — open it in a browser, click **Enable**, then
restart `pnpm mobile:pair`. The next run will:

1. provision `tailscale serve --bg <port>` automatically,
2. verify `https://<host>.<tailnet>.ts.net/healthz` returns `{ ok: true }`,
3. mark the public URL as **verified reachable**,
4. switch OAuth redirects to `https://<host>.<tailnet>.ts.net/_r/s/credentials/oauth/callback`
   so logins from the phone complete.

**For agents driving this setup:** treat the `ACTION NEEDED` block as a hard
stop on the OAuth path. Pairing and the chat agent still work over the IP+HTTP
gateway, but any OAuth flow the user starts from mobile will redirect to
`http://localhost:<port>/...` and hang. Surface the activation URL to the
operator before encouraging them to try mobile OAuth.

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
  When the auto-detected `Mobile URL:` is HTTPS, the QR uses that and the
  HTTP rules don't matter.
- Release builds keep the stricter network policy in
  `apps/mobile/android/app/src/main/res/xml/network_security_config.xml`.
- The auto-detected URL is also used by OAuth flows on mobile, panel chrome,
  and webhook delivery. When you register OAuth providers, register the
  callback URL printed in the banner (`/_r/s/credentials/oauth/callback`)
  exactly — provider consoles do exact-match validation.

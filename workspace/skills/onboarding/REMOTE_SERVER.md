---
name: remote-server-onboarding
description: Connect a desktop or mobile NatStack client to a state server running elsewhere (home server, VPS, remote workstation).
---

# Connecting to a Remote NatStack Server

NatStack's state server (the piece that owns workspaces, the build system, agents, DOs, and secrets) can run on a different machine from the client UI. Typical setup: the server runs on a home server or VPS, and you connect from a desktop Electron app and/or the mobile app on your phone.

> **Single-user scope.** The current remote-server design assumes one user per server. Every connected client shares the same workspaces, OAuth tokens, and secrets.

## 1. Start the server somewhere reachable

On the host machine:

```
natstack-server --host my-home-server.local --bind-host 0.0.0.0 \
  --protocol https --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

Flags worth knowing:

- `--host` — the external hostname clients will connect to.
- `--bind-host 0.0.0.0` — listen on all interfaces (LAN access). Default is loopback.
- `--protocol https` + `--tls-cert` / `--tls-key` — strongly recommended for anything outside localhost. Self-signed certs are fine for home use; see §3.
- `--print-token` — prints a machine-parseable `NATSTACK_ADMIN_TOKEN=...` line after startup, useful for scripting.

On first boot the server generates an admin token (if `NATSTACK_ADMIN_TOKEN` isn't set) and persists it at `~/.config/natstack/admin-token` (`0o600`). That token is stable across restarts. Copy it — you'll enter it into clients next.

The server prints its URL and `/healthz` is available for liveness checks (e.g., `curl https://my-home-server.local:3000/healthz`).

## 2. Point a client at it

### Desktop (Electron)

Two paths:

**(a) Bootstrap via env vars, then save via the UI.** Launch once with:

```
NATSTACK_REMOTE_URL=https://my-home-server.local:3000 \
NATSTACK_REMOTE_TOKEN=<paste-the-admin-token> \
natstack
```

Once connected, open the connection badge in the title bar → **Remote server** dialog → enter the same details → **Save & relaunch**. The app encrypts the token via OS keychain (Keychain / DPAPI / libsecret) from then on; you won't need the env vars again.

**(b) Go straight to the settings dialog.** Launch `natstack` normally in local mode, click the connection badge, fill in URL + token, save, relaunch.

**Buttons in the settings dialog:**

- **Test** — runs a `/healthz` probe and a throwaway auth attempt against the URL + token you entered. Surfaces invalid URL, unreachable server, TLS mismatch, or auth failure inline — no relaunch needed to discover a bad config.
- **Fetch from server** (next to the fingerprint field) — pulls the server's leaf-cert SHA-256 from the TLS handshake so you don't have to run `openssl` by hand. Paired with the trust-on-first-use prompt: if you hit **Save & relaunch** against an `https://` URL without a stored fingerprint, the dialog shows the observed fingerprint and asks you to confirm before saving.
- **Rotate token** — only enabled while connected. Mints a fresh admin token on the server, updates the local credential store, and relaunches with the new token. Old clients with the old token will fail to reconnect until updated.
- **Disconnect…** — destructive; wipes the credential store and relaunches into local mode. Requires a second click to confirm.

### Mobile

Open the app → connection screen → enter URL and the same admin token (or a paired token; see §4). Token is stored via `react-native-keychain`.

## 3. Self-signed HTTPS

If the server uses a self-signed cert, the client needs one of:

- **CA path** — the client loads the server's cert as a trusted CA. Put the PEM somewhere on the client machine and pass the path in the settings dialog's "CA certificate path" field.
- **Fingerprint pinning** — copy the SHA-256 fingerprint (uppercase, colon-separated hex) from the server cert:
  ```
  openssl x509 -in cert.pem -noout -fingerprint -sha256
  ```
  Paste it into the dialog's "TLS fingerprint" field. The client bypasses normal CA validation and accepts the connection iff the leaf cert matches this hash.

Environment variable alternatives: `NATSTACK_REMOTE_CA`, `NATSTACK_REMOTE_FINGERPRINT`.

## 4. OAuth from a remote client

When you trigger an OAuth flow (e.g. connecting an AI provider) from a remotely-connected client, the server dispatches an `open-external-requested` event to the initiating client with the auth URL. **The client that started the flow** opens that URL in its local browser — desktop uses `shell.openExternal`, mobile uses `Linking.openURL`. The server itself no longer needs a browser.

The OAuth callback redirects back to the server. For this to work your server's URL must be reachable from the internet (or you need a tunnel like Cloudflare Tunnel / Tailscale funnel). Set `--public-url` so the server builds the correct `redirect_uri`. See `docs/remote-server.md` for concrete proxy recipes.

## 5. Verifying the connection

From the client CLI or a terminal:

```
curl https://my-home-server.local:3000/healthz
# → {"ok":true,"protocol":"https"}
```

In the Electron app, the connection badge in the title bar indicates:

- **Hidden** — local mode, everything healthy.
- **Green globe with hostname** — connected to a remote server.
- **Amber "reconnecting"** — client lost the WS and is retrying.
- **Red "disconnected"** — all retries exhausted.

Clicking the badge opens the settings dialog.

## 6. What lives where

| On the server (host machine) | On the client |
|---|---|
| Workspaces (`~/.config/natstack/workspaces/`) | Encrypted remote credentials (`~/.config/natstack/remote-credentials.json`) |
| OAuth tokens (`oauth-tokens.json`) | Theme / local UI preferences |
| API keys (`.secrets.yml`) | Electron userData cache for remote mode (`~/.config/natstack/remote-state/`) |
| Durable Object state (`.databases/workerd-do/`) | |
| Agent/worker execution | |

Back up the server side; the client is disposable.

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `TLS fingerprint mismatch` on connect | Fingerprint in client settings no longer matches the cert — either the cert was regenerated or someone is MitM-ing. Re-copy the fingerprint from the server and save. |
| OAuth dialog never opens a browser | Check the badge: is the desktop/mobile client actually connected? The event only fires to subscribers. If the server has no connected clients, the OAuth URL is logged to the server's stdout instead. |
| "self-signed certificate" error | Pass a CA path or a fingerprint — see §3. |
| Admin token doesn't work | Did the server regenerate? `cat ~/.config/natstack/admin-token` on the host and compare. |

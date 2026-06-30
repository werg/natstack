---
name: remote-server-onboarding
description: Connect a desktop, mobile, or CLI NatStack client to a state server running elsewhere (home server, VPS, remote workstation) over WebRTC.
---

# Connecting to a Remote NatStack Server

NatStack's state server (the piece that owns workspaces, the build system, agents, DOs, and secrets) can run on a different machine from the client UI. Typical setup: the server runs on a home server or VPS, and you connect from a desktop Electron app, the mobile app, or the CLI.

Remote reach is **WebRTC**: the client and server establish one peer-to-peer, DTLS-encrypted pipe and pair by QR. There is no public HTTPS endpoint, no TLS cert/CA/fingerprint files, no Tailscale, and no reverse proxy — the gateway binds loopback only and remote clients reach it through the encrypted pipe. See `docs/webrtc-rpc-transport.md` for the design and `docs/webrtc-local-e2e.md` for a runnable local harness.

> **Single-user scope.** The current design assumes one user per server. Every connected client shares the same workspaces, OAuth tokens, and secrets.

## 1. Start the server as a WebRTC answerer

The server needs a **signaling room** (a tiny Cloudflare Worker/DO that brokers the WebRTC offer/answer — it never sees your data) and a pairing code. Point it at signaling and it prints a pairing link:

```
NATSTACK_WEBRTC_SIGNAL_URL=wss://signaling.example.workers.dev \
NATSTACK_WEBRTC_ROOM=$(uuidgen) \
NATSTACK_PAIRING_CODE=$(openssl rand -base64 18 | tr -d '=+/' | head -c 24) \
  natstack-server --serve-panels --print-credentials
# → [webrtc-answerer] pairing link: natstack://connect?room=…&fp=…&code=…&sig=…
```

- The server presents a **persistent DTLS cert** (default `<appRoot>/.natstack/webrtc/server.{pem,key}`, overridable with `NATSTACK_WEBRTC_CERT`/`NATSTACK_WEBRTC_KEY`). Its SHA-256 is the `fp` in the link — the client pins it (**fail-closed** on mismatch), so a malicious signaling server cannot MitM.
- `NATSTACK_WEBRTC_ICE=relay` forces TURN (set the signaling worker's `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` secrets); host candidates suffice for LAN/loopback.
- For local development, run signaling on Cloudflare's local runtime (`cd apps/signaling && wrangler dev --local`) — see `docs/webrtc-local-e2e.md`.

### Dogfood mode from a source checkout

When the remote server is meant to edit NatStack itself, start it with `pnpm dev:self:server`. This layers a source-checkout workflow on top of pairing: a managed workspace with `projects/natstack`, userland pushes routed through the NatStack Git gateway and mirrored back into the host checkout when clean and fast-forwardable, then rebuild/restart on the same gateway port. Userland detects the mode via `meta/dogfood.json`.

## 2. Pair a client

The pairing link / QR carries everything the client needs (`room`, `fp`, `code`, `sig`); scanning or opening it establishes the WebRTC pipe and mints a **durable device credential** — no admin token leaves the server.

- **CLI** — `parseConnectLink(link)` → `WebRtcRpcClient` (`src/cli/webrtcClient.ts`), same `call`/`callTarget`/`stream` surface as the HTTP client. `node-datachannel` loads lazily, so plain HTTP CLI usage never touches the native module.
- **Desktop (Electron)** — open the `natstack://connect?…` link (or scan the QR); the shell pairs over WebRTC and stores the device credential in the OS keychain. Once one client is connected, mint a fresh link for another device with `natstack remote invite`.
- **Mobile** — scan the QR or follow a `natstack://connect?…` link from `natstack mobile pair` / **Pair another device**; the native host stores the credential via `react-native-keychain`.

The QR `code` is the one-time pairing secret; the `fp` is the pinned DTLS fingerprint.

## 3. OAuth from a remote client

When you trigger an OAuth flow from a remotely-connected client, the flow opens through `externalOpen.openExternal` and **the client that started it** opens the URL in its local browser (desktop `shell.openExternal`, mobile `Linking.openURL`). Provider redirect URIs that need a public HTTPS endpoint resolve through the **callback relay** (`NATSTACK_RELAY_OAUTH_BASE_URL`, plan §7), which backhauls the callback to your loopback server over the pipe — no public server URL or tunnel required.

## 4. Verifying the connection

The Electron connection badge in the title bar indicates:

- **Hidden** — local (co-located) mode, everything healthy.
- **Green globe with hostname** — connected to a remote server over WebRTC.
- **Amber "reconnecting"** — the pipe dropped and the client is re-establishing (full ICE re-establish, not a socket retry).
- **Red "disconnected"** — recovery exhausted.

Clicking the badge opens the connection dialog.

## 5. What lives where

| On the server (host machine) | On the client |
|---|---|
| Workspaces (`~/.config/natstack/workspaces/`) | Device credential (OS keychain) + pinned pairing (`room`/`fp`/`sig`) |
| Credentials + consent state (`~/.config/natstack/credentials/`, `credentials-consent.sqlite`) | Theme / local UI preferences |
| Persistent WebRTC cert (`<appRoot>/.natstack/webrtc/`) | Electron userData cache for remote mode |
| Durable Object state (`.databases/workerd-do/`) | |
| Agent/worker execution | |

Back up the server side; the client is disposable.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Pairing link never appears | The server couldn't reach signaling, or `node-datachannel` isn't built — run `pnpm rebuild node-datachannel` once on the server. |
| `fingerprint mismatch` on connect | The `fp` in the client's saved pairing no longer matches the server cert — the cert was regenerated (or someone is MitM-ing signaling). Re-pair from a fresh link. |
| Client connects then drops repeatedly | Symmetric NAT with no TURN — set `NATSTACK_WEBRTC_ICE=relay` on the server and TURN secrets on the signaling worker. |
| OAuth dialog never opens a browser | Check the badge: is the client actually connected? The event only fires to subscribers. |

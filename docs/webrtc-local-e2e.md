# WebRTC RPC — local end-to-end test setup

A complete local harness for the WebRTC transport: the **signaling Durable Object
runs on Cloudflare's local runtime** (`wrangler dev`/Miniflare), the server runs
as a **real WebRTC answerer**, and a **CLI-shaped client** dials it over a real
`node-datachannel` DTLS pipe — no public endpoint, no deployment.

## TL;DR — run the automated e2e

```bash
pnpm rebuild node-datachannel   # one-time: build the native N-API binary
pnpm test:webrtc-e2e            # NATSTACK_RUN_WEBRTC_E2E=1 vitest run tests/webrtc-*.e2e.test.ts
```

Two suites run:

- **`tests/webrtc-native.e2e.test.ts`** — two real `node-datachannel` peers over
  in-process signaling: real DTLS connect, the fingerprint pin (accept on match,
  **fail-closed on mismatch**), session handshake, RPC round-trip, bulk stream.
- **`tests/webrtc-system.e2e.test.ts`** — the whole system: it spawns
  `wrangler dev apps/signaling` (the real signaling DO under Miniflare), runs the
  **real `RpcServer` + `attachWebRtcPipe`** as the answerer, and a CLI-style
  offerer that joins the room via `createSignalingClient`, pins the server cert,
  opens a `shell` session (real `handleAuth` over the pipe), and round-trips an
  RPC dispatch. It also exercises the **full pairing flow over the pipe**: a fresh
  device presents a QR `code` as its session token → the real
  `createPairingRedeemer` issues a device credential that rides back on the
  auth-result (`onPaired`) → the one-shot code is rejected on replay → the
  returning device re-authenticates with `refresh:<deviceId>:<refreshToken>`.

Both complete in a few seconds after `wrangler dev` boots (~3 s, Miniflare).

## The pieces

```
 wrangler dev apps/signaling  (SignalingRoom DO, Miniflare, ws://127.0.0.1:8798)
        ▲                                                ▲
  createSignalingClient (offerer)            createSignalingClient (answerer)
        │            real node-datachannel DTLS                 │
  createWebRtcTransport  ⇄═══ DTLS + fingerprint pin ═══⇄  createWebRtcAnswererPipe
   (src/cli/webrtcClient)                                  RpcServer.attachWebRtcPipe
        │  openSession(shell token)                            (real handleAuth)
        └──────────────── real RPC round-trip ─────────────────┘
```

| Piece | Where |
| --- | --- |
| Signaling DO + `wrangler dev` | `apps/signaling/` (Miniflare-local) |
| Signaling client | `@natstack/rpc/transports/webrtcSignalingClient` (`ws` in Node) |
| Native peer adapter | `src/main/webrtc/nodeDatachannelPeer.ts` (lazy-loads `node-datachannel`) |
| Persistent DTLS cert | `src/main/webrtc/cert.ts` (`ensurePersistentCert` → stable QR `fp`) |
| Client transport | `@natstack/rpc/transports/webrtcClient` |
| Server answerer pipe | `@natstack/rpc/transports/webrtcAnswerer` |
| Server attach | `RpcServer.attachWebRtcPipe` + `src/server/webrtcSessionShim.ts` |
| CLI WebRTC client | `src/cli/webrtcClient.ts` (`WebRtcRpcClient`, same API as the HTTP client) |
| Server bootstrap | `src/server/webrtcAnswererBootstrap.ts` (wired env-gated in `index.ts`) |

## Running the REAL server as a WebRTC answerer

The server answerer is **off by default** (loopback co-located mode is unchanged).
Activate it by setting `NATSTACK_WEBRTC_SIGNAL_URL`:

```bash
# 1. local signaling (Cloudflare local runtime)
cd apps/signaling && wrangler dev --port 8787 --local &

# 2. the server, as an answerer
NATSTACK_WEBRTC_SIGNAL_URL=ws://127.0.0.1:8787 \
NATSTACK_WEBRTC_ROOM=$(uuidgen) \
NATSTACK_PAIRING_CODE=$(openssl rand -base64 18 | tr -d '=+/' | head -c 24) \
  pnpm server
# → logs:  [webrtc-answerer] pairing link: natstack://connect?room=…&fp=…&code=…&sig=…
```

Optional env: `NATSTACK_WEBRTC_CERT` / `NATSTACK_WEBRTC_KEY` (cert paths, default
`<appRoot>/.natstack/webrtc/server.{pem,key}`), `NATSTACK_WEBRTC_ICE=relay` (force
TURN). The server presents the persistent cert; its SHA-256 is the published `fp`.

## Running the desktop app through local WebRTC

For interactive desktop development, use the wrapper instead of wiring the three
processes by hand:

```bash
pnpm rebuild node-datachannel   # one-time, if needed
pnpm dev:webrtc
```

The wrapper builds like `pnpm dev`, starts `wrangler dev apps/signaling`, starts a
local workspace server as the WebRTC answerer, then launches Electron with the
fresh `natstack://connect` link. It passes `--skip-remote-pairing` so saved remote
credentials cannot steal the launch, and disables persistence for the fresh dev
pairing so the next normal `pnpm dev` remains local.

## Connecting the CLI over WebRTC

`src/cli/webrtcClient.ts` exposes `WebRtcRpcClient` with the same
`call(method,args)` / `callTarget(targetId,method,args)` / `stream(...)` surface as
the HTTP `RpcClient`, so existing `typedClient(...)` commands work unchanged:

```ts
import { WebRtcRpcClient } from "./webrtcClient.js";
import { parseConnectLink } from "@natstack/shared/connect";

const parsed = parseConnectLink(pairingLink);            // room/fp/sig/code
if (parsed.kind !== "ok") throw new Error(parsed.reason);
const client = new WebRtcRpcClient({
  pairing: parsed,
  callerId: `shell:${deviceId}`,
  getToken: () => shellToken,   // device-credential → shell token (refresh-shell)
});
const health = await client.call("healthz", []);
```

`node-datachannel` is loaded lazily (only on first WebRTC connect), so plain HTTP
CLI usage never touches the native module.

## Notes

- **TURN** is optional for local/loopback (host candidates suffice). For symmetric
  NAT, set `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` secrets on the signaling worker.
- **Pairing bootstrap.** The CLI still obtains its device credential / shell token
  over the loopback gateway in the local test (same machine); a production CLI
  would complete pairing over the pipe. The QR `code` is the pairing secret.
- **Two real adapter bugs were caught only by real-native testing** (not the fake
  fabric): `node-datachannel`'s `remoteFingerprint()` returns `{value, algorithm}`
  (not a string), and the data channels open just *after* ICE `connected` — so
  `connect()` now gates on the channels being `open`, not just ICE state.

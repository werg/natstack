# WebRTC RPC Transport — Design

**Status:** Draft / proposal
**Branch:** `claude/webrtc-rpc-transport-2ek0fw`

## Summary

Today a remote NatStack client (desktop Electron shell or React Native mobile
app) reaches its server over a public, TLS-terminated ingress: an RPC WebSocket
at `/rpc`, plus a panel HTTP origin (`/*`) the webview loads documents from, plus
a handful of HTTP routes for callbacks. Standing up that ingress is the bulk of
the remote-mode complexity — HTTPS-or-loopback origin rules, TLS pinning across
session partitions, public-URL/Tailscale detection, ADB reverse ports.

This proposal collapses that to **one peer-to-peer pipe**:

- All client↔server traffic — RPC calls *and* panel asset bytes — rides a
  **WebRTC data channel**, added as one more `EnvelopeRpcTransport`.
- A **minimal, auth-free signaling service** (Cloudflare Durable Object,
  UUID-addressed rooms) brokers the WebRTC handshake. Security lives in the QR /
  pairing key, not in the signaling box.
- Panels load from a **client-local `natstack://` origin**; the scheme handler
  pulls bytes over the same data channel. No remote HTTP origin.
- A **constrained public relay** handles the one class that can never be P2P:
  inbound OAuth callbacks and webhooks from third parties.

The home server stops needing a public TLS endpoint, a stable hostname, TLS
certs/pinning, or reverse-proxy plumbing for its data plane. It keeps an
outbound connection to two small, dumb public services.

## Motivation

A full inventory of panel/client → server communication (see
`src/server/gateway.ts` routing) splits into four buckets:

1. **Needs a URL/origin** — panel HTML + JS/CSS bundles + assets
   (`src/server/panelHttpServer.ts`), blobstore bytes
   (`/_r/s/blobstore/blob/:digest`), app artifacts (`/_a/`), bootstrap scripts
   (`/__loader.js`, `/__transport.js`). Cannot be an `rpc.call()`, but the
   *bytes* can ride any transport.
2. **Inbound from third parties** — OAuth provider redirects
   (`/_r/s/credentials/oauth/callback`) and webhooks
   (`/_r/s/webhookIngress/:id`). An external IdP or GitHub must hit a public
   HTTPS URL; this can never be RPC or P2P.
3. **Foreign protocols** — CDP (`/cdp/:id`), workerd inspector. Their own
   framing, not panel-facing.
4. **Already RPC or trivial** — `credentials.proxyFetch` via `/rpc/stream`,
   `/healthz`, `/api/panels`.

The control plane (bucket 4 + every service call) is *already* 100% RPC over the
`EnvelopeRpcTransport` abstraction (`packages/rpc/src/types.ts`). The remote-mode
complexity is almost entirely downstream of **bucket 1 loading from a remote HTTP
origin**: the trustworthy-origin rules (`packages/shared/src/connect.ts:189`,
`src/main/startupMode.ts:71`), TLS pinning on every panel session partition
(`src/main/tlsPinning.ts:194`), public-URL/Tailscale juggling
(`src/server/publicUrl.ts`, `src/server/vpnDetect.ts`), and mobile ADB reverse
(`10.0.2.2`).

So the lever is not "swap WS for WebRTC" in isolation. It is **"serve panels from
a local origin and backhaul everything over one pipe."** WebRTC is the chosen
pipe because it is NAT-traversing and DTLS-secured, which additionally deletes
the public-TLS-endpoint and pinning ceremony.

## Goals

- One client↔server transport carrying RPC + asset bytes.
- Home server needs no inbound public TLS endpoint, no stable DNS, no TLS certs.
- Reuse the existing transport composition, streaming codec, device-credential,
  and fingerprint-pinning machinery rather than reinventing it.
- Graceful fallback to the existing WebSocket transport where WebRTC can't
  connect.

## Non-goals

- Removing the public footprint entirely. Two minimal public services remain:
  signaling and the callback relay. The point is to make them *dumb and
  stateless-per-request*, not to delete them.
- Replacing app-level authorization. DTLS authenticates the *pipe*; device
  credentials and connection grants still authorize *principals*.
- Reworking CDP / inspector. They stay as-is (dev-only, not on the remote hot
  path).

## Architecture

```
                 ┌─────────────────────────┐
                 │  Cloudflare (minimal)    │
   QR / key      │  • Signaling DO (rooms)  │
  ┌─────────────▶│  • Callback relay (DO)   │◀── OAuth redirect / webhook POST
  │              └───────────┬──────────────┘        (the public island)
  │                          │ SDP/ICE exchange
  │                          │ + callback backhaul
  │     WebRTC DataChannel   │
  ▼   (RPC + asset bytes)    ▼
┌──────────────┐  DTLS/SCTP  ┌──────────────┐
│   Client     │◀═══════════▶│  Home server │
│ shell/mobile │             │  (behind NAT)│
│              │             │              │
│ natstack://  │             │  PanelHttp + │
│ scheme ─────────bytes──────▶  services +  │
│ webview      │             │  workerd     │
└──────────────┘             └──────────────┘
        ▲
        │ loads panel documents from a LOCAL origin,
        │ never from the remote server
```

### 1. WebRTC `EnvelopeRpcTransport`

A new transport implementing the existing interface
(`packages/rpc/src/types.ts:285`):

```ts
interface EnvelopeRpcTransport {
  send(envelope: RpcEnvelope): Promise<void>;
  onMessage(handler: (envelope: RpcEnvelope) => void): () => void;
  status?(): RpcConnectionStatus;
  ready?(): Promise<void>;
  onStatusChange?(handler): () => void;
  stream?(envelope, signal): Promise<Response>;
}
```

- Envelopes are JSON, framed onto a **reliable, ordered** data channel (SCTP) to
  match WebSocket delivery semantics.
- `stream()` reuses the existing frame codec (`protocol/streamCodec.ts`) — the
  same HEAD/DATA/END/ERROR framing `credentials.proxyFetch` already uses — so
  streaming proxyFetch works unchanged over the channel.
- Composed behind the current WS path via `composeTransports`
  (`packages/rpc/src/transports/compose.ts`): prefer the data channel, fall back
  to `wsClientTransport` when ICE fails.

Stacks: `node-datachannel` or `werift` in Electron main; `react-native-webrtc`
on mobile; native `RTCPeerConnection` in the renderer if a panel ever needs a
direct channel.

#### DataChannel mechanics (design up front, not later)

- **Chunking.** SCTP messages cap around ~256 KB in practice. The stream codec
  already chunks + base64-encodes DATA frames, so it is compatible; size asset
  chunks under the cap and honor `bufferedAmountLowThreshold` for backpressure on
  large transfers (wasm, images, fonts).
- **Multiple channels.** A single reliable-ordered channel serializes
  *everything*, so a large asset pull head-of-line-blocks RPC calls. Open at
  least a **control channel** (RPC calls/events) and a **bulk channel** (asset
  bytes, blob downloads), and consider per-stream channels for proxyFetch.
- **Reconnect / ICE restart.** The WS transport has real maturity here —
  exponential backoff with jitter, socket generations, auth-token refresh, and a
  `recoveryCoordinator` distinguishing cold-recover vs resubscribe
  (`packages/rpc/src/transports/wsClient.ts`,
  `packages/rpc/src/protocol/recoveryCoordinator.ts`). The RTC transport needs
  equivalent reconnection plus an **ICE-restart** path. This is the most
  underestimated chunk of work; budget for it explicitly.

### 2. Signaling — auth-free, capability-addressed

A **Cloudflare Worker + Durable Object** per pairing room, using the WebSocket
Hibernation API. A room is addressed by an unguessable UUID; the DO relays SDP
offers/answers and ICE candidates between the two peers, then can be discarded.
Rooms get a short TTL, mirroring the existing single-use, 1-hour pairing codes.

This is deliberately dumb: it sees SDP (peer IPs, DTLS fingerprints) and forwards
it. It performs **no authentication** — exactly the "transmission using
keys/UUIDs" model requested.

#### Security model — why dumb signaling is safe

The trap with broker-mediated WebRTC: a signaling server that can rewrite SDP can
**MITM by swapping DTLS fingerprints**. Since the signaling box is untrusted, the
channel's security cannot come from it. Two existing primitives close this:

1. **DTLS fingerprint pinning in the QR.** The pairing QR/key carries the
   server's DTLS certificate fingerprint out-of-band. The client accepts the
   peer iff its fingerprint matches — a malicious or compromised signaling server
   cannot MITM. This is the direct analogue of today's TLS fingerprint pinning
   (`src/main/tlsPinning.ts`, the "Fetch from server" / trust-on-first-use flow
   in the settings dialog).
2. **Device credentials over the established channel.** Once the pipe is up, the
   server authorizes the *principal* via the existing connection-grant /
   device-refresh model (`src/main/serverClient.ts`,
   `workspace/apps/mobile/src/services/mobileTransport.ts`). DTLS authenticates
   the pipe; it does not replace app-level authz.

Updated pairing payload (extends the current `natstack://connect?url=…&code=…`,
parsed in `scripts/cli/lib/connect-utils.mjs` /
`packages/shared/src/connect.ts`):

```
natstack://connect?room=<uuid>&fp=<dtls-sha256>&code=<pairing-secret>
```

Threat notes:
- **Room guessing / flooding** — mitigated by high-entropy UUIDs + short TTL.
- **Privacy** — the signaling DO observes peer IPs (inherent to ICE). Acceptable
  for self-host; document it.
- **No fingerprint pin (TOFU)** — same trust-on-first-use posture as the current
  HTTPS fingerprint flow; surface the observed fingerprint for confirmation
  before pinning.

### 3. ICE / TURN — do not assume pure P2P

STUN traverses most NATs, but **symmetric NATs and restrictive corporate/mobile
firewalls require a TURN relay**, at which point traffic is relayed rather than
truly peer-to-peer. This is the most commonly forgotten requirement.

- Use **Cloudflare's TURN service** (Realtime/Calls TURN) to keep the minimal-CF
  footprint, or self-host `coturn`.
- TURN credentials are short-lived and minted per session (ICE servers handed to
  both peers via signaling).
- **Keep the WS transport as a fallback** (`composeTransports`) for networks
  where even TURN is blocked or where the data channel is degraded. This also
  de-risks rollout: ship WebRTC behind the proven WS path.

### 4. Panel local origin — custom `natstack://` scheme (chosen)

Panels load their document from a **client-local custom scheme** instead of a
remote HTTP origin. The scheme handler resolves panel/asset requests by pulling
bytes over the data channel (bulk channel) from the server's existing
`PanelHttpServer` logic — which becomes a byte source rather than an HTTP server.

**Desktop (Electron).** Register the scheme privileged at startup, before
`app.ready`:

```ts
protocol.registerSchemesAsPrivileged([{
  scheme: "natstack",
  privileges: {
    standard: true,        // real origin → storage, partitions
    secure: true,          // secure context APIs
    supportFetchAPI: true,
    stream: true,          // stream large assets
    corsEnabled: true,
  },
}]);
// then, per session:
session.protocol.handle("natstack", (req) => fetchPanelBytesOverChannel(req));
```

Panel URLs shift from `${protocol}://${externalHost}:${port}/${source}/?contextId=…`
(`packages/shared/src/panelFactory.ts`, mobile
`workspace/apps/mobile/src/services/panelUrls.ts`) to
`natstack://panel/${source}/?contextId=…`. Session partitioning by `contextId`
(`packages/shared/src/contextIdToPartition.ts`) is unaffected — a `standard`
scheme yields real origins, so `persist:panel:${contextId}` isolation still
holds.

**Mobile (React Native WebView).** iOS WKWebView via `WKURLSchemeHandler`;
Android WebView via `shouldInterceptRequest`. The native module reads bytes off
the channel and returns them. The bridge bootstrap
(`workspace/apps/mobile/src/components/PanelWebView.tsx`) and managed-origin
checks (`isManagedHost`) update to recognize the `natstack://` origin.

**Open risk — secure context on custom schemes.** Electron honors `secure: true`
for registered schemes. **WKWebView does not reliably treat custom-scheme origins
as secure contexts**, which would break panels relying on secure-context-only
web APIs (crypto.subtle, etc.). Mitigation / fallback: where a platform won't
grant a custom scheme a secure context, fall back to a **loopback origin**
(`http://127.0.0.1:<port>`, already a trustworthy origin under
`connect.ts:isTrustedCleartextHost`) backed by the same channel byte source. The
abstraction is "local byte source for the webview"; the scheme is the desktop
realization, loopback the mobile fallback if needed. **Validate the WKWebView
secure-context behavior in a spike before committing mobile to the scheme.**

Bootstrap (`/__loader.js`, `/__transport.js`) is delivered the same way — as the
first bytes the scheme handler serves — but note the transport code it bootstraps
now establishes the data channel rather than a WS to a remote origin.

### 5. Callback relay — the unavoidable public island

OAuth callbacks and webhooks (bucket 2) need a public HTTPS URL a third party can
reach. The home server is now behind NAT, so the relay must forward inbound
payloads to it. The relay is *not* a stateless passthrough — it is a
**relay-with-registration**:

- **Routing table** keyed by the values the server already matches on: OAuth
  `state` (`src/server/services/credentialService.ts`) and webhook
  `subscriptionId` (`src/server/services/webhookIngressService.ts`). Each maps to
  a home server.
- **Backhaul** to deliver the payload: the home server holds an outbound channel
  to the relay DO (or registers "deliver `state=X` / `subscription=Y` to me").
  When the IdP/GitHub POSTs, the relay forwards the opaque payload down that
  channel.
- **Constrained.** It forwards opaque callback bodies keyed by UUID/state — no
  auth, no inspection, no business logic. A Cloudflare Worker + DO implements
  this in a few hundred lines.

Public-URL construction (`src/server/publicUrl.ts`,
`buildPublicUrl(PUBLIC_OAUTH_CALLBACK_PATH)`) repoints at the relay's hostname
instead of the server's own. The OAuth `state` / webhook `subscriptionId`
matching logic on the server is unchanged; only the ingress path differs.

## What moves where

| Traffic | Today | After |
| --- | --- | --- |
| Service calls (fs/git/ai/channels/build/tokens) | RPC over WS | RPC over data channel |
| `credentials.proxyFetch` streaming | RPC `/rpc/stream` | RPC stream over data channel |
| Panel HTML + bundles + assets | Remote HTTP origin `/*` | Bytes over channel → `natstack://` (or loopback) |
| Blobstore bytes, app artifacts | HTTP routes | Bytes over channel |
| Bootstrap loader/transport | HTTP `/__*.js` | First bytes from scheme handler |
| **OAuth callbacks, webhooks** | Server's public HTTP routes | **Public relay → backhaul to server** |
| CDP / inspector (dev only) | WS | Unchanged |

Everything except the third-party callbacks rides the single RPC pipe.

## Phased rollout

1. **Transport spike.** Implement the WebRTC `EnvelopeRpcTransport` (control +
   bulk channels, chunking, reconnect/ICE-restart). Wire it behind WS via
   `composeTransports`. Validate against the existing RPC test suites
   (`wsClient.test.ts` analogues).
2. **Signaling DO + pairing.** Cloudflare DO rendezvous; extend the QR/connect
   link with `room` + `fp`; reuse fingerprint pinning. Land TURN config + WS
   fallback.
3. **Local panel origin.** Desktop `natstack://` scheme handler sourcing bytes
   over the channel. **Spike WKWebView secure-context first**; choose scheme vs
   loopback per platform.
4. **Callback relay.** Public DO relay + server-side registration/backhaul;
   repoint `publicUrl` for OAuth/webhooks only.
5. **Decommission remote ingress.** Once the above is proven, the home server no
   longer binds a public TLS endpoint; remote-mode origin/TLS-pinning machinery
   is removed or gated to legacy.

Each phase is independently shippable behind the WS fallback.

## Open questions / risks

- **WKWebView secure context for custom schemes** — gating decision for mobile
  (scheme vs loopback). Spike before phase 3.
- **Reconnect/ICE-restart parity** — most underestimated effort; needs to match
  the WS transport's recovery semantics (cold-recover vs resubscribe).
- **TURN dependency & cost** — pure P2P is not guaranteed; budget for a relay.
- **Backhaul liveness for callbacks** — if the server's outbound channel to the
  relay is down when an OAuth code arrives, the flow fails. Needs buffering/retry
  or a short-lived hold in the relay DO.
- **Multi-tenant signaling/relay** — routing-table isolation by UUID; confirm no
  cross-tenant leakage in the DO design.
- **Observability** — ICE state, channel `bufferedAmount`, relay delivery
  need surfacing equivalent to today's `server-health` badge.

## Touch points (where code lands)

- `packages/rpc/src/transports/webrtcClient.ts` — new transport (mirrors
  `wsClient.ts`).
- `packages/rpc/src/transports/compose.ts` — already supports fallback routing.
- `packages/rpc/src/protocol/streamCodec.ts` — reused for channel streaming.
- `src/main/serverClient.ts` — desktop transport selection + scheme registration.
- `src/main/` (new) — `natstack://` `protocol.handle` byte source.
- `workspace/apps/mobile/src/services/mobileTransport.ts`,
  `components/PanelWebView.tsx`, `services/panelUrls.ts` — mobile transport +
  local origin.
- `packages/shared/src/connect.ts`, `scripts/cli/lib/connect-utils.mjs` —
  extended pairing link (`room`, `fp`).
- `src/server/publicUrl.ts`, `services/credentialService.ts`,
  `services/webhookIngressService.ts` — repoint callbacks at the relay.
- New: `apps/` Cloudflare signaling DO + callback relay DO.

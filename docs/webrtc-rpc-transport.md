# WebRTC RPC Transport — Implementation Plan

**Status:** Committed plan (supersedes the earlier draft/proposal)
**Branch:** `claude/webrtc-rpc-transport-2ek0fw`

## Decision

We replace remote-mode ingress with **one peer-to-peer WebRTC pipe** and a
**client-local loopback panel origin**. This is a single, all-at-once cutover —
no phased rollout, no WebSocket-to-remote fallback, no "ship behind a flag then
switch later." The old remote ingress (public TLS endpoint, TLS pinning,
public-URL/Tailscale juggling) is **deleted in the same change** that lands the
WebRTC path.

**This is a pre-release, self-contained system — no installed base, no data to
migrate — so the plan carries _zero_ backward-compatibility or legacy
accommodation.** Old pairing links, remote-mode config, stored credentials, and
deprecated code paths are **deleted outright**, never shimmed, versioned,
dual-read, or migrated. Where this doc says a mechanism "carries over," it means
**reusing a current, live mechanism** — never preserving a deprecated one.

There is exactly **one remote transport: WebRTC**. Its own NAT backstop is TURN
(including TURN-over-TLS on 443), which reaches every network that permits
outbound HTTPS — so a separate WS fallback buys nothing and is not built. Local
co-located mode (shell and server on the same host) is a different topology, not
a fallback: it stays on loopback WS and never touches WebRTC or signaling.

Two small public services remain, and we are honest about what they are:

- **Signaling** — genuinely dumb: a UUID-addressed rendezvous that blind-relays
  SDP/ICE. Security lives in the QR, not the box.
- **Callback relay** — *two profiles on one backhaul* (§7): a **stateful**
  webhook relay (durable buffering/queue/retry, sees webhook plaintext) and a
  deliberately **dumb, ephemeral** OAuth relay (a public landing + universal-link
  host doing a `state`-keyed handoff, no buffering). Both backhaul to a home
  server with no public endpoint; both are used by every platform.

A backhauled WS-relay + end-to-end-encryption alternative was evaluated and
**not chosen**; it is documented in §10 so the trade is on the record.

### Design rule: fail loud, never mask

Redundancy that *hides* a failure is worse than no redundancy: if a second layer
silently covers for a broken first one, the system looks healthy while carrying
dead infrastructure, and the first layer never gets fixed. The test for any layer
is "**if it silently broke, would we find out?**" If no, it is a
failure-concealment device, not protection. So:

- **One mechanism per job.** Where two mechanisms would do the same work, keep the
  one we can prove correct and delete the other — never stack them as mutual
  backstops. (This is why §4 has a single auth surface — and why checking that
  premise revealed the asset-token machinery guarded a secret that isn't in the
  HTTP plane — and why §7 has one OAuth handoff per platform.)
- **Every surviving fallback announces itself.** A genuinely necessary fallback
  (TURN for symmetric NAT) must emit a signal when it engages — relay-vs-P2P
  candidate type, which recovery path fired — so "fallback engaged" is itself an
  alarm, not a silent save.
- **Auth fails closed.** No valid grant ⇒ the session handshake is refused and no
  RPC flows; we never serve degraded-but-open.
- **Test the negative.** CI asserts the broken/insecure path is actually rejected:
  an un-authed session handshake MUST fail; a connection that silently relayed
  through TURN MUST be flagged. Without the negative test, a primary control rots
  undetected behind its backstop.

## Why this is the right lever (corrected problem statement)

The remote-mode complexity is almost entirely downstream of **bucket 1: panels
loading from a remote HTTP origin**. The control plane is *already* 100% RPC over
the `EnvelopeRpcTransport` abstraction (`packages/rpc/src/types.ts:285`,
verified). So the lever is not "swap WS for WebRTC"; it is **"serve panels from a
local origin and backhaul everything over one pipe,"** with WebRTC chosen because
DTLS gives end-to-end confidentiality *even when relayed through TURN* and STUN
gives a true-P2P fast path with zero per-byte cost on traversable networks.

Traffic inventory (re-verified against `src/server/gateway.ts`; note `/_r/*`
routes — OAuth, webhooks, blobstore — are dispatched through a route registry,
not enumerated in the gateway):

1. **Needs a URL/origin** — panel HTML/JS/CSS/assets, blobstore bytes, app
   artifacts (`/_a/`, gateway.ts:470), bootstrap `/__loader.js` + `/__transport.js`
   (`panelHttpServer.ts:537`). Cannot be `rpc.call()`, but the *bytes* ride any
   transport.
2. **Inbound from third parties** — OAuth redirects, webhooks. An external IdP or
   GitHub must hit a public HTTPS URL; never P2P.
3. **Foreign protocols** — CDP, workerd inspector. Dev-only; out of scope.
4. **Already RPC** — `credentials.proxyFetch` (`/rpc/stream`), `/healthz`,
   `/api/panels`, the `/rpc` WebSocket.

**Corrections to the original draft's framing** (each verified in code):

- The original cited "mobile ADB reverse (`10.0.2.2`)" as remote-mode
  complexity. **It does not exist in the codebase** — mobile always dials the
  configured `serverUrl`. Dropped from the motivation.
- The original leaned on a TLS-pinning "trust-on-first-use" analogy.
  `tlsPinning.ts` actually **enforces a pre-configured fingerprint**
  (`NATSTACK_REMOTE_FINGERPRINT`), not TOFU. The QR-fingerprint model below is a
  *pre-configured pin delivered out-of-band*, which is the stronger posture; TOFU
  is offered only with explicit out-of-band confirmation.
- "Reuse `composeTransports` for fallback" / "reuse the stream codec unchanged" /
  "relocate `PanelHttpServer`" were all over-optimistic. The real seams are
  spelled out in §2–§4.

## What actually carries over vs. what is new

| Existing machinery | Reuse verdict |
| --- | --- |
| `EnvelopeRpcTransport` interface (`types.ts:285`) | **Carries over** — WebRTC is a new implementer. |
| `composeTransports` (`transports/compose.ts:9`) | **Does NOT do failover** — static predicate routing only; `status`/`ready` follow the fallback transport. **Deleted** — one remote transport means no routing/failover; a thin `TransportManager` owns only the single transport's lifecycle (§1). |
| `wsClient` recovery (`wsClient.ts:87‑126`, `recoveryCoordinator.ts`) — backoff+jitter, socket generations, auth refresh, cold-recover vs resubscribe | **Pattern carries over; code does not** — re-implemented for the RTC connection lifecycle (ICE/DTLS/channel states). |
| `streamCodec` (HEAD/DATA/END/ERROR) | **Frame *shape* carries over** — but base64 lives at the JSON layer (`client.ts:385`), there are **no stream IDs** (no multiplexing), and **no keepalive**. We ship a binary v2 (§1). |
| Server `ws:auth` does grants, leases, `SessionRegistry`, inbox replay, event-session registration, reconnect waiters, server→client bridge + close-time failure synthesis (`rpcServer.ts:633‑821`, `wsServerTransport.ts:64`) | **A whole per-connection server transport, WS-bound.** Becomes `SessionNegotiation` (handshake) **+ a per-logical-session server transport** (§1) — all of it made per-session for N panels on one pipe. The biggest under-counted piece; a server refactor, not a frame. |
| Per-panel principal grants (`panelManager.ts:849`, redeemed `rpcServer.ts:698`) | **Carries over and dictates design** — each panel is its own principal; the pipe must multiplex N logical sessions (§3). |
| PanelHttpServer (`panelHttpServer.ts`) — build cache, mgmt API, `getBuild` callback, direct artifact serving | **Stays server-side.** The client gets a thin **loopback façade** that backhauls `getBuild`/asset requests over the bulk channel (§4). |
| Panel HTTP auth — `validateManagementAuth` gates **only `/api/*`** (`panelHttpServer.ts:648`); HTML/assets/loaders are unauthenticated today | **Unchanged posture** — loopback serves only non-secret assets (no per-request token); panel RPC rides the shell bridge, not a loopback socket (§3/§4). |
| Webhook relay data model — `delivery.mode:"relay"`, `relayPublicBaseUrl`, `/i/{id}`, `verifyRelayEnvelope` (`webhookIngressService.ts:98,419`) | **Carries over.** Backhaul + multi-tenancy + buffering are new (§7). |
| OAuth PKCE (`codeVerifier=randomBytes(32)`, server-side, `credentialService.ts:742`), `state` (`randomBytes(16)`), `client-forwarded`/`client-loopback` callback modes (`credentialService.ts:292`) | **Carries over.** PKCE makes a *dumb* OAuth relay safe; `client-forwarded` carries the code app→server over the pipe (§7). |
| Device-credential / connection-grant pairing (`deviceAuthStore.ts`, `mobileTransport.ts`, `serverClient.ts:176`) | **Carries over** — authorizes the *principal* after DTLS authenticates the *pipe*. |

```
                 ┌──────────────────────────────┐
   QR / key      │  Cloudflare (global)         │
  ┌─────────────▶│  • Signaling DO (UUID rooms, │◀── OAuth redirect / webhook POST
  │              │    persistent for ICE-restart│      (public landing; see §7)
  │              │  • TURN (Realtime, TLS:443)  │
  │              │  • Callback relay: webhook DO (buffered) + OAuth landing (ephemeral)
  │              └───────────┬──────────────────┘
  │           SDP/ICE + TURN │ + webhook backhaul
  ▼   WebRTC DataChannels    ▼
┌──────────────┐  DTLS/SCTP  ┌──────────────┐
│   Client     │◀═══════════▶│  Home server │
│ shell/mobile │  control +  │  (behind NAT,│
│ 127.0.0.1 ───┼──bulk───────┤  no public   │
│ loopback     │             │  endpoint)   │
│ façade+webview             │  PanelHttp + services + workerd
└──────────────┘             └──────────────┘
```

## 1. Transport core (`packages/rpc`)

### TransportManager — single-transport lifecycle owner (no fallback router)

`composeTransports` (`compose.ts:9`, static predicate routing, fallback-only
health) is **deleted**, not reused. With **one** remote transport there is no
routing or failover to do: the `TransportManager` is a thin lifecycle owner around
the WebRTC transport — liveness/health, reconnect + **ICE-restart**, recovery
dispatch, and stream routing — presenting the `EnvelopeRpcTransport` surface upward
so `createRpcClient`/`createHostedRuntime` are unchanged.

### WebRTC `EnvelopeRpcTransport` — channels

- **Control channel** — reliable/ordered SCTP. RPC envelopes + events +
  `SessionNegotiation` frames. Binary framing (no base64).
- **Bulk channel** — reliable/ordered SCTP. Asset bytes, blob downloads,
  proxyFetch streams. **Stream IDs in the frame header** multiplex many concurrent
  streams over the single bulk channel — we do *not* open a channel per stream.
- Backpressure via `bufferedAmount` + `bufferedAmountLowThreshold`. Chunk under
  the measured **256 KB** `maxMessageSize` (spike §11). Application-level
  **keepalive** (data channels have no WS ping; we heartbeat on control and lean
  on ICE consent freshness).

### Binary stream codec v2 (`protocol/streamCodec.ts`)

Keep HEAD/DATA/END/ERROR shape; add a `streamId` field; carry DATA as **binary**
(SCTP is binary-clean — drop the ~33% base64 tax `client.ts:385` pays for
JSON-over-WS). The WS transport keeps the base64 path; the codec gains a binary
mode the RTC bulk channel uses.

### `SessionNegotiation` + a logical-session server transport (the load-bearing refactor)

The `ws:auth` → `ws:auth-result` handshake (`rpcServer.ts:633‑821`) is **bound to
the WebSocket and global-per-connection**, and it does far more than authenticate:
grant redemption → `callerId` (`:698`), caller-kind resolution, panel **lease**
authorization (`:755`), `SessionRegistry.markConnected`/`sessionDirty` (`:775`),
**inbox replay** of missed envelopes (`:823`), **event-session registration**
(`:837`), two-level **reconnect-waiter** resolution (`:744`), `serverBootId`
propagation, and a per-connection server→client **bridge** (`ConnectionRegistry`)
whose transport **synthesizes failures for in-flight server→client calls on close**
(`wsServerTransport.ts:64`).

So this is **not** "extract a handshake frame" — it is two pieces:

1. **`SessionNegotiation`** — the transport-neutral handshake (grant, identity,
   `connectionId`, `bootId`, dirty flag) running as the first frames over *any*
   transport.
2. **A logical-session server transport** — everything above made **per logical
   session** instead of per socket, since N panels multiplex over one pipe. Each
   session gets its own `SessionRegistry` entry, event session, inbox, reconnect
   waiters, and bridge, with **independent close-time failure synthesis** (one panel
   dropping must fail only *its* in-flight server→client calls, never tear down the
   pipe or the other sessions). Identity stays in the envelope's immutable
   `caller`/`provenance`; the channel never sets `delivery.caller`.

Budget this as a **server refactor**, not a frame spec — it is the biggest
under-counted piece in the plan.

### Reconnect / ICE-restart

Mirror the WS maturity (backoff+jitter, generations, grant refresh, cold-recover
vs resubscribe) against RTC states. **In-band renegotiation** when the channel is
degraded-but-alive (SDP over the open data channel); **out-of-band ICE-restart**
via the persistent signaling room when the channel is fully down (§2). This is
why the signaling room is not discarded after the handshake.

## 2. Signaling — minimal, reuse what we have

Signaling is genuinely small (relay an offer, an answer, and ICE candidates
between two peers). We **do not pull in a heavyweight framework** (PeerJS/PeerServer
impose their own id/peer model; simple-peer is a browser helper, not a server).

**Build:** a ~150-line **Cloudflare Worker + Durable Object**, addressed by an
unguessable UUID room, using the WebSocket **Hibernation API** so the room can
persist cheaply for the connection's lifetime (needed for ICE-restart) without
holding compute. **Reuse the existing `apps/webhook-relay` deploy/CI pattern and
Wrangler setup** — same account, same pipeline, new worker.

**Client/server side:** use the platform `RTCPeerConnection` SDP/ICE directly
(`node-datachannel` exposes `onLocalDescription`/`onLocalCandidate`/
`setRemoteDescription`/`addRemoteCandidate`; `react-native-webrtc` is standard
WHATWG). No client signaling library needed.

**TURN:** Cloudflare Realtime TURN ($0.05/GB, 1000 GB free, free STUN at
`stun.cloudflare.com`). Short-lived TURN credentials minted per session and
handed to both peers through the signaling room. Force `iceTransportPolicy`
options so TURN-over-TLS:443 is always reachable.

### Extended pairing payload

The `url`+`code` link and its parser (`connect.ts:107`, mobile
`deepLinkConnect.ts:25`) are **replaced outright** — `url`-style links are deleted
with remote mode (§8), and the parser is **rewritten to accept only the new form**
(no versioned shim, no old-link handling, nothing to fall back to). New link: 

```
natstack://connect?room=<uuid>&fp=<dtls-sha256>&code=<pairing-secret>
   &sig=<signaling-endpoint>&v=<proto-version>&ice=<turn-policy>&srv=<server/workspace-id>
```

`fp` is the server's persistent-cert DTLS SHA-256 (proven pinnable in §11).
`sig`/`v` decouple us from a hard-coded signaling host and allow protocol
evolution. `srv` lets the client label/disambiguate servers.

## 3. Panel RPC over the pipe — N principals, one channel

Verified: each panel authenticates as its **own** principal. `panelManager.ts:849`
mints a grant bound to the panel entity (`panel:<historyEntryKey>`); the panel
redeems it at `ws:auth` (`rpcServer.ts:698`) → its own `callerId` +
`connectionId` + runtime lease. The "one pipe" must therefore carry **many
logical authenticated sessions**.

**Design — the panel↔host hop is the shell bridge, not a socket.** A panel lives
in a webview and cannot touch the host's `RTCPeerConnection` directly, so its RPC
crosses the webview boundary over the **shell bridge that already exists and
already delivers the grant token** (`__natstackShell` — Electron `contextBridge`
IPC on desktop, the React-Native `postMessage` bridge on mobile;
`configLoader.ts:75`). The panel's `EnvelopeRpcTransport` posts envelopes over
that bridge to the host; the host runs each panel's transport-agnostic
`SessionNegotiation` (§1) over its **own logical session** on the control channel,
redeeming its own grant — preserving per-panel principal isolation, leases, and
recovery exactly as today. There is **no loopback `/rpc` socket**: the only thing
on `127.0.0.1` is non-secret asset serving (§4). A logical session multiplexes by
a `sessionId`; the host de-muxes N panels onto the one control channel.

**This is what deletes TLS pinning, and it unifies the two platforms.** Today
desktop panels build `ws://…/rpc` in `__loader.js` and open a **direct TLS
WebSocket to the remote server** (`browserTransportEntry.ts`) — which is *why*
pinning is installed on every `persist:panel:*` partition (`tlsPinning.ts:194`).
Desktop moves to the shell-bridge transport (mobile already works this way:
`PanelWebView`→postMessage→`bridgeAdapter.handle()`→`transport.call("main",…)`),
so **no panel ever makes a remote TLS connection** → per-partition pinning is
removed, not reconfigured, and desktop and mobile share one panel-RPC path.

## 4. Panel local origin — loopback façade (not a relocation)

Panels load from `http://127.0.0.1:<random-high-port>` on every platform
(`connect.ts:189` already trusts loopback as a secure/trustworthy origin). The
local server is a **thin façade**, not a relocated `PanelHttpServer`: the build
system, `getBuild` freshness, and artifacts **stay server-side**; the façade
serves **assets only**, backhauling `getBuild`/asset requests over the **bulk
channel** and caching results. Panel RPC never touches it (§3).

- **No authenticated surface on loopback at all.** The loopback server serves
  **only non-secret assets** (`__loader.js`/`__transport.js`/bundles/css/wasm) —
  exactly today's posture, where assets are unauthenticated and only `/api/*` is
  gated (`panelHttpServer.ts:648`). No façade HTTP response carries a secret: the
  grant token reaches the panel **out-of-band via the shell bridge**
  (`__natstackShell.getPanelInit()` → `globalThis.__natstackGatewayToken`,
  `configLoader.ts:77,109`), never in an HTTP body, and panel **RPC also rides the
  shell bridge** (§3), not a loopback socket. So there is no `/rpc` port to reach,
  no cookie, no Service Worker, no host-isolation, and no per-asset token — the
  whole question dissolved once we checked nothing secret is in the HTTP plane. The
  authenticated surface is the `SessionNegotiation` handshake over the bridge,
  **failing closed** (no valid grant ⇒ no session ⇒ no RPC); a grant can't be
  obtained by a local process (it is handed to the webview over preload/RN, not the
  network). Bind `127.0.0.1` only, never `0.0.0.0`. **CSP** (`buildPanelCsp`,
  `constants.ts:71`, loopback-only) stays as an *independent* panel-egress control,
  justified on its own — not a backstop.
- **The full gateway HTTP surface, route by route — verified there are *zero*
  browser-initiated authenticated subresource loads, so assets-only loopback holds
  with one explicit contract: authenticated access moves to the pipe, never a
  loopback HTTP route.**
  - `/rpc` + `/rpc/stream` → the pipe (control/bulk), not loopback.
  - panel HTML/bundles, `/__loader.js`/`/__transport.js`, and `/_a/*` **app
    artifacts** (verified **public**, no auth) → loopback façade, unauthenticated.
  - `/_r/s/*` **service HTTP routes** split: third-party-facing (oauth callback,
    webhook ingress, `complete-pairing`) → the **relay** (§7); panel-facing
    (blobstore bytes) are already reached by panels over **RPC**
    (`blobstore.getBase64`/`getRangeBytes`), not HTTP.
  - **`gatewayFetch`** — the runtime API that attaches the bearer token
    (`gatewayFetch.ts:28`) — is **rewritten to tunnel over the bridge** (it is
    app-initiated, so it can; same `stream()` path as proxyFetch) instead of issuing
    a loopback HTTP request. Net: `/rpc` + bridge is the **only** authenticated
    surface; no authenticated HTTP route is ever exposed on `127.0.0.1`.
- **Content-addressed asset cache.** Builds/blobs are already digest-addressed;
  the façade keeps a persistent on-disk cache keyed by content hash so large
  wasm/fonts/images are **not re-pulled over (paid) TURN** across reconnects.
- **Preserve `basePath`.** Panel URLs carry a workspace prefix
  (`panelUrls.ts:68`, e.g. `/_workspace/dev`); the loopback rewrite keeps it.
- **Per-platform.** Desktop: Node loopback server in main (optional later:
  socket-free `protocol.handle`). iOS WKWebView: embedded GCDWebServer-style
  loopback + `NSAllowsLocalNetworking`; pure loopback does not trip the iOS
  local-network prompt. Android WebView: loopback server (or `WebViewAssetLoader`
  for a socketless virtual `https://` origin).

## 5. Native stacks & packaging (called out, not hand-waved)

The repo has **zero** WebRTC deps today; `pnpm.onlyBuiltDependencies` is
`["electron","esbuild","node-pty"]` (`package.json:72`), Electron `^39.2.5` +
electron-builder `^25`, mobile is **bare React Native 0.79.2 (no Expo)**.

- **Desktop/server (`node-datachannel`, libdatachannel):** add to
  `onlyBuiltDependencies`; installs via `prebuild-install -r napi` (prebuilt N-API
  binary, no local toolchain in the common case), `@electron/rebuild` +
  `asarUnpack` for the `.node` in packaging. Cross-platform prebuilds
  (mac/win/linux × x64/arm64) validated in CI.
- **Mobile (`react-native-webrtc`):** bare-RN manual native linking — iOS Pod +
  `NSAllowsLocalNetworking`, Android gradle (`minSdk 24`, desugaring note). No
  Expo config plugin (we are bare RN).
- **The server side commits to `node-datachannel`** (throughput). `werift`
  (pure-TS, same certificate/fingerprint surface) is noted only as the path for a
  target that genuinely *cannot* run the native module — not a general fallback kept
  warm.

## 6. Security model — proven, with creds gated behind the pin

1. **DTLS fingerprint pin in the QR.** The server holds a **persistent** cert
   (`certificatePemFile`/`keyPemFile`); its SHA-256 goes in the QR `fp`. The
   client compares the **observed** peer fingerprint (`remoteFingerprint()`)
   against `fp` and accepts iff equal. A signaling server that swaps the
   fingerprint is detected and rejected. **Empirically proven** — §11.
2. **Credentials never traverse the channel until the pin verifies.** The device
   credential / connection-grant exchange (`mobileTransport.ts`,
   `serverClient.ts:176`) runs only **after** the fingerprint check passes and the
   data channel is authenticated. DTLS authenticates the *pipe*; grants authorize
   the *principal*.
3. **TOFU only with out-of-band confirmation.** Auth-free signaling means TOFU is
   *not* safe silently (the broker could substitute a fingerprint on first use).
   If no pin is pre-shared, surface the observed fingerprint for explicit
   user/out-of-band confirmation before pinning.
4. **Privacy, stated plainly.** The signaling DO sees peer IPs (inherent to ICE);
   TURN sees connection metadata (not DTLS plaintext). Acceptable for self-host;
   documented.

## 7. Callback relay — two profiles on one shared backhaul

OAuth callbacks and webhooks are both third-party inbound: an external party must
hit a **public HTTPS URL**, and the home server has none. They **share** the
relay's backhaul and multi-tenant registration (one code path) and differ only in
**durability** — that difference is the distinction worth keeping.

**OAuth needs a public relay too — and all platforms share it.** On mobile the
system browser cannot redirect to the client's loopback origin or to the NAT'd
home server, and providers reject non-public redirect URIs, so a public landing
is required. Per our parity rule, if mobile needs it, **every platform uses it** —
desktop and mobile share the one OAuth path rather than special-casing desktop
loopback.

**OAuth relay = a dumb, ephemeral landing + universal-link host (not a
subsystem).** Because OAuth is interactive with the client online, there is **no
durable buffering, queue, or retry**. The relay is a public landing
(`https://relay/oauth/callback?code&state`) that does a single **`state`-keyed
handoff**, with **exactly one path per platform** (not a preference with a silent
fallback):

- **mobile → deep-link:** the landing is an App Site Association / App Links host,
  so the OS hands the `code` into the already-connected app, which forwards
  `{state, code}` over the pipe. This also closes the auth session and returns the
  user to the app — so it is the *only* sensible mobile path, not an optimization.
- **desktop → backhaul-forward:** the relay pushes `{state, code}` down the
  server's persistent backhaul to the live process.

Each platform has one mechanism that **fails loud** — a broken App-Links
association or a down backhaul makes OAuth visibly fail and the user retries; no
durability, and no second path quietly covering for a broken first one. PKCE keeps
both safe regardless of who sees the `code`. **PKCE keeps the relay harmless**: the `codeVerifier` never
leaves the home server (`credentialService.ts:742`), so even on the backhaul path
where the relay sees the `code`, it is useless to the relay. OAuth `state` stays
in-memory on the server (`credentialService.ts:3599`) — fine for an interactive
flow. The app→server forwarding step reuses the `client-forwarded` callback mode
(`credentialService.ts:292`).

**Trust & transaction model (what the relay must pin down).** Today the server
matches a callback by `state` **and** the expected redirect URL (host+path vs
`tx.redirectUri`, `credentialService.ts:3654`) and enforces **caller binding** on
forwarded callbacks (`:980`). Backhaul/relay delivery is **not modeled today**, so
the design specifies: (1) the transaction is created with the **relay's** host as
`redirectUri` so redirect-matching succeeds; (2) lookup is by explicit
**`transactionId`** carried through the landing, not a `state`-scan; (3) `state` and
`code` are relayed **verbatim** — the relay never re-signs (`state` is the CSRF
token); (4) **two binding paths** — *mobile deep-link* delivers to the app, which
forwards as its own authenticated principal (`deliveryCaller` binding, like
`client-loopback`); *desktop backhaul* is a **new trusted server-side delivery
strategy** where the authenticated server↔relay backhaul is the trust anchor,
bypassing per-caller binding. PKCE still makes an intercepted `code` useless.

**Webhook relay = the stateful subsystem.** Webhooks fire asynchronously with the
client possibly offline, so this profile keeps everything OAuth drops: durable
per-subscription buffering, TTL, provider-retry semantics, response handling,
replay controls, rate limiting. Multi-tenant routing replaces the single
hard-coded `NATSTACK_SERVER_BASE_URL` (`apps/webhook-relay/src/index.ts:59`) with
`subscriptionId → server`. It sees webhook plaintext (HMAC/OIDC give integrity,
not confidentiality) — decidedly *not* "dumb."

**Shared by both:** the authenticated **persistent backhaul** (server → relay DO)
and **first-writer-wins registration** bound to that backhaul identity (the shared
`NATSTACK_RELAY_SIGNING_SECRET` is one un-versioned key — too weak for tenant
isolation; the per-server connection is the trust anchor). Repoint
`relayPublicBaseUrl` / `buildPublicUrl` at the relay hostname.

## 8. Decommission — the legacy remote-server / Tailscale / TLS-pinning surface

All of this is **deleted in the same change**, not gated. Inventory verified
against the tree, in three groups.

### 8a. Server public ingress · public-URL · Tailscale/VPN

- **Delete entire files:** `src/server/publicUrl.ts`, `src/server/vpnDetect.ts`
  (+`.test.ts`), `src/server/tailscaleServe.ts` (+`.test.ts`).
- **Strip to loopback-HTTP-only:** `gateway.ts` — TLS cert/key fields + the HTTPS
  branch (~163‑172, 502‑506, 616), origin allow-list → loopback+relay (~664‑677);
  `hubServer.ts` — `resolvePublicUrl()` (~725‑754), HTTPS branch (~843‑851),
  `tlsCert`/`tlsKey`/`noVpnDetect` args; `index.ts` — `--tls-cert/--tls-key`,
  `gatewayProtocol()` (always http), `getExternalGatewayUrl()`/
  `getConfiguredPublicUrl()`, and the whole VPN-detect + `ensureHttpsServe()` +
  public-URL startup/banner block (~3138‑3270, 3376‑3394, 3658‑3810).
- **Repoint (callback construction only):** `credentialService.ts`
  `buildPublicUrl(PUBLIC_OAUTH_CALLBACK_PATH)` (~2211,2214,2359,2362) and the
  `"public"|"loopback"` decision (~296) → the **callback-relay hostname** (§7).
  The path constant stays.
- **Env deleted:** `NATSTACK_PUBLIC_URL`, `NATSTACK_PROTOCOL`,
  `NATSTACK_NO_VPN_DETECT`, `NATSTACK_REQUIRE_PUBLIC_URL`, `--tls-cert/--tls-key`.
- **Docs/scripts:** rewrite/delete the TLS-HTTPS, TLS-pin, callback-reachability,
  `--no-vpn-detect` sections of `docs/remote-server.md`; the Tailscale-serve setup
  in `docs/mobile-vpn.md`; the external-URL section of `docs/routes.md`;
  `scripts/cli/remote-serve.mjs`; and `scripts/cli/lib/pair-server.mjs` (drop
  `--host tailscale|vpn`, `--public-url`, Tailscale help).

### 8b. TLS-certificate pinning & remote-origin trust

- **Delete entire files:** `src/main/tlsPinning.ts`,
  `src/main/serverClient.tls.test.ts`.
- **Gut the desktop remote-pairing/TLS-probe service**
  `src/main/services/remoteCredService.ts`: keep the device-credential
  issuance/storage core (it authorizes the principal); delete all
  fingerprint/TLS probing (`probePeerFingerprint`, `probeRemoteTrust`,
  `probeTrustAtUrl`, `healthProbe`, the duplicate `sha256Fingerprint`) and the
  `fetchPeerFingerprint`/`pickCaFile` handlers. Its pairing *UX* is replaced by the
  WebRTC QR room+fp flow (§2).
- **Delete the TLS-pinning UI** in
  `workspace/apps/shell/components/ConnectionSettingsDialog.tsx`: the `UrlFields`
  CA-path + "Fetch fingerprint from server" subcomponent and the
  `TrustFingerprintPrompt` (trust-on-first-use) dialog; plus the
  `fetchPeerFingerprint`/`pickCaFile` wrappers in `shell/client.ts`.
- **Delete schema/type fields:** `caPath`/`fingerprint` from
  `serviceSchemas/remoteCred.ts` and `workspace/types.ts` remote options — removed,
  not deprecated. `remoteCredentialStore.ts` is deleted entirely (§8c), so there is
  no stored state to migrate.
- **`packages/shared/src/connect.ts` — keep the file, rewrite the contents:** keep
  the URL-builder helpers; **rewrite** pairing create/parse for the **new link only**
  (§2, no old-format handling); **DELETE** `isTrustedCleartextHost`, `isPrivateIPv4`,
  `isTailscaleIPv4`, `isSingleLabelHostname`, replacing the cleartext check in
  `parseConnectServerUrl` with one `isLoopbackHost()` (127.0.0.0/8, `::1`,
  `localhost`, `10.0.2.2` for the dev emulator).
- **`src/main/startupMode.ts` — strip:** `isTrustworthyRemoteOrigin`,
  `RemoteTlsOptions`, and the `NATSTACK_REMOTE_FINGERPRINT`/`NATSTACK_REMOTE_CA`
  loads (env vars deleted).

### 8c. Client/mobile remote-server config → loopback + pipe

- **Delete:** `src/main/remoteCredentialStore.ts`; the `kind:"remote"` startup
  branch + remote `wsUrl`/protocol extraction in `startupMode.ts`/
  `serverSession.ts`; the `wsUrl` fallback in `serverClient.ts` (always local).
- **Repoint panel-URL/transport plumbing to a fixed `http://127.0.0.1` origin,
  deleting `externalHost`/`protocol` params:** `panelFactory.ts`
  `buildPanelUrl`/`buildPanelEnv` (keep `source`/`contextId`/`basePath`/`ref`);
  `shell/urlParsing.ts` `isManagedHost` + mobile
  `PanelWebView.tsx`/`MainScreen.tsx`/`panelUrls.ts` + desktop `panelView.ts`
  (loopback origin only); `constants.ts` `buildPanelCsp` (loopback-only, §4);
  mobile `mobileTransport.ts` `buildWsUrl` (`http://127.0.0.1 → ws://`).
- **Pairing → no stored remote URL:** strip `serverUrl`/`hubUrl` from the mobile
  `Credentials`/pairing response (`auth.ts`); WebRTC `room`+`fp` replaces it.
  Device credentials/grants are **kept**.

**Reconciliations:**
- `NATSTACK_REMOTE_URL` (point the shell at a remote https server) is **deleted**,
  not repointed — the shell reaches its server over WebRTC, paired by QR. The
  relay hostname (§7) is separate config used only for callback construction; the
  data plane never flows through it.
- **ADB-reverse / `10.0.2.2`:** confirmed **absent** from client source; the only
  reference is `connect.ts` trusting `10.0.2.2` as Android-emulator loopback —
  folded into `isLoopbackHost`, kept for dev.

**What stays:** the loopback HTTP gateway (now the only one), `/healthz`, admin
token + device-credential/connection-grant issuance, the OAuth flow structure
(callback host → relay), and CDP/inspector (dev-only). Remote mode is WebRTC;
local co-located mode is loopback WS.

## 9. Parallel workstreams (build it all at once)

Not phases — concurrent tracks with **contracts defined up front** so they
integrate at the end against agreed interfaces, not in sequence.

- **A — Transport core** (`packages/rpc`, `src/server/rpcServer.ts`):
  `TransportManager`, WebRTC transport (control+bulk), binary stream codec v2
  (stream IDs), `SessionNegotiation` + the **per-logical-session server transport**
  (grants, leases, `SessionRegistry`, event sessions, inbox, bridge, close-time
  failure synthesis), ICE-restart/recovery. *Contract:* `EnvelopeRpcTransport`
  upward + the `SessionNegotiation` frame spec + the per-session server-transport
  responsibilities. This track is a **server refactor**, not just a client transport.
- **B — Signaling + pairing** (`apps/signaling` CF DO, `connect.ts`): persistent
  UUID-room DO, extended pairing payload, TURN cred minting, fingerprint-pin
  verify helper. *Contract:* signaling message schema + pairing-URL grammar.
- **C — Native stacks** (Electron main, mobile): node-datachannel + packaging,
  react-native-webrtc linking, **persistent-cert management + fingerprint export**.
  *Contract:* a `PeerConnection`/cert provider interface A codes against.
- **D — Loopback origin + panel RPC bridge** (`panelHttpServer` façade, `src/main`
  preload, mobile `PanelWebView`/`panelUrls`): loopback façade serving **non-secret
  assets only** over the bulk channel; panel RPC over the **shell bridge** (Electron
  `contextBridge` / RN `postMessage`) → host → control-channel logical session;
  content-addressed cache. *Contract:* the bulk-channel `getBuild`/asset request
  schema + the shell-bridge `EnvelopeRpcTransport` (envelope post + `stream()`).
- **E — Callback relay** (`apps/webhook-relay`, `credentialService`,
  `webhookIngressService`): shared multi-tenant routing + authenticated backhaul
  DO + first-writer-wins registration, with **two delivery profiles** —
  durable buffer/retry for webhooks, and a **dumb ephemeral OAuth landing +
  universal-link host** (`state`-keyed handoff, no buffering). **Net-new high-risk
  infra** — only the relay envelope/signing model carries over; durable buffering,
  registration, first-writer-wins identity, and the persistent backhaul are all new
  protocol surface. *Contract:* registration + backhaul-delivery protocol + OAuth
  landing/universal-link association + the `transactionId`/redirect-URL/trusted-backhaul
  OAuth trust model (§7), each with its own tests.
- **F — Cutover/deletion** (`startupMode`, `tlsPinning`, `publicUrl`,
  `vpnDetect`, `gateway`): remove remote ingress; wire mode selection.

Integration seam: end-to-end **pair → connect → load panel from loopback → N
authenticated panel RPC sessions → proxyFetch stream → webhook backhaul**.

## 10. Alternative considered (not chosen): backhauled WS-relay + E2E

A home server holds one outbound WS to a CF DO; the client connects to the same
DO; the DO pipes envelopes. This reuses `wsClientTransport` wholesale and deletes
ICE/TURN/signaling and the native WebRTC stacks. **Why not chosen:** a CF WS-relay
*terminates* TLS, so the operator sees plaintext RPC + asset bytes; matching
WebRTC's confidentiality requires an app-level E2E layer (Noise/libsodium keyed
off the pairing secret) — and you still pay CF egress for **every** byte forever.
WebRTC's DTLS is end-to-end **even through TURN** (TURN relays ciphertext, never
terminates it), and STUN gives a true-P2P fast path at zero per-byte cost on
traversable networks. This section is a **decision record**, not a live fallback —
we commit to WebRTC and do not keep the relay path warm.

## 11. Spike results (run, not assumed)

`node-datachannel@0.32` (libdatachannel), two peers + in-process "dumb" signaling
relay, persistent ECDSA P-256 cert via `certificatePemFile`/`keyPemFile`:

- **Pin verifies end-to-end.** SHA-256 computed **offline from the cert PEM**
  (`AA:64:F8:…:19`) == fingerprint the client observes on the live wire via
  `remoteFingerprint()`. No SDP parsing required.
- **Stable across restart.** A fresh `PeerConnection` loading the same PEM
  presents the identical fingerprint → pairing survives server restarts.
- **MITM detectable.** A substituted "attacker" cert yields a different
  fingerprint (`8B:80:75:…`); `observed !== pinned` → client rejects. The
  dumb-signaling security model holds.
- **`maxMessageSize` = 262144 (256 KB)** — the chunking cap the bulk channel must
  honor; `bufferedAmount`/`bufferedAmountLowThreshold` present for backpressure.

(Spike at `scratchpad/rtc-spike/pin-spike.mjs`.)

## 12. Residual open questions

- **iOS embedded loopback server** — GCDWebServer-style native dep,
  foreground-only; confirm App Store review + panel lifecycle. (Subresource
  token-auth is *not* a question — §4 serves only non-secret assets, so the
  WKWebView Service-Worker / `*.localhost` limitations never bite. The razor in
  the fail-loud rule deleted this spike.)
- **Logical-session multiplexing fairness** — N panels over one control channel
  reintroduces cross-panel head-of-line risk; measure and, if needed, shard busy
  panels onto additional channels.
- **TURN egress at scale** — asset-heavy panels on symmetric-NAT networks relay
  through paid TURN; the content-addressed cache is the mitigation — validate hit
  rates.
- **Fail-loud observability (not optional)** — surface per-connection ICE
  candidate type (host/srflx/**relay**) and alert when the relay rate exceeds a
  baseline, so silent over-relaying (P2P quietly broken, TURN covering) is caught;
  likewise log which recovery path (in-band vs ICE-restart) and which OAuth handoff
  engaged. Each pairs with a negative test (per the fail-loud rule).
- **node-datachannel ARM/mobile-class prebuild coverage** in CI across all target
  triples.

## Touch points

- `packages/rpc/src/transports/webrtcClient.ts` — new transport.
- `packages/rpc/src/transports/transportManager.ts` — new (replaces compose for remote).
- `packages/rpc/src/protocol/streamCodec.ts` — binary v2 + stream IDs.
- `packages/rpc/src/protocol/sessionNegotiation.ts` + a per-logical-session server transport — new; extracted/generalized from `rpcServer.ts:633‑821` and `wsServerTransport.ts:64` (close-time failure synthesis).
- `src/server/rpcServer.ts`, `src/server/wsServerTransport.ts` — make auth/session + server→client bridge per-logical-session, not per-socket.
- `workspace/packages/runtime/src/shared/gatewayFetch.ts` — rewrite to tunnel over the bridge (no loopback HTTP); `src/server/serviceWithHttpRoutes.ts` — panel-facing routes retired for RPC, third-party-facing routes move to the relay.
- `src/server/panelHttpServer.ts` — split server build authority from a client loopback façade serving non-secret assets only (no per-request token gate).
- `src/server/browserTransportEntry.ts`, `src/server/configLoader.ts`, desktop preload bridge — panel `EnvelopeRpcTransport` rides the shell bridge (replaces the panel's direct `ws://…/rpc`).
- `src/main/serverClient.ts`, `workspace/apps/mobile/src/services/mobileTransport.ts` — transport selection.
- `workspace/apps/mobile/src/components/PanelWebView.tsx`, `services/panelUrls.ts` — loopback origin + bridge.
- `packages/shared/src/connect.ts`, `scripts/cli/lib/connect-utils.mjs` — extended pairing link.
- `src/server/services/credentialService.ts`, `services/webhookIngressService.ts` — OAuth `state`-keyed relay handoff (universal-link / backhaul-forward, reusing `client-forwarded`); webhook backhaul + buffering + registration.
- `apps/webhook-relay/` (or a shared `apps/callback-relay/`) — shared backhaul + registration; webhook buffering profile + OAuth ephemeral landing/universal-link host profile.
- New `apps/signaling/` — CF signaling DO (UUID rooms, persistent).
- Delete/strip: `src/main/tlsPinning.ts`, `src/server/publicUrl.ts`, `src/server/vpnDetect.ts`, remote-origin paths in `src/main/startupMode.ts`.

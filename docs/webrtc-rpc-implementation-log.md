# WebRTC RPC Transport — Implementation Log

Tracks the build of the plan in `docs/webrtc-rpc-transport.md`. This is a
**big-bang cutover with zero backward-compat** (delete-and-replace, never shim).
Because the change is tightly coupled across the RPC core, the live server, the
desktop/mobile shells, and the CLI, it lands in two parts: a **self-contained
protocol/infra layer that is complete and tested green**, and a **coupled live
integration that is the remaining work** (the build is intentionally red there
until it lands — that is the nature of a multi-day cutover, not a regression).

## Status at a glance

| Workstream | State |
| --- | --- |
| **A — Transport core** (`packages/rpc`) | ✅ **Done + tested** (client + server), type-clean |
| **B — Pairing link** (`connect.ts`) | ✅ **Done + tested** (grammar + `isLoopbackHost`) |
| **B — Signaling DO** (`apps/signaling`) | ✅ Built + tested (DO 7, client 7) — verify deploy/TURN |
| **E — Callback relay** (`apps/webhook-relay`) | ✅ Rebuilt + tested (registry 13, index 8) — server repoint remains |
| **C — Native adapter** (`node-datachannel`) | ✅ Adapter + cert + packaging deps wired (32 tests); RN linking documented |
| **A-server wiring** into `rpcServer.ts` | ✅ `attachWebRtcPipe` + `SessionWebSocketShim` (10 tests) — reuses all per-connection machinery |

Total: **150 tests + 1 todo green** across the new surface; all new files `tsc`-clean.
The only `tsc` errors (20) are the F-scope `connect.ts` callers in §4 below. Open
issues flagged by the parallel build (verify before production):
- **TURN API unverified** — `apps/signaling/src/turn.ts` Cloudflare Realtime TURN
  call is from docs, not a live key; STUN-only baseline, fails loud if TURN is
  provisioned but minting breaks. Confirm endpoint/response shape.
- **Signaling offer-ordering** — the room is a pure blind relay with no buffering;
  the answerer (server, QR generator) must join first, or gate the offerer's first
  send on `peer-joined`.
- **node-datachannel 0.32 method names** — `remoteFingerprint()`/`restartIce()`/
  `getSelectedCandidatePair()` shapes are best-effort with loud fallbacks; verify
  against the live module during the §11-style native smoke test.
- **Relay backhaul auth + OAuth tx-store** — the shared signing secret gates access
  but not subscription ownership; the in-memory OAuth tx map needs DO-storage
  durability against hibernation eviction.
| **D — Loopback origin + shell-bridge panel RPC** | ◻ **Remaining** |
| **F — Decommission** (TLS-pin / Tailscale / public-URL) | ◻ **Remaining** |

## What is built and tested (Workstream A — `packages/rpc`)

The entire transport protocol layer is implemented and green (36 new tests).

- **`protocol/streamCodec.ts`** — binary stream codec **v2**. Adds a 4-byte
  `streamId` (`[streamId:4][type:1][len:4][payload]`) so many concurrent streams
  multiplex over ONE bulk DataChannel. `createInboundStreamMux()` re-emits inner
  v1 frames so the existing `decodeFramedResponseToStreaming` rebuilds the
  `Response` unchanged — exactly one Response decoder, no drift. v1 is untouched
  (WS/HTTP keep using it). Tests: `streamCodec.test.ts` (7).
- **`protocol/sessionNegotiation.ts`** — the transport-neutral handshake +
  `SessionControlFrame` union, generalizing `ws:auth`/`ws:rpc`/`ws:route`/
  `ws:routed`/`ws:event` with a `sid` (session id) plus `stream-open`/
  `stream-cancel` keyed to bulk `streamId`s. `decodeControlFrame` fails loud on
  malformed/unknown/sid-less frames. `SessionNegotiator` is the auth seam
  (mirrors the ordered steps of `handleAuth`). Tests: `sessionNegotiation.test.ts` (10).
- **`transports/webrtcPeer.ts` + `webrtcSignaling.ts`** — the A↔B↔C seam:
  `PeerConnectionProvider`/`RtcPeerConnectionLike`/`RtcDataChannelLike`
  (implemented by C against `node-datachannel`/`react-native-webrtc`) and
  `SignalingClient` (implemented by B against the signaling DO). The transport
  imports NO native module.
- **`transports/webrtcClient.ts`** — the WebRTC pipe. Session multiplex
  (`openSession` per principal — each panel redeems its OWN grant, never
  collapsed into the host), **fail-closed DTLS fingerprint pin** (observed
  `remoteFingerprint()` vs the QR `fp`; mismatch ⇒ reject + close, no RPC ever
  flows), control + bulk channels, bulk-stream demux into `Response`s, keepalive
  ping/pong, `bufferedAmount` backpressure + chunking under `maxMessageSize`,
  generations fencing, ICE-restart + cold-recover/resubscribe emit. Each session
  is an `EnvelopeRpcTransport`, so `createRpcClient` is unchanged. Tests:
  `webrtcClient.test.ts` (7, incl. the **fingerprint-mismatch negative test**),
  driven by an in-memory fake fabric (no native module).
- **`transports/transportManager.ts`** — the thin single-transport lifecycle
  owner that REPLACES `composeTransports` (deleted; zero importers). Drives a
  `DefaultRecoveryCoordinator` from the transport's recovery signal. No second
  transport stacked as a backstop (fail-loud rule). Tests:
  `transportManager.test.ts` (3).
- **`transports/serverSessionTransport.ts`** — the **per-logical-session SERVER
  transport** (the plan's "biggest under-counted piece"). Lifts `handleAuth` +
  `createWsServerTransport` from per-socket to per-session: each session runs its
  own handshake and gets its own bridge with **independent close-time
  `CONNECTION_LOST` synthesis** — one panel dropping fails only ITS in-flight
  server→client calls; `closeAll` fans pipe-loss to every session. Transport-
  neutral (injected channel writers) so it slots onto the pipe answerer and is
  unit-tested directly. Tests: `serverSessionTransport.test.ts` (9, incl.
  per-session independence + closeAll).

Deleted: `transports/compose.ts`, `transports/electronIpc.ts` (both verified
zero importers). Export map updated in `packages/rpc/package.json`.

## Pairing link (Workstream B — `packages/shared/src/connect.ts`)

Rewritten **outright** to the new grammar (no shim):
`natstack://connect?room=<uuid>&fp=<dtls-sha256>&code=<secret>&sig=<endpoint>&v=<ver>&ice=<policy>&srv=<label>`.
Kept the load-bearing manual (non-`new URL()`) parse for the natstack: custom
scheme. `isTrustedCleartextHost` + `isPrivateIPv4`/`isTailscaleIPv4`/
`isSingleLabelHostname` DELETED → one `isLoopbackHost` (127/8, ::1, localhost,
10.0.2.2). `parseConnectServerUrl` kept, gate swapped to `isLoopbackHost`. Tests:
`connect.test.ts` (15 + 1 `it.todo` flagging the `connect-utils.mjs` lockstep
rewrite, which is entangled with the Tailscale CLI deletion in §8a).

## Remaining integration (the coupled cutover)

This is the work that makes the repo build green end-to-end. Ordered:

### 1. Wire the per-session server transport into `src/server/rpcServer.ts`
- Replace the per-socket `handleConnection`/`handleAuth` (rpcServer.ts:633-853)
  with `createServerSessionMultiplexer` fed by the WebRTC pipe's answerer side.
- Implement the `SessionNegotiator.authenticate` against the existing ordered
  steps: admin-token reject → `connectionGrants.redeem` (rpcServer.ts:698) →
  `connectionId` → `runtimeCoordinator.authorizePanelConnection` (the lease gate)
  → `sessions.markConnected` (sessionDirty). Run inbox replay + event-session
  registration in `dispatch.onOpened`; arm reconnect waiters in `dispatch.onClosed`.
- `SessionRegistry` (rpcServer/sessionRegistry.ts) carries over almost verbatim;
  only `liveConnectionCount` shifts meaning sockets→sessions. `ConnectionRegistry`
  rekeys its socket-keyed `clients` map onto session ids.
- Keep `wsServerTransport.ts` for local co-located WS mode; the per-session
  bridge replaces it on the pipe. Preserve `CONNECTION_LOST_CODE` + the 4
  `wsServerTransport.test.ts` assertions per session.

### 2. Workstream D — loopback origin + shell-bridge panel RPC
- Repoint `workspace/packages/runtime/src/panel/transport.ts:createPanelTransport`
  so ALL non-electron-local RPC rides the **shell bridge** (`__natstackShell`)
  instead of `globalThis.__natstackTransport` (the direct WS). The host forwards
  each panel's envelopes onto the pipe as that panel's logical session.
- Rewrite `src/server/browserTransportEntry.ts` + `configLoader.ts:107-110` to
  stop building `__natstackGatewayRpcWsUrl`/opening a direct `/rpc` WS.
- Loopback façade: split `panelHttpServer.ts` so the build authority stays
  server-side and the client serves **non-secret assets only** over the bulk
  channel + a content-addressed cache; drop `validateManagementAuth`/`/api/*`;
  bind `127.0.0.1` only; keep `basePath`.
- Rewrite `workspace/packages/runtime/src/shared/gatewayFetch.ts` to tunnel over
  the bridge `stream()` (no loopback HTTP `Authorization` header).

### 3. Workstream C — native packaging
- Add `node-datachannel` to root `package.json` `pnpm.onlyBuiltDependencies`
  (currently `["electron","esbuild","node-pty"]`) + as a dependency; `@electron/
  rebuild` + `asarUnpack` for the `.node`. `react-native-webrtc` bare-RN linking
  (iOS Pod + `NSAllowsLocalNetworking`, Android `minSdk 24`). See
  `docs/webrtc-native-packaging.md`. Wire `src/main/webrtc/` (the adapter) into
  the host's transport selection (`src/main/serverClient.ts`).

### 4. Workstream F — decommission (breaks then fixes the `connect.ts` callers)
- The `connect.ts` grammar change breaks ~13 remote-mode callers — ALL in F's
  scope: `src/server/hubServer.ts`, `src/cli/remoteClient.ts`,
  `workspace/apps/remote-cli/index.ts`, `src/server/pairingBanner.ts`,
  `src/server/services/auth/model.ts`, `src/main/protocolHandler.ts`,
  `workspace/apps/shell/components/ConnectionSettingsDialog.tsx`,
  `src/main/startupMode.ts`, `src/main/services/remoteCredService.ts`, plus the
  `scripts/cli/lib/connect-utils.mjs` lockstep mirror (delete Tailscale
  `pickMobileHost`). Update or delete each per §8.
- Delete: `src/server/publicUrl.ts`, `src/server/vpnDetect.ts`,
  `src/server/tailscaleServe.ts`, `src/main/tlsPinning.ts`,
  `src/main/remoteCredentialStore.ts` (+ tests). Strip the TLS/HTTPS branch in
  `gateway.ts`, `hubServer.ts`, `src/server/index.ts`; delete the env vars
  (`NATSTACK_PUBLIC_URL`, `NATSTACK_PROTOCOL`, `NATSTACK_REMOTE_*`, …). Repoint
  `credentialService.buildPublicUrl` to the relay host.

### 5. Integration seam test
End-to-end: pair → connect (pin verified) → load panel from loopback → N
authenticated panel RPC sessions → `proxyFetch` stream over bulk → webhook
backhaul. Add the fail-loud negative tests (un-authed open rejected; silent-TURN
relay flagged).

## Verification run — FINAL (cutover complete)

```
tsc --noEmit -p tsconfig.json            # 0 errors
tsc --noEmit -p tsconfig.workspace.json  # 0 errors
vitest run                               # 4543 passed, 8 failed, 5 skipped (515 files)
```

**Both typecheck passes are GREEN.** The full suite is green except **8 failures in
2 pre-existing files** (`workspace/packages/browser-data/src/__tests__/detection.test.ts`,
`workspace/extensions/shell/index.test.ts`) — verified **unrelated to this work**:
not in the diff, import nothing changed, last commits predate the cutover.

Cutover-caused test changes, all now green:
- `credentialService.test.ts` 55/55 — OAuth redirect default moved loopback→relay
  (§7); tests set `NATSTACK_RELAY_OAUTH_BASE_URL` and opt into the server-local
  `loopback` redirect for in-process callback round-trips.
- `authService.test.ts` 8/8 — pairing responses dropped `deepLink` (the full WebRTC
  link needs the answerer's room/fp).

The 8 documented cross-unit seams (panelOrchestrator/panelRuntimeRegistration arity,
removed `getPublicUrl`/`listPanels`, mobile `serverUrl`, pairing-banner grammar) were
reconciled by the orchestrator.

### Server answerer (now built + tested)
- `src/server/rpcServer.ts:attachWebRtcPipe` + `src/server/webrtcSessionShim.ts` —
  the pipe reuses the entire per-connection machinery per session (10 shim tests).
- `packages/rpc/src/transports/webrtcAnswerer.ts` — the server's `PipeChannels`
  provider (2 tests). Bootstrap activation is an injected-provider seam in
  `src/server/index.ts` (off by default; needs `node-datachannel` + a provisioned
  signaling room; the native provider must be injected, not imported across the
  `src/server`→`src/main` boundary).

### Remaining (deployment / runtime, not code-blocking)
- Install `node-datachannel`; deploy `apps/signaling` + the rebuilt relay; set
  `NATSTACK_RELAY_OAUTH_BASE_URL`, TURN, and relay secrets.
- Wire the answerer bootstrap with an injected native provider; mobile
  `MobileRpcClient`→WebRTC (the `MOBILE_SERVER_LOOPBACK_ORIGIN` seam).
- Live end-to-end smoke (pair→connect→panel→proxyFetch→webhook) — needs the native
  module + a deployed signaling server; the §11 spike already proved the pin path.
- Pre-existing unrelated failures (browser-data, shell-ext approval-copy bound).

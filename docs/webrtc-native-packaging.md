# WebRTC native stacks & packaging (workstream C)

Packaging notes for the native WebRTC peer implementations that back the
platform-agnostic `PeerConnectionProvider` contract
(`packages/rpc/src/transports/webrtcPeer.ts`). The repo had **zero** WebRTC deps
before this work (plan §5); both stacks below are net-new.

- **Desktop + server:** `node-datachannel` (libdatachannel) —
  `src/main/webrtc/nodeDatachannelPeer.ts`.
- **Mobile:** `react-native-webrtc` (bare RN 0.79) — adapter lives in the mobile
  app (separate workstream/unit); its linking is recorded here for completeness.

The adapter code carries the native dependency; the transport never does. The
native module is loaded **lazily** (only when a peer is created) through a
renamed `require` binding so esbuild cannot hoist it to an eager top-level import
(`build.mjs` lifts bare `require()` calls). If the prebuilt addon is missing,
`createNodeDatachannelProvider().create()` fails loud with an actionable message;
importing the module — and computing the QR fingerprint via `localFingerprint`
/ `ensurePersistentCert` — never touches the binary.

## 1. Add the dependency (`node-datachannel`)

The spike (§11) ran `node-datachannel@0.32`; pin to that line.

Root `package.json`:

```jsonc
"dependencies": {
  // ...
  "node-datachannel": "^0.32.0"
}
```

`node-datachannel` ships a native N-API addon, so it must be allowed to run its
install script. Add it to **both** pnpm build allow-lists (currently
`["electron","esbuild","node-pty"]`):

```jsonc
"pnpm": {
  "allowedBuilds": ["electron", "esbuild", "node-pty", "node-datachannel"],
  "onlyBuiltDependencies": ["electron", "esbuild", "node-pty", "node-datachannel"]
}
```

Install fetches a prebuilt N-API binary via `prebuild-install` (no local C++
toolchain needed in the common case):

```
node-datachannel's install runs `prebuild-install -r napi`
```

If a prebuilt is unavailable for a triple, `prebuild-install` falls back to a
source build (`cmake-js`), which needs CMake + a C++17 toolchain. Keep that path
loud in CI (do not silence install failures) so a missing prebuild is caught at
build time, not at first DTLS connection.

## 2. esbuild — keep it external (do not bundle the addon)

`src/main` bundles to CJS via `build.mjs`. Mark `node-datachannel` **external**
in every build that includes `src/main/webrtc/*` so esbuild never tries to bundle
the `.node` and it resolves from `node_modules` at runtime:

```js
// build.mjs (each relevant esbuild config)
external: [ /* ...existing... */, "node-datachannel" ],
```

The standalone ESM server build already stubs `electron`; `node-datachannel`
needs the same treatment only if a build entry that opens a server-side peer is
compiled without `node_modules` on disk. The lazy renamed-`require` in the
adapter already prevents load-time evaluation, but `external` prevents esbuild
from attempting to inline the binary.

## 3. Electron packaging — rebuild + unpack the `.node`

- **`@electron/rebuild`.** The prebuilt N-API binary is ABI-stable across Node
  versions, but verify it against the bundled Electron's Node ABI in CI; run
  `@electron/rebuild` (a.k.a. `electron-rebuild`) for `node-datachannel` in the
  packaging step if the prebuilt does not match Electron's ABI.
- **asarUnpack.** A native `.node` cannot be loaded from inside the asar virtual
  filesystem. `electron-builder.yml` **already unpacks all of `node_modules`**:

  ```yaml
  asarUnpack:
    - "node_modules/**/*"
  ```

  so `node_modules/node-datachannel/**` (including `build/Release/*.node` /
  `prebuilds/**`) is unpacked as-is — **no new `asarUnpack` entry is required**.
  Verify after a packaged build that the addon resolves from
  `app.asar.unpacked/node_modules/node-datachannel`.

## 4. Mobile — `react-native-webrtc` (bare RN 0.79, no Expo)

Bare RN means **manual** native linking (no Expo config plugin):

- **Dependency:** `react-native-webrtc` in `workspace/apps/mobile/package.json`.
- **iOS:** `cd ios && pod install` (autolinking adds the Pod). Add
  `NSAllowsLocalNetworking` under `NSAppTransportSecurity` in `Info.plist` so the
  loopback panel origin (plan §4) loads; **pure loopback does not trip the iOS
  local-network permission prompt** (plan §12). Minimum iOS deployment target per
  `react-native-webrtc` (currently iOS 13+).
- **Android:** `react-native-webrtc` requires **`minSdkVersion 24`** — bump
  `android/build.gradle` `minSdkVersion` if lower. Enable core-library
  **desugaring** (`coreLibraryDesugaringEnabled true` +
  `coreLibraryDesugaring` dependency) if the toolchain flags it. Add
  `RECORD_AUDIO`/`CAMERA` permissions **only if** media is used — the RPC
  transport opens **data channels only**, so media permissions are not required.

The mobile adapter wraps the WHATWG `RTCPeerConnection` events into the same
`PeerConnectionProvider` shape (`onmessage =` → `onMessage(cb) => unsub`,
WHATWG `RTCDataChannel.send(ArrayBuffer)` ↔ `Uint8Array`). It does **not** use
the persistent-cert path: only the server holds a pinned cert; the client pins
the server's fingerprint from the QR.

## 5. CI prebuild coverage

Validate `node-datachannel` prebuilt resolution (and the source-build fallback)
across all shipped targets so an ARM/mobile-class triple gap (plan §12) is caught
in CI, not in the field:

| OS      | Arch         |
| ------- | ------------ |
| macOS   | x64, arm64   |
| Windows | x64, arm64   |
| Linux   | x64, arm64   |

For each: clean install, assert the `.node` loads
(`require("node-datachannel").PeerConnection` is a function), and run a minimal
two-peer in-process loopback handshake (the §11 spike shape) to confirm DTLS +
data channels work on that triple. A failed prebuild must fail the CI job — never
fall back silently.

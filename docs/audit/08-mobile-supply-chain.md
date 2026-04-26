# Audit 08 — Mobile App, Deep Links & Supply Chain / Build Integrity

**Scope:** `apps/mobile/`, universal links / custom URL scheme handlers, supply chain (`pnpm` workspace, `server-native/`, `.github/`, `electron-builder.yml`, `extension/`, scripts), and runtime / build integrity.
**Branch audited:** `audit` (head `bafe7bc8`).
**Auditor mode:** read-only; ran `pnpm audit --prod`; no source was modified.

---

## Executive summary

The mobile app is a React Native 0.79 / Hermes shell that connects to a NatStack server over an authenticated WebSocket (ws:auth with a shell token), proxies an OAuth flow for Codex / ChatGPT via a `natstack://` custom URL scheme, and optionally hosts per-panel WebViews.

Posture is broadly reasonable — credentials live in `react-native-keychain`, the `natstack://connect` deep-link parser rejects untrusted cleartext hosts and requires an Alert-level user confirmation, and the WebSocket accepts a shell (not admin) token. However, there are several concrete issues that should block a production / TestFlight release:

1. **(Critical) iOS ATS is fully disabled in the shipped `Info.plist`** — `NSAllowsArbitraryLoads = true` with no scoped exceptions. Release builds on iOS will accept any-host cleartext HTTP. The Android side, by contrast, enforces HTTPS by default in release with a narrow exception list — so the two platforms have materially different security postures.
2. **(Critical) Runtime regression: `setupOAuthHandler` is imported by `App.tsx` but the file `src/services/oauthHandler.ts` does not exist in the repo.** Mobile app boot will fail at import time. This also means whatever deep-link validation the OAuth callback handler was supposed to do — state check, origin check, routing to the right pending flow — is not present in the checked-in code and is on the hot path for the OAuth code exchange.
3. **(High) Supply-chain: one Critical (protobufjs <7.5.5 arbitrary code execution via `@google/genai`) and 9 High advisories in the production dependency tree (`pnpm audit --prod`).** All reach the desktop / server build, not the mobile RN bundle, but they ship inside the Electron app.
4. **(High) Universal-link entitlements and AndroidManifest intent-filter still contain `PLACEHOLDER_UNIVERSAL_LINK_DOMAIN`.** If the placeholder ships as-is, domain verification is effectively unbound; any app claiming the unregistered placeholder hostname can intercept the OAuth callback. The custom-scheme (`natstack://`) callback already has known replay risks (see §B.2).
5. **(High) Panel WebView exposes a host bridge (`window.__natstackShell`, `__natstackElectron`, and `__natstackMobileHost`) *without* origin validation on `onMessage`.** Any page the WebView navigates to, including a hostile one loaded via `createBrowserPanel`, can invoke sensitive bridge methods (`setStateArgs`, `closeChild`, `focusPanel`, `createBrowserPanel`, `openExternal`). Mitigated in practice by the default subdomain isolation, but not enforced.
6. **(High) `react-native-keychain.setGenericPassword()` is used without `ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY`** for the shell token. Default accessibility on iOS includes post-first-unlock and is backup-eligible; the shell token can appear in an iCloud keychain / iTunes backup.
7. **(High) `allowFileAccess` is set on every `<WebView>`** (mobile panel). Combined with permissive mixed-content mode and no explicit `originWhitelist`, this widens the attack surface for a redirected navigation.
8. **(Moderate) `ws:auth` sends the long-lived shell token as the first frame on every WebSocket connection; it is also passed through `natstack://connect?token=…` as a raw query-string param**, which may be logged by the OS recent-intents surface.
9. **(Moderate) `android:allowBackup="false"`** — good — but `android:usesCleartextTraffic` is not explicitly set; `network_security_config.xml` is the right place, and the cleartext exceptions include `includeSubdomains="true"` for `ts.net` which covers any tailnet (fine) but not `10.0.2.2` subdomains (not relevant). The `debug/res/xml/network_security_config.xml` permits cleartext globally — fine for debug but worth noting the risk of a misbuild.
10. **(Moderate) No code signing / integrity checks on the GitHub Actions APK artifact.** The release workflow uploads the raw APK to a GH Release using `softprops/action-gh-release@v2` pinned to a major tag (not SHA). A compromised action major tag could silently add a payload to the release artifact. No SLSA provenance or reproducible build.
11. **(Moderate) `better-sqlite3` native addon is installed via `npm install` in `server-native/` with an unconstrained postinstall chain (`prebuild-install` ⇒ HTTPS download of a `.tar.gz`).** It's on the supply-chain hot path; also the vulnerable `tar` chain (<7.5.11) lives here.
12. **(Low) `@workspace/agentic-chat` and sibling workspace packages pin `version` fields like `0.1.0-git.7429c90`** — suggests versions are minted from git short-SHA. This is fine internally, but some packages (e.g. `@natstack/rpc`) include a specific hash (`0.1.0-b15c87a08b3b`) that can drift silently.

---

## Mobile threat model (brief)

**Assets:** the shell token (grants "shell" caller-kind on server), Codex OAuth refresh token (stored on the server after exchange, but the authorization `code` flies through the deep link), panel state / panel-init payloads (may include secrets pushed from server).

**Adversaries considered:**

- A malicious app on the same device that can fire `natstack://` intents and can read unsigned URL schemes (Android).
- A MitM on the local network (LAN / Wi-Fi) or ISP path when the user connects to a remote server.
- A hostile web page the user has navigated to inside the in-app WebView, including an `onOpenWindow` redirect.
- A compromised transitive npm/pnpm dependency (supply chain).
- A compromised GitHub Action tag (release-build supply chain).

**Trust boundaries:**

- `natstack://connect` deep links are *untrusted* (user-confirmed via `Alert`).
- `natstack://auth/callback` and `natstack://oauth-callback` deep links are *not* user-confirmed and route by OAuth `state`.
- The WebSocket to `shellClient` is authenticated by the shell token; token is sent as first frame in plaintext (but inside TLS when `wss://`).
- The WebView → host bridge (postMessage) is *not* origin-checked today (see F-5).

---

## Supply-chain inventory (risky / notable)

### Production vulnerabilities (pnpm audit --prod)

| Sev | Package | Path | Advisory |
|-----|---------|------|----------|
| critical | protobufjs <7.5.5 | `.>@mariozechner/pi-ai>@google/genai>protobufjs` | GHSA-xq3m-2v4x-88gg (RCE on malicious protobuf input) |
| high | tar <7.5.11 | `.>@npmcli/arborist>@npmcli/run-script>node-gyp>tar` | Multiple GHSAs — path traversal, symlink poisoning, hardlink escape |
| high | basic-ftp <5.3.0 | `.>@mariozechner/pi-ai>proxy-agent>pac-proxy-agent>get-uri>basic-ftp` | GHSA-6v7q-wjvx-w8wg + siblings (CRLF injection, DoS) |
| moderate | hono <4.12.14 | `.>@modelcontextprotocol/sdk>hono` | Six advisories (middleware bypass, path traversal in toSSG, jsx attribute HTML injection) |
| moderate | @hono/node-server <1.19.13 | `.>@modelcontextprotocol/sdk>@hono/node-server` | GHSA-92pp-h63x-v22m |
| moderate | yaml <2.8.3 | `workspace__packages__playwright-core>yaml` | GHSA — stack overflow on deeply nested YAML |
| moderate | fast-xml-parser <5.7.0 | reachable from `apps/mobile` via `@react-native-community/cli` *and* from `.>@mariozechner/pi-ai>@aws-sdk/...` | XML builder injection |
| low | diff 7.x | `packages__git>diff` | GHSA-73rr-hh4g-fpgx (DoS) |

**Totals: 1 critical, 9 high, 10 moderate, 1 low = 21 vulnerabilities in the prod tree.**

### Install-time lifecycle scripts

- Root `package.json:12` — `postinstall` runs `electron-rebuild -f`. Best-effort `try…catch`, safe.
- `server-native/` has no explicit postinstall script, but `better-sqlite3` transitively runs `prebuild-install` (downloads a prebuilt binary over HTTPS from GitHub releases). This is listed in root `package.json` under `pnpm.allowedBuilds` / `onlyBuiltDependencies` — good hygiene (only `electron`, `esbuild`, `node-git-server`, `better-sqlite3` are allowed to run install scripts).
- The mobile app's own `apps/mobile/package.json` has **no** postinstall / preinstall scripts.
- No git-URL deps, no `npm:` protocol deps, no `file:` deps in any `package.json` I checked.

### GitHub Actions / CI

`.github/workflows/build-mobile.yml` uses:

- `actions/checkout@v4` (ok)
- `actions/setup-java@v4` (ok)
- `actions/setup-node@v4` (ok)
- `pnpm/action-setup@v4` (ok)
- `actions/cache@v4` (ok)
- `android-actions/setup-android@v3` (ok)
- `actions/upload-artifact@v4` (ok)
- `softprops/action-gh-release@v2` — **pinned to major, not SHA**. If the v2 tag is moved (has happened with other widely-used actions in the past, e.g. tj-actions/changed-files), the release artifact that ships to users could be modified.

PRs that change `apps/mobile/**` trigger the workflow (no `pull_request_target`, so the pwn-request pattern is not present here). Secrets (`ANDROID_KEYSTORE_*`) are only referenced on push/tag paths — workflow is gated by `actions/checkout@v4` default which refuses to check out PR HEAD for forks with secrets, so the keystore is not exfiltratable from a fork PR. Good.

### Auto-update mechanism (desktop)

`electron-builder.yml` configures `publish: { provider: github, owner: werg, repo: natstack }`. `electron-updater` verifies the GH release using the file's SHA512 that is embedded in `latest.yml` signed against the publisher's GPG only if `releaseType` is configured with it. The current config does **not** specify `verifyUpdateCodeSignature` overrides — updater falls back to code-signature verification on macOS and signature verification on Windows. On **Linux AppImage / deb**, auto-update code-signature verification is not enforced by electron-updater; a compromised GH release would be installed.

### Committed secrets

- No `.env*` found in tracked files; `.gitignore` correctly excludes `.env`, `.env.local`, `.env.*.local`.
- No `*.pem`, `credentials.json`, or keystore files were located outside expected places.
- The root `.npmrc` is `node-linker=hoisted` only — no auth tokens.

---

## Severity-ordered findings

Severity scale: Critical / High / Medium / Low / Informational. Each finding lists *File:Line*, an *Exploit path*, and *Remediation*.

### [C-1] iOS ATS wildcard disables HTTPS enforcement app-wide

- **File:** `apps/mobile/ios/NatStack/Info.plist:58-62`
- **Snippet:**
  ```xml
  <key>NSAppTransportSecurity</key>
  <dict>
      <key>NSAllowsArbitraryLoads</key>
      <true/>
  </dict>
  ```
- **Exploit path:** a MitM attacker on the user's network (coffee-shop Wi-Fi, ISP, compromised DNS) can downgrade any URL the app connects to — shell WebSocket, WebView panel loads, OAuth authorize URL if it was HTTP — to cleartext. The code-side deep-link validation in `deepLinkConnect.ts` (§F-H-2 below) requires `https://` for non-LAN/Tailscale hosts, but the *network stack itself* is not enforcing that for already-authenticated connections or for WebView navigations to arbitrary URLs.
- **Severity:** Critical (iOS) — platform-level mitigation is disabled for every network call made by the app, including the React Native Metro dev server bundle fetch if shipped.
- **Remediation:** Mirror the Android `network_security_config.xml` approach — remove `NSAllowsArbitraryLoads`, and for dev use `NSAllowsLocalNetworking` (sufficient for loopback / LAN; released in iOS 10) plus scoped `NSExceptionDomains` for `ts.net` (include subdomains, `NSIncludesSubdomains=YES`). Gate `NSAllowsArbitraryLoads` behind the debug config only (Xcode build setting) or via a Debug-only `Info.plist` variant.

### [C-2] Missing `oauthHandler.ts` — app fails to import; OAuth deep-link handler absent

- **File:** `apps/mobile/App.tsx:9` (`import { setupOAuthHandler } from "./src/services/oauthHandler";`), but there is **no** `apps/mobile/src/services/oauthHandler.ts`.
- **Verified via:** `ls apps/mobile/src/services/` — all services present *except* `oauthHandler.ts`. Referenced in 4 other places (`authCallbackRegistry.ts:9-10`, `codexAuthFlow.ts:6`, `Info.plist:39`, `AndroidManifest.xml:29`).
- **Exploit path:**
  - Direct: Metro will fail to resolve the import; the app will not boot on a clean workspace.
  - Assuming a local scratch copy exists on a developer machine (that's why CI still "works"), the OAuth callback handler was supposed to:
    - Parse `natstack://auth/callback?code=…&state=…` inbound URLs.
    - Look up the pending flow by `state` via `consumePendingFlow`.
    - Validate `state` matches.
    Without a checked-in implementation, nothing dispatches to `consumePendingFlow()`, so any `registerPendingFlow` entry either times out after 10 minutes (`codexAuthFlow.ts:18`) or is resolved by some code path not reviewed here.
  - If the missing handler does *not* cross-check the callback URL's scheme/host/path against `REDIRECT_URI` (`natstack://auth/callback`), any `natstack://...?code=…&state=<guessed>` from any other installed app can pass a malicious `code` into the PKCE exchange. State is 32+ bytes of entropy so it's not practically guessable — but there is no second line of defense.
- **Severity:** Critical for release-blocking (build-broken state), High for residual design risk.
- **Remediation:** Check the file in — it clearly exists in someone's working copy. The implementation MUST:
  1. Only resolve pending flows when `url.protocol === "natstack:" && url.pathname` matches the redirect URI path.
  2. Never log `code`, `state`, or the raw URL.
  3. Drop (not time-out) any pending flow whose `state` is not present in the registry, so a replayed callback cannot resurrect a stale flow.

### [C-3] `protobufjs` RCE in production dependency tree

- **Source:** `pnpm audit --prod` — `.>@mariozechner/pi-ai>@google/genai>protobufjs` (<7.5.5).
- **Exploit path:** if `@google/genai` is invoked with attacker-controlled protobuf bytes (e.g. a tampered proxy response), arbitrary code executes in the Node / Electron process. This is reachable only when the user enables the Gemini provider via pi-ai. On desktop Electron, this is the main process — full host compromise.
- **Remediation:** pin `protobufjs >=7.5.5` via `pnpm.overrides`, or bump `@mariozechner/pi-ai` / `@google/genai` to a version that carries the fix.

### [H-1] Universal-link entitlements still contain `PLACEHOLDER_UNIVERSAL_LINK_DOMAIN`

- **Files:**
  - `apps/mobile/ios/NatStack/NatStack.entitlements:7-8` — `applinks:PLACEHOLDER_UNIVERSAL_LINK_DOMAIN`, `webcredentials:PLACEHOLDER_UNIVERSAL_LINK_DOMAIN`.
  - `apps/mobile/android/app/src/main/AndroidManifest.xml:44` — `<data android:host="PLACEHOLDER_UNIVERSAL_LINK_DOMAIN" ...>`.
- **Exploit path:** if the placeholder string reaches a release build, the app claims a non-existent domain; `autoVerify="true"` on Android will fail silently and the intent filter will still register as a possible handler (because the host comparison is per-string). Any adversary able to host `apple-app-site-association` or `.well-known/assetlinks.json` at literally `PLACEHOLDER_UNIVERSAL_LINK_DOMAIN.com` (registrable — it was not at audit time, but once the app ships the name is discoverable) can intercept the `/oauth/callback` universal-link flow.
- **Severity:** High.
- **Remediation:** make the build fail fast if the placeholder is present (Gradle / Xcode build script that greps and exits on match); parameterise via a build config file that is populated during the signed release workflow from a repo secret.

### [H-2] `natstack://oauth-callback` / `natstack://auth/callback` has no origin proof and routes purely by state

- **Files:** `apps/mobile/src/services/authCallbackRegistry.ts` (the pending-flow map), `codexAuthFlow.ts:23-43` (state is the routing key).
- **Exploit path:** on Android, custom URL schemes are not exclusive — any installed app can fire a `natstack://auth/callback?...` intent. The `state` parameter is generated inside the app and never leaves it, so an adversary cannot normally know it. But:
  - If `state` leaks (verbose logs on a shared device, bug reporter screenshot, Sentry breadcrumb), the OAuth `code` submitted by the attacker will be accepted.
  - The missing `oauthHandler.ts` (C-2) makes this provably worse because we can't even confirm the state check is performed before calling `consumePendingFlow`.
- **Severity:** High.
- **Remediation:** use a *universal link / App Link* (HTTPS) for OAuth callbacks — the app will only receive them if domain verification succeeds. The intent filter for `applinks:` is the hardening. Keep `natstack://` for `/connect` (user-confirmed onboarding) but retire it for OAuth.

### [H-3] WebView → host bridge lacks origin validation

- **File:** `apps/mobile/src/components/PanelWebView.tsx:238-264` (handleMessage) and `buildBridgeBootstrapScript` (injects `__natstackShell`).
- **Snippet:**
  ```tsx
  const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
      if (!managed || !onBridgeCall) return;
      try {
        const message = JSON.parse(event.nativeEvent.data) as { … };
        if (!message.__natstackBridge || !message.id || !message.method) return;
        …
        const result = await onBridgeCall(panelId, message.method, message.args ?? []);
  ```
  No origin / URL check on the message source. The `managed` gate is controlled by `MainScreen.tsx` based on whether the panel source starts with `browser:` — *at initial load*. A redirect inside the same WebView (handled by `handleShouldStartLoad` at line 210) will navigate the same WebView to an arbitrary origin while `managed === true`, so messages from the new origin are still accepted and dispatched to `onBridgeCall`.
- **Bridge surface:** `setStateArgs`, `closeSelf`, `closeChild`, `focusPanel`, `createBrowserPanel`, `openDevtools`, `openFolderDialog`, `openExternal`, `navigate`, `goBack`, `goForward`, `reload`, `stop`, `addEventListener`, `removeEventListener`, plus `auth.startOAuthLogin` / `auth.listProviders` / `auth.logout` (via `bridgeAdapter.ts:62-68`).
- **Exploit path:** a managed panel that navigates to an attacker-controlled origin — e.g. via an `<iframe>`, a `fetch→meta-refresh`, or even via `setSupportMultipleWindows` in combination with `onOpenWindow` — can reach from JS `window.ReactNativeWebView.postMessage({__natstackBridge:true, method:"createBrowserPanel", args:["https://evil/"]})` to open new panels, `openExternal` phishing URLs, or trigger Codex OAuth (`auth.startOAuthLogin`).
  - Note `onOpenWindow` (PanelWebView.tsx:340-350) explicitly opens new URLs in new managed panels if they start with `http(s)://`. Combined with no origin check on `handleMessage`, one hostile ad frame could chain into a bridge call.
- **Severity:** High.
- **Remediation:**
  1. Maintain a "currently loaded origin" state per WebView (from `handleNavigationStateChange`), and in `handleMessage` reject messages unless the origin is a managed subdomain of the shell host (`*.<externalHost>`).
  2. Tighten `createBrowserPanel` on mobile to require a user tap / long-press, not an unattended postMessage.
  3. Gate `auth.startOAuthLogin` to only managed panels (non-browser source).

### [H-4] Shell token accessibility in iOS keychain not pinned

- **File:** `apps/mobile/src/services/auth.ts:26-30`
  ```ts
  await Keychain.setGenericPassword(serverUrl, token, {
    service: KEYCHAIN_SERVICE,
  });
  ```
  No `accessible` / `accessControl`. Default is `AccessibleWhenUnlocked` (iOS) which *is* included in encrypted iTunes backups unless `…ThisDeviceOnly` variants are selected.
- **Exploit path:** user backs up their phone; backup becomes a credential that can be restored to an attacker-controlled device, yielding a working shell token. Not a remote-exploit but a common supply-chain-over-iCloud issue.
- **Severity:** High.
- **Remediation:** use `accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY` (for the device-local token) and optionally require `accessControl: ACCESS_CONTROL.BIOMETRY_ANY` to gate read on Face/Touch ID. The biometric-lock service at `biometricAuth.ts:78-80` correctly uses `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`; apply the same to the real token.

### [H-5] `allowFileAccess` is enabled on every mobile panel WebView

- **File:** `apps/mobile/src/components/PanelWebView.tsx:355`.
- **Snippet:** `<WebView … allowFileAccess … />`
- **Exploit path:** in concert with H-3 (bridge without origin check), a hostile page loaded via `createBrowserPanel` can fetch `file://` URIs (Android mainly, iOS less so) — `/proc/self/status`, app sandbox files, etc. — and exfiltrate via `postMessage`.
- **Severity:** High (needs H-3 to escalate) / Medium standalone.
- **Remediation:** remove `allowFileAccess`; it is defaulted to `false` for good reason. If the app needs to load local assets, use `source={ require(...) }` or `file:///android_asset/...` explicitly with `allowFileAccessFromFileURLs=false, allowUniversalAccessFromFileURLs=false`.

### [H-6] Push device ID persisted in keychain without device-only accessibility

- **File:** `apps/mobile/src/services/pushNotifications.ts:44-49`
  ```ts
  await Keychain.setGenericPassword("push-device-id", cachedDeviceId, {
    service: "natstack-push-device-id",
  });
  ```
- **Same issue as H-4.** Value is low-sensitivity (a per-device string) but it's linked to the server-side push registration; cloning the device ID lets another device receive push notifications addressed to the original. Pin `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.

### [H-7] Panel store persistence uses keychain for bulk JSON

- **File:** `apps/mobile/src/shellCore/panelStoreAsync.ts:184-201` — stores panel tree as one big JSON blob inside the keychain.
- **Observation:** Keychain is a small, encrypted KV store not designed for potentially-large opaque blobs. iOS enforces implementation-defined size limits (a few KB per item is the reliable number); larger values can silently fail to round-trip on some iOS versions. This is an integrity / denial-of-availability concern, not a confidentiality one.
- **Severity:** High for reliability, **Medium** for security (data-at-rest exposure of panel state if the blob is big enough to cause silent truncation → state divergence → session re-auth loop).
- **Remediation:** use `@react-native-async-storage/async-storage` for panel state, keep only the shell token in keychain.

### [H-8] CI release uses floating major-tagged action for artifact publishing

- **File:** `.github/workflows/build-mobile.yml:110`
- **Snippet:** `uses: softprops/action-gh-release@v2`
- **Exploit path:** if the `v2` tag on softprops/action-gh-release is force-moved to a malicious commit (this has happened to widely-used actions — tj-actions/changed-files March 2025), the next release run will execute attacker code with a `GITHUB_TOKEN` that has `contents: write` on the release. The keystore password is *also* exposed in the same job's env, so a tag-moved action could exfiltrate the signing key.
- **Severity:** High.
- **Remediation:** pin by full commit SHA: `uses: softprops/action-gh-release@<40-char-sha>`. Apply the same discipline to `actions/checkout`, `pnpm/action-setup`, `android-actions/setup-android`, `actions/cache`, `actions/upload-artifact`, `actions/setup-node`, `actions/setup-java`. Enable Dependabot for action updates so SHAs can be refreshed safely.

### [H-9] Release APK signing env variables are echoed into `gradle.properties`

- **File:** `.github/workflows/build-mobile.yml:85-95`.
- **Snippet:**
  ```sh
  echo "RELEASE_STORE_PASSWORD=$KEYSTORE_PASSWORD" >> apps/mobile/android/gradle.properties
  echo "RELEASE_KEY_PASSWORD=$KEY_PASSWORD" >> apps/mobile/android/gradle.properties
  ```
- **Exploit path:** `gradle.properties` is included in the workspace for the duration of the run. Any action running afterwards in the same job (including a compromised upload-artifact — see H-8) can read the plaintext passwords. Also, `./gradlew` runs with GRADLE_OPTS / env unrestricted; a build-gradle plugin loaded transitively can `System.getenv()` or `File.read("gradle.properties")`.
- **Severity:** High.
- **Remediation:** prefer `-P` flags on the gradle CLI (`./gradlew assembleRelease -PRELEASE_STORE_PASSWORD="$PW" …`), and clean up the keystore file and any gradle.properties writes in an `always()` post-step. Consider GitHub OIDC + cloud-KMS signing instead of a checked-out keystore.

### [M-1] WebSocket accepts raw token as first in-band frame, no challenge-response

- **File:** `apps/mobile/src/services/mobileTransport.ts:224-227`
- **Snippet:** `this.ws!.send(JSON.stringify({ type: "ws:auth", token: this.config.shellToken }));`
- **Observation:** standard for NatStack's protocol. Over TLS (`wss://`) the token is not on the wire, but if a cleartext URL slips through (see C-1, and the dev-friendly cleartext exceptions in `deepLinkConnect.ts`), the token is recoverable on a LAN MitM. There is also no server-side nonce / challenge; a replay of the `ws:auth` frame from a pcap would authenticate. (This is a server-side mitigation design choice, not solvable in the mobile client alone.)
- **Remediation:** document in the server-side audit that `wss://` is required for any non-LAN deployment; consider HMAC-of-nonce-with-shell-token instead of token-as-bearer.

### [M-2] `natstack://connect?url=&token=` passes shell token in URL

- **File:** `apps/mobile/src/services/deepLinkConnect.ts:74-75`.
- **Observation:** the token is a URL query param. When the deep link is fired via `Linking` on Android, the intent ends up in the `am start` history / logcat in some vendor ROMs; on iOS, Universal Link handling logs the URL in Shortcuts history and the "recents" activity stream. The confirmation dialog (`LoginScreen.tsx:35-44`) helps, but the token text itself was already logged by the time the dialog renders.
- **Remediation:** move the token to a POST body / a one-time-code (`exchange?code=...` round-trip to the server) rather than putting the long-lived bearer on the URL. Short-term: scrub the token out of any production log sinks. Also recommend the onboarding flow use a QR that embeds a short-lived `tokenExchangeCode` which the app POSTs back to retrieve the real token.

### [M-3] `parseConnectDeepLink` allowlist is permissive for shared-tenant networks

- **File:** `apps/mobile/src/services/deepLinkConnect.ts:29-60`.
- **Observation:** `isPrivateIPv4` accepts **all** RFC1918 addresses, and `isTailscaleIPv4` accepts the full CGNAT /10. If a user is on a corporate network that NATs to `10.0.0.0/8`, a malicious co-tenant on the same LAN can serve a `natstack://connect?url=http://10.1.2.3:3000&token=…` link; the user still sees a confirmation (good), but the dialog (`LoginScreen.tsx:36-41`) shows only the URL, no fingerprint, no warning that the token would be sent cleartext to a LAN address.
- **Remediation:** strengthen the dialog to highlight `http://` explicitly ("This link uses unencrypted HTTP — only continue on a private network you trust"). Also consider dropping the `isPrivateIPv4` default acceptance and requiring an explicit opt-in per host.

### [M-4] `mixedContentMode="compatibility"` on mobile panels

- **File:** `apps/mobile/src/components/PanelWebView.tsx:353`.
- **Observation:** `"compatibility"` on Android allows HTTPS pages to load HTTP resources; `"never"` is the secure default.
- **Remediation:** set `mixedContentMode="never"`; if a dev panel truly needs mixed content, toggle via `__DEV__`.

### [M-5] No code signing verification on Linux AppImage / deb auto-update

- **File:** `electron-builder.yml:114-119`. electron-updater Linux path does not verify code signatures.
- **Remediation:** ship a detached minisign / gpg signature with the AppImage and verify before applying; or restrict Linux auto-update to checksum-only and surface the hash to the user.

### [M-6] Extension `manifest.json` claims `debugger` permission

- **File:** `extension/manifest.json:11`.
- **Observation:** `debugger` is a very powerful Chrome permission (full CDP over any attached tab). Combined with `tabs` and `nativeMessaging` (native host `com.natstack.connector`), a compromised extension update can attach to any tab and read/modify DOM/requests. Reviewed by the Chrome Web Store when published, but the `key` field in the manifest pins the extension ID — anyone with the matching private key could publish an update.
- **Severity:** Medium (principle of least privilege).
- **Remediation:** confirm `debugger` is strictly required (looks like it is, for CDP bridge). Document the invariant that the extension ID is bound by the pinned `key`, and ensure the publisher private key is in a hardware token.

### [M-7] `hono` multi-moderate advisories reachable via `@modelcontextprotocol/sdk`

- **Source:** audit. Hono is embedded in the MCP SDK for its HTTP server; the NatStack app runs MCP internally. Path-traversal and cookie-handling bypass issues can be chained if the MCP HTTP server is exposed beyond loopback.
- **Remediation:** pin `hono >=4.12.14` via `pnpm.overrides`.

### [M-8] `.nvmrc` pins node version only to 20 without exact patch

- **File:** `.nvmrc` (3 bytes in `ls -la` listing).
- **Observation:** CI uses `node-version-file: .nvmrc`. If `.nvmrc` is floating (`20`), CI picks latest 20.x; fine operationally but makes builds non-reproducible.
- **Remediation:** pin to exact (`20.17.0`). Keep a changelog entry.

### [L-1] TypeScript config sets `skipLibCheck: true`

- **Files:** `tsconfig.json:21`, `apps/mobile/tsconfig.json:16`.
- **Observation:** this is standard practice but does mean malformed type declarations from dependencies don't fail the build. Informational only; keep.

### [L-2] `react-native-reanimated/plugin` is loaded in `babel.config.js`

- **File:** `apps/mobile/babel.config.js`.
- **Observation:** This plugin must be listed *last* (required by reanimated). The order here `["@babel/plugin-transform-export-namespace-from", "react-native-reanimated/plugin"]` is correct. Informational.

### [L-3] `react-native-url-polyfill/auto` load order

- **File:** `apps/mobile/index.js:8`.
- **Observation:** `react-native-get-random-values` loads first (line 4) — correct. Then URL polyfill. Reasonable.

### [L-4] `react` overrides to `19.0.0` in root

- **File:** `package.json:69-72` (`pnpm.overrides`).
- **Observation:** this is a functional pin to keep mobile RN happy; be aware that any package upstream that requires `react@^19.2.0` will be downgraded, which can mask hooks-API differences. Informational.

### [L-5] `android:launchMode="singleTask"` is correct for deep-link routing

- **File:** `AndroidManifest.xml:19`. This is the right choice for deep-link behavior (otherwise every intent creates a new MainActivity). Informational — do not change.

### [L-6] `server-native/package-lock.json` is intentionally committed

- **File:** `.gitignore:2-4` — `server-native/package-lock.json` is whitelisted (`!` pattern).
- **Observation:** good hygiene — the native-build lockfile is pinned while the root uses `pnpm-lock.yaml`. No action.

---

## Runtime integrity

- `tsconfig.json:13` — `"strict": true` is set; `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature` all enabled. **Good.**
- Only one `@ts-ignore` / `eslint-disable` in the mobile tree (`firebase-messaging.d.ts:9`, scoped and justified).
- ESLint config (`eslint.config.js`) extends `typescript-eslint/configs/strict` (sane). `@typescript-eslint/no-non-null-assertion` demoted to warn — standard prototype-era compromise.
- No committed `.env`, `.npmrc` tokens, or keystore files.
- `pretest` / `posttest` scripts call `npm rebuild better-sqlite3` and `electron-rebuild` — these are idempotent and safe; they are not postinstall hooks.

---

## Remediation priority (suggested)

| Priority | Action |
|---------|--------|
| P0 (release-blocking) | C-1 (iOS ATS), C-2 (missing oauthHandler.ts), C-3 (protobufjs CVE), H-1 (placeholder universal-link domain), H-9 (Gradle pw leak) |
| P1 (this sprint) | H-2 (OAuth custom-scheme hardening), H-3 (WebView bridge origin check), H-4 (keychain accessibility), H-5 (`allowFileAccess` removal), H-8 (CI action SHA pinning) |
| P2 | M-1..M-8 (hono / tar / basic-ftp overrides, token-in-URL, mixedContentMode, Linux update signature, extension permission audit) |
| P3 | L-1..L-6 cosmetic / hygiene |

---

## Appendix A — Files reviewed

Mobile app:

- `/home/werg/natstack/apps/mobile/App.tsx`
- `/home/werg/natstack/apps/mobile/index.js`
- `/home/werg/natstack/apps/mobile/app.json`
- `/home/werg/natstack/apps/mobile/babel.config.js`
- `/home/werg/natstack/apps/mobile/metro.config.js`
- `/home/werg/natstack/apps/mobile/package.json`
- `/home/werg/natstack/apps/mobile/tsconfig.json`
- `/home/werg/natstack/apps/mobile/ios/NatStack/Info.plist`
- `/home/werg/natstack/apps/mobile/ios/NatStack/NatStack.entitlements`
- `/home/werg/natstack/apps/mobile/ios/NatStack/AppDelegate.mm`
- `/home/werg/natstack/apps/mobile/ios/NatStack/main.m`
- `/home/werg/natstack/apps/mobile/ios/Podfile`
- `/home/werg/natstack/apps/mobile/android/app/src/main/AndroidManifest.xml`
- `/home/werg/natstack/apps/mobile/android/app/src/main/res/xml/network_security_config.xml`
- `/home/werg/natstack/apps/mobile/android/app/src/debug/res/xml/network_security_config.xml`
- `/home/werg/natstack/apps/mobile/android/app/build.gradle`
- `/home/werg/natstack/apps/mobile/android/app/src/main/java/com/natstack/mobile/MainActivity.kt`
- `/home/werg/natstack/apps/mobile/android/app/src/main/java/com/natstack/mobile/MainApplication.kt`
- `/home/werg/natstack/apps/mobile/src/services/auth.ts`
- `/home/werg/natstack/apps/mobile/src/services/biometricAuth.ts`
- `/home/werg/natstack/apps/mobile/src/services/authCallbackRegistry.ts`
- `/home/werg/natstack/apps/mobile/src/services/codexAuthFlow.ts`
- `/home/werg/natstack/apps/mobile/src/services/credentialConsent.ts`
- `/home/werg/natstack/apps/mobile/src/services/deepLinkConnect.ts`
- `/home/werg/natstack/apps/mobile/src/services/mobileTransport.ts`
- `/home/werg/natstack/apps/mobile/src/services/panelUrls.ts`
- `/home/werg/natstack/apps/mobile/src/services/pushNotifications.ts`
- `/home/werg/natstack/apps/mobile/src/services/shellClient.ts`
- `/home/werg/natstack/apps/mobile/src/services/bridgeAdapter.ts`
- `/home/werg/natstack/apps/mobile/src/components/LoginScreen.tsx`
- `/home/werg/natstack/apps/mobile/src/components/BiometricLockScreen.tsx`
- `/home/werg/natstack/apps/mobile/src/components/PanelWebView.tsx`
- `/home/werg/natstack/apps/mobile/src/components/MainScreen.tsx`
- `/home/werg/natstack/apps/mobile/src/components/ConsentSheet.tsx`
- `/home/werg/natstack/apps/mobile/src/hooks/useBiometricLock.ts`
- `/home/werg/natstack/apps/mobile/src/shellCore/panelStoreAsync.ts`
- `/home/werg/natstack/apps/mobile/src/nodeShims/crypto.ts`
- `/home/werg/natstack/apps/mobile/src/nodeShims/fs.ts`
- `/home/werg/natstack/apps/mobile/src/types/firebase-messaging.d.ts`

Supply chain / build:

- `/home/werg/natstack/package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`
- `/home/werg/natstack/electron-builder.yml`
- `/home/werg/natstack/build-resources/entitlements.mac.plist`
- `/home/werg/natstack/build.mjs` (first 60 lines)
- `/home/werg/natstack/scripts/verify-native-modules.mjs`
- `/home/werg/natstack/scripts/dev-mobile-server.mjs`
- `/home/werg/natstack/.github/workflows/build-mobile.yml`
- `/home/werg/natstack/extension/manifest.json`, `background.js` (first 80 lines)
- `/home/werg/natstack/server-native/package.json`
- `/home/werg/natstack/packages/*/package.json` (all)
- `/home/werg/natstack/workspace/packages/*/package.json` (sampled)
- `/home/werg/natstack/tsconfig.json`
- `/home/werg/natstack/eslint.config.js`

## Appendix B — `pnpm audit --prod` raw result (summary)

```
21 vulnerabilities found
Severity: 1 low | 10 moderate | 9 high | 1 critical
```

Complete per-advisory table in the "Supply-chain inventory" section above.

## Appendix C — Notable non-findings / deliberately scoped out

- `MainScreen.tsx` and panel-tree logic: briefly skimmed, no additional findings beyond the WebView bridge issue called out in H-3.
- `AsyncStorage` vs Keychain: no AsyncStorage usage was found; all persistence goes through `react-native-keychain`, which is the stricter choice (aside from the sizing concern in H-7).
- Deeplink open-redirect via `openExternal` bridge call: `openExternal` passes a string to `Linking.openURL`. Without the H-3 origin fix, a hostile panel can trigger arbitrary URL opens — noted under H-3's severity.
- Pull-request pwn-request: not applicable; workflow uses `on: push / pull_request` (not `pull_request_target`), and secrets are not exposed to fork PRs by GitHub's default.
- Cert pinning: none implemented (expected trade-off for a self-hosted server model, but worth documenting).

---

*End of audit 08.*

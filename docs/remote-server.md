# Remote Server Mode

NatStack supports a **remote server mode** where the Electron frontend connects to a NatStack server running on a different machine (or in a container, VM, etc.) instead of spawning a local server child process.

## Architecture

```
Normal (local) mode:
  Electron app  ──spawns──>  server child process (localhost)

Remote mode:
  Electron app  ──WebSocket──>  standalone natstack-server (remote host)
```

In remote mode, all server-side operations (build, git, workerd, panel HTTP, AI, etc.) run on the remote server. The Electron app acts as a thin shell that renders panels and forwards all RPC calls over a WebSocket connection to the gateway.

Panel URLs are now path-based on the managed host, with storage isolation
coming from the panel `contextId` mapped to an Electron session partition. That
means remote mode no longer depends on wildcard DNS for `ctx-...` subdomains.

Remote panel mode does still require a trustworthy browser origin. In practice:

- Use `https://...` for any non-loopback remote server.
- Plain `http://...` is only supported for loopback hosts such as
  `localhost`, `*.localhost`, `127.0.0.1`, or `::1`.
- If you point `NATSTACK_REMOTE_URL` at a non-loopback `http://` origin, the
  client now fails fast on startup instead of loading panels with a reduced web
  API surface.

## Setting Up the Server

### 1. Start the server in standalone mode

```bash
pnpm server \
  --workspace my-workspace \
  --host my-server.example.com \
  --serve-panels \
  --init
```

In a source checkout, use dev mode when you want `--init` to create the managed
workspace from the repo's checked-in `workspace/` template instead of a bare
workspace:

```bash
pnpm server:dev \
  --workspace my-workspace \
  --host my-server.example.com \
  --serve-panels \
  --init
```

`pnpm server:dev` sets `NODE_ENV=development` before launching `dist/server.mjs`.
That matters for local smoke tests from a repo checkout because a freshly
initialized managed workspace will include `panels/chat` and the other built-in
units. Without it, first-run `--init` falls back to `workspace-template/` and
may create a bare workspace if that template is not present.

Use `--help` for a full list of options:

```bash
pnpm server --help
```

The server will print its gateway URL and admin token on startup:

```
natstack-server ready:
  Gateway:     https://my-server.example.com:38291
  Git:         (via gateway /_git/)
  Workerd:     (via gateway /_w/)
  RPC:         wss://my-server.example.com:38291/rpc
  Admin token: a1b2c3d4e5...
  Token file:  /path/to/workspace/state/admin-token
```

### 2. Server CLI flags

| Flag | Env var | Description |
|------|---------|-------------|
| `--workspace <name>` | `NATSTACK_WORKSPACE` | Workspace name to resolve |
| `--workspace-dir <path>` | `NATSTACK_WORKSPACE_DIR` | Explicit workspace directory |
| `--app-root <path>` | `NATSTACK_APP_ROOT` | Application root (default: `cwd()`) |
| `--host <hostname>` | `NATSTACK_HOST` | External hostname; also sets bind to `0.0.0.0` |
| `--bind-host <addr>` | `NATSTACK_BIND_HOST` | Explicit bind address (overrides `--host` default) |
| `--protocol <http\|https>` | `NATSTACK_PROTOCOL` | Protocol for panel-facing URLs |
| `--tls-cert <path>` | — | TLS certificate file (PEM). Enables HTTPS with `--tls-key`. |
| `--tls-key <path>` | — | TLS private key file (PEM). Required with `--tls-cert`. |
| `--serve-panels` | — | Enable panel HTTP serving |
| `--panel-port <port>` | — | Port for panel HTTP (default: auto-assigned) |
| `--init` | — | Auto-create workspace from template if it doesn't exist |
| `--log-level <level>` | `NATSTACK_LOG_LEVEL` | Log verbosity |
| `--print-token` | — | Print `NATSTACK_ADMIN_TOKEN=...` for scripting |
| `--public-url <url>` | `NATSTACK_PUBLIC_URL` | Externally-reachable base URL used to build OAuth redirect URIs, webhook advertisements, etc. Defaults to `${protocol}://${host}:${gatewayPort}` but should be set explicitly when a reverse proxy or DNS-facing hostname is in front. |
| `--help` | — | Show usage and exit |

### 3. Admin token persistence

Admin-token resolution on server startup:

1. `NATSTACK_ADMIN_TOKEN` env var (if set, wins).
2. `~/.config/natstack/admin-token` (mode 0600) — auto-populated on first standalone start.
3. Fresh 32-byte hex random — generated once, then persisted to (2) so it survives restarts.

In practice you don't need to manage the token manually: the first time you run `natstack-server` standalone it writes the token and prints it. Copy that into your client(s) once. Subsequent starts reuse the same token.

The token is also mirrored to `<workspace-state>/admin-token` for scripting against a specific workspace.

Override or rotate via env var:

```bash
export NATSTACK_ADMIN_TOKEN="your-own-token-here"
natstack-server --workspace my-workspace --host 0.0.0.0
```

### Health check

The gateway exposes `GET /healthz` on both HTTP and HTTPS builds — it always
returns `{"ok":true,"protocol":"http|https"}`. For detailed fields (`version`,
`uptimeMs`, `workerd`, `tokenSource`) pass the admin token via either:

- `?token=<admin-token>` query param (convenient for curl), or
- `X-NatStack-Token: <admin-token>` request header (what the Electron main
  process uses; keeps the token out of URLs, referer headers, and proxy logs).

The Electron main process polls `/healthz` every 60s in remote mode and
forwards samples to the renderer via the `server-health` event — the badge
tooltip displays version and uptime there.

### Token rotation

Call `tokens.rotateAdmin()` (via the in-app **Rotate token** button, or
programmatically) to mint a fresh admin token on the server. The server
persists the new token to `~/.config/natstack/admin-token`, swaps it into
the token manager, and returns it once. Existing authenticated connections
keep working until they drop; next reconnect will fail until the new token
is supplied — the settings dialog persists it into the local credential
store and relaunches for you.

### 4. TLS / HTTPS

To serve over HTTPS directly (without a reverse proxy):

```bash
pnpm server \
  --workspace my-workspace \
  --host my-server.example.com \
  --tls-cert /path/to/cert.pem \
  --tls-key /path/to/key.pem \
  --serve-panels
```

Both `--tls-cert` and `--tls-key` must be provided together. When TLS is enabled, the gateway serves HTTPS and the RPC endpoint accepts WSS connections.

Alternatively, place a reverse proxy (nginx, caddy) in front and use `--protocol https` to tell NatStack that panel-facing URLs should use HTTPS.

For remote Electron clients on another machine, HTTPS is the normal deployment
shape. Browser APIs available to panels differ on insecure origins, so
non-loopback `http://` remotes are intentionally rejected by the client.

## Connecting the Electron App

Credentials are resolved in this order on each launch; the first source that
provides both URL + token wins:

| Source | Fields | Priority | Where it lives |
|--------|--------|----------|----------------|
| Environment | `NATSTACK_REMOTE_URL`, `NATSTACK_REMOTE_TOKEN`, (opt) `NATSTACK_REMOTE_CA`, `NATSTACK_REMOTE_FINGERPRINT` | 1 | — |
| Credential store | URL + token (encrypted via Electron `safeStorage`), optional CA/fingerprint | 2 | `~/.config/natstack/remote-credentials.json` (`0o600`) |
| Config file | `remote.url`, `remote.token`, `remote.caPath`, `remote.fingerprint` | 3 | `~/.config/natstack/config.yml` |

### Option A: Environment variables (bootstrap)

```bash
export NATSTACK_REMOTE_URL="https://my-server.example.com:38291"
export NATSTACK_REMOTE_TOKEN="a1b2c3d4e5..."
natstack
```

Useful for the very first launch. Once connected you can switch to (B).

### Option B: In-app settings dialog (recommended)

Click the connection badge in the title bar → **Remote server** → fill in URL,
admin token, and (if using self-signed TLS) a CA path or fingerprint → **Save &
relaunch**. The token is encrypted via the OS keychain (`safeStorage`). Use the
**Disconnect** button to wipe credentials and return to local mode.

### Option C: Config file

Edit `~/.config/natstack/config.yml`:

```yaml
remote:
  url: https://my-server.example.com:38291
  token: a1b2c3d4e5...
  caPath: /home/you/.config/natstack/server-ca.pem   # optional
  fingerprint: "AB:CD:..."                            # optional, SHA-256 leaf cert
```

### TLS pinning for self-signed servers

For home-server setups without a public CA-signed cert, the client needs either
a custom CA or a pinned fingerprint:

- **CA path** — point `caPath` (or `NATSTACK_REMOTE_CA`) at the server's cert
  PEM. The client trusts it as a custom CA.
- **Fingerprint** — get the hash with
  `openssl x509 -in cert.pem -noout -fingerprint -sha256`, OR click **Fetch
  from server** in the settings dialog to pull it from the live endpoint. The
  client bypasses normal CA validation and accepts the connection iff the
  leaf cert matches.

Under the hood, fingerprint mode validates the peer cert during the TLS
`secureConnect` handler *before* any application-layer byte (including the
HTTP upgrade line) is written to the socket. A mismatched peer never receives
the admin token or any RPC framing.

### Trust-on-first-use

When you submit the settings dialog with an `https://` URL and no stored
fingerprint, **Save & relaunch** runs `testConnection` first. That probe
captures the peer's observed fingerprint; the dialog displays it and asks you
to confirm before saving. Accept the prompt to pin that fingerprint going
forward.

### What happens on connect

1. Electron parses the remote URL and validates it (must be http or https)
   It must also be a trustworthy origin: `https://...`, or loopback `http://...`.
2. Opens a WebSocket to `ws[s]://<host>:<port>/rpc`
3. Authenticates with the admin token
4. Fetches workspace metadata from the server via RPC
5. Creates an RPC-backed proxy for all panel HTTP operations
6. All panel rendering, builds, git, AI, etc. are served by the remote server

### Electron state in remote mode

Electron stores its own UI state (window position, session data, etc.) in `~/.config/natstack/remote-state/` rather than in a workspace-specific directory.

## Gateway Routing

The standalone server runs a single-port gateway that multiplexes all traffic:

| Path | Protocol | Handler |
|------|----------|---------|
| `/rpc` | WebSocket | RPC server (admin client, harness connections) |
| `/rpc` | HTTP POST | RPC server (HTTP fallback) |
| `/_git/*` | HTTP | Reverse proxy to git server |
| `/_w/*` | HTTP/WS | Reverse proxy to workerd |
| `/*` (everything else) | HTTP/WS | Panel HTTP server |

## Connection Resilience

In remote mode, the Electron app automatically reconnects if the WebSocket connection drops:

- **Exponential backoff**: 1s, 2s, 4s, 8s, ... up to 30s between attempts
- **Up to 10 reconnection attempts** before giving up
- **Pending RPC calls** are rejected on disconnect (callers should retry)
- **Status indicator** in the title bar shows connection state:
  - Green dot: connected
  - Yellow dot: reconnecting
  - Red dot: disconnected

If all reconnection attempts fail, the app shows an error dialog and exits.

In local mode, if the server child process crashes, the app relaunches automatically.

## Connection Status in the UI

When running in remote mode, the title bar displays a connection status indicator showing:
- The remote server hostname
- A colored dot indicating connection health (green/yellow/red)

This indicator is only visible in remote mode. In local mode, the server runs as a child process and the indicator is hidden.

The connection status is also available programmatically via `app.getInfo()` which returns `connectionMode` ("local" or "remote"), `remoteHost`, and `connectionStatus`.

## OAuth in remote mode

When an OAuth flow is initiated from a remotely-connected client, the server
dispatches an `open-external-requested` event to **only the initiating client**
(not broadcast — so a second connected client doesn't also try to handle
somebody else's login). That client opens the URL locally
(`shell.openExternal` on desktop, `Linking.openURL` on mobile). The server
drives the OAuth state machine and persists the resulting tokens.

**Callback reachability.** The OAuth provider redirects the user's browser
back to a URL *on the server*. For the callback to land correctly when the
server is remote:

- **`NATSTACK_PUBLIC_URL` must be set** (or `--public-url`) to the URL the
  user's browser will use to reach the server. This becomes the OAuth
  `redirect_uri` — for OpenAI Codex, that's
  `${NATSTACK_PUBLIC_URL}/_r/s/auth/oauth/callback`.
- The OAuth flow is owned by `NatstackCodexProvider`
  (`src/server/services/oauthProviders/`), which registers a callback route via
  the gateway's `/_r/` primitive (see [routes.md](./routes.md)). Unlike pi-ai's
  bundled flow (which hardcodes `http://localhost:1455`), ours works with any
  publicly-reachable redirect URI.
- **Nango** integrations are unaffected — Nango hosts its own callback.

## Ops & resilience

### Backup

The server machine owns all state. Back these up:

| Path | What it holds |
|---|---|
| `~/.config/natstack/admin-token` | Stable admin token (restore = keep old clients connectable) |
| `~/.config/natstack/config.yml` | Models / cache config |
| `~/.config/natstack/.secrets.yml` | Nango secret key, API keys |
| `~/.config/natstack/oauth-tokens.json` | Provider OAuth credentials (user-resealable, but convenient) |
| `~/.config/natstack/workspaces/<name>/source/` | Workspace content (panels, agents, configs) — git-repo'd, also push elsewhere |
| `~/.config/natstack/workspaces/<name>/state/` | DO storage, panel persistence, build cache. The `.databases/workerd-do/` subdir is the critical piece — SQLite files per DO. |

Clients are disposable: their `remote-credentials.json` can be regenerated via
the settings dialog.

### Running behind a reverse proxy

For internet-exposed setups, put Caddy / Traefik / nginx in front of the
gateway and let it handle TLS termination with Let's Encrypt. Example Caddy
snippet:

```
natstack.example.com {
  reverse_proxy 127.0.0.1:38291 {
    transport http {
      versions 1.1 2
    }
  }
}
```

Run the server with `--bind-host 127.0.0.1 --protocol https` (`--protocol`
tells NatStack that panel-facing URLs should use `https://`, even though the
gateway itself speaks plain HTTP to the proxy). Client points at
`https://natstack.example.com`.

### Log redaction

The server prints the admin token once on startup (intentional — that's how
you grab it). Elsewhere, `ServerClient` and related log sites route error
strings through `redactToken()` from `@natstack/shared/redact` so a stray
token in an error message is masked. If you add new logging that might
include the token, import and apply `redactTokenIn(message, token)`.

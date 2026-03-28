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

## Setting Up the Server

### 1. Start the server in standalone mode

```bash
node dist/server/index.js \
  --workspace my-workspace \
  --host my-server.example.com \
  --serve-panels \
  --init
```

Use `--help` for a full list of options:

```bash
node dist/server/index.js --help
```

The server will print its gateway URL and admin token on startup:

```
natstack-server ready:
  Gateway:     http://my-server.example.com:38291
  Git:         (via gateway /_git/)
  Workerd:     (via gateway /_w/)
  RPC:         ws://my-server.example.com:38291/rpc
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
| `--help` | — | Show usage and exit |

### 3. Setting a stable admin token

By default the server generates a random admin token on each start. To use a stable token (recommended for remote setups):

```bash
export NATSTACK_ADMIN_TOKEN="your-secret-token-here"
node dist/server/index.js --workspace my-workspace --host 0.0.0.0 --serve-panels
```

The token is also written to `<workspace-state>/admin-token` (mode 0600) on each startup for scripting convenience.

### 4. TLS / HTTPS

To serve over HTTPS directly (without a reverse proxy):

```bash
node dist/server/index.js \
  --workspace my-workspace \
  --host my-server.example.com \
  --tls-cert /path/to/cert.pem \
  --tls-key /path/to/key.pem \
  --serve-panels
```

Both `--tls-cert` and `--tls-key` must be provided together. When TLS is enabled, the gateway serves HTTPS and the RPC endpoint accepts WSS connections.

Alternatively, place a reverse proxy (nginx, caddy) in front and use `--protocol https` to tell NatStack that panel-facing URLs should use HTTPS.

## Connecting the Electron App

### Option A: Environment variables

```bash
export NATSTACK_REMOTE_URL="http://my-server.example.com:38291"
export NATSTACK_REMOTE_TOKEN="a1b2c3d4e5..."
npx electron .
```

### Option B: Config file

Add to `~/.config/natstack/config.yml`:

```yaml
remote:
  url: http://my-server.example.com:38291
  token: a1b2c3d4e5...
```

Environment variables take precedence over config file values.

| Source | Fields | Priority |
|--------|--------|----------|
| Environment | `NATSTACK_REMOTE_URL`, `NATSTACK_REMOTE_TOKEN` | Highest |
| Config file | `remote.url`, `remote.token` | Fallback |

Both URL and token must be set (from any source) for remote mode to activate. If either is missing, the app falls back to local mode (spawning its own server child process).

### What happens on connect

1. Electron parses the remote URL and validates it (must be http or https)
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

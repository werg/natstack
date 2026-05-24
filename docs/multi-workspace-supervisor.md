# Multi-Workspace Supervisor

`natstack-supervisor` is a headless process-per-workspace supervisor. It owns the public
HTTP/WS port and lazily starts one normal `natstack-server` backend per managed workspace.
Tenant traffic is routed by URL prefix:

```text
http://host:8099/w/<workspace>/...
https://host/base/w/<workspace>/...
```

Backends are selected by workspace name only. Workspaces must live in the NatStack data dir
and be present in the central workspace registry before tenant traffic can spawn them.
Arbitrary workspace paths are intentionally unsupported.

## Start

```bash
pnpm build
node dist/supervisor.mjs --port 8099 --operator-token "$TOKEN"
```

Useful options:

| Flag                                     | Purpose                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--public-url https://example.test/base` | Canonical public origin and optional base path. Tenant routes move under `/base/w/<workspace>/...`.           |
| `--max-workspaces 5`                     | Maximum concurrently active backend processes.                                                                |
| `--idle-timeout 1800000`                 | Idle backend teardown delay in milliseconds. Backends with active WS, HTTP, or proxy sockets are not evicted. |
| `--expose-workspace name`                | Restrict tenant cold starts to named workspaces. Repeat the flag or pass comma-separated names.               |
| `--require-auth-to-cold-start`           | Require supervisor operator auth before a stopped backend can be spawned.                                     |
| `--allow-create`                         | Enable operator-authenticated workspace creation through the supervisor API.                                  |
| `--tls-cert` / `--tls-key`               | Serve HTTPS directly from the supervisor.                                                                     |

`--bind-host` controls the listen address only. It is never used as the advertised public
hostname; use `--public-url` or `--host` for generated URLs.

## Operator API

Supervisor routes live outside the tenant namespace under `/_supervisor` or
`<base>/_supervisor`. They require:

```http
Authorization: Bearer <operator-token>
```

Available routes:

| Route                                             | Purpose                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /_supervisor/workspaces`                     | List registered workspaces and active backend process state.                                        |
| `POST /_supervisor/workspaces`                    | Create and register a workspace when `--allow-create` is set. Body: `{ "name": "workspace-name" }`. |
| `DELETE /_supervisor/workspaces/:name`            | Stop, delete, and unregister a workspace.                                                           |
| `POST /_supervisor/workspaces/:name/stop`         | Evict an active backend without deleting the workspace.                                             |
| `POST /_supervisor/workspaces/:name/issue-device` | Mint a device credential for the named backend by injecting that backend's internal admin token.    |

Tenant paths under `/w/<workspace>/...` never receive backend admin tokens. Caller
`Authorization` headers and WebSocket frames pass through to the backend so the normal
per-workspace caller/device auth remains the security boundary.

## Production Notes

Use at least one cold-start control for public deployments:

- expose only intended workspace names with `--expose-workspace`;
- or require operator auth to wake stopped backends with `--require-auth-to-cold-start`;
- or place an upstream edge auth policy in front of `/w/<workspace>/...`.

The supervisor also rate-limits unauthenticated cold-start attempts per source/workspace.

Each backend has isolated process memory, gateway/workerd ports, workerd config, sqlite/DO
storage, credential store, extension host, and workspace state dir. The central
`config.yml`, `.secrets.yml`, and `.env` remain operator-shared. Tenant-specific
credentials should live in per-workspace state.

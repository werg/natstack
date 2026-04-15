# Gateway Routes (`/_r/`)

Workers and server-side services can expose HTTP routes through the gateway's
reserved `/_r/` namespace. This lets any component needing an externally-
reachable endpoint (OAuth callbacks, webhooks, health probes, custom admin
pages) publish one without opening its own port.

The primitive has two sub-namespaces:

- **`/_r/w/<source>/<path>`** — worker-owned routes declared in a package
  manifest's `natstack.routes[]`.
- **`/_r/s/<serviceName>/<path>`** — server-side service routes, registered
  in-process by server-side service factories.

The `/_r/` prefix is peeled off by the gateway; the target (a worker, a DO,
or an in-process handler) receives a URL whose path begins after it.

## Worker routes

Declare routes on a package via its `package.json` manifest:

```jsonc
{
  "name": "@workspace/oauth-receiver",
  "natstack": {
    "routes": [
      {
        "path": "/callback",
        "methods": ["GET"],
        "durableObject": { "className": "OauthFlow", "objectKey": "singleton" }
      },
      {
        "path": "/webhook/:id",
        "methods": ["POST"]
      }
    ],
    "durable": { "classes": [{ "className": "OauthFlow" }] }
  }
}
```

Each entry binds one of two targets:

### DO-backed (`durableObject` set)

The request is routed to `env[do_<source>_<class>].idFromName(objectKey).fetch()`
in workerd, via the existing `/_w/` router. This matches the convention used by
`DODispatch`. Default `objectKey` is `"singleton"` — all route hits for a
package share one DO instance. Use a specific `objectKey` (or future-work:
a `:param` lookup) to partition by tenant.

**Use DO-backed routes when the endpoint is always-on** — webhooks from third
parties, OAuth callbacks that must arrive during a login flow. DO routes survive
as long as the DO class is registered (which happens at server boot from the
build graph), independent of whether any regular worker instance is alive.

### Regular-worker (`durableObject` absent)

The request goes to the worker's default `fetch` export via the workerd
instance-name router.

**Routes are bound to the canonical-name instance only.** A package's canonical
instance is the one whose name equals the last segment of its source path
(`workers/oauth-receiver` → `oauth-receiver`). The runtime allows spawning
multiple instances of the same source with custom names; those extra instances
exist but don't register routes. If you need multiple independently-routable
targets, model them as DO classes (so `objectKey` disambiguates) or split into
distinct packages.

Regular-worker routes disappear when the canonical instance is destroyed.

### Path patterns

v1 supports literal path segments and `:name` params. No wildcards, no
optional segments. `/webhook/:id` matches `/webhook/abc-123` and populates
`params.id = "abc-123"` (for service routes; worker routes forward the raw
path to workerd).

## Service routes

Server-side service factories can expose routes alongside their RPC
definition. The factory returns `{ definition, routes? }`:

```ts
export function createAuthService(deps): { definition: ServiceDefinition; routes: ServiceRouteDecl[] } {
  return {
    definition: { name: "auth", ... },
    routes: [{
      serviceName: "auth",
      path: "/oauth/callback",
      methods: ["GET"],
      handler: (req, res) => deps.authService.handleOAuthCallback(req, res),
    }],
  };
}
```

Bootstrap wires both through `rpcServiceWithRoutes(...)` in
`src/server/rpcServiceWithRoutes.ts`. Route concerns stay server-local —
`@natstack/shared` has no knowledge of routes.

Handlers receive the raw Node `IncomingMessage` / `ServerResponse`. For
WebSocket routes, set `websocket: true` and provide an `onUpgrade(req, socket, head, params)`.

## Auth model

Each route opts in to one of two modes via the `auth` field:

- `"public"` (default): the route is reachable without any token. Handlers
  own their own validation (OAuth state parameter, HMAC signature, etc.).
  This is the common case — most callbacks come from third-party IdPs or
  webhook senders, neither of which knows the admin token.
- `"admin-token"`: the gateway checks `?token=<adminToken>` query arg or an
  `X-NatStack-Token` header before dispatching. Useful for privileged
  diagnostic routes.

Rate limiting is out of scope; front the server with a reverse proxy if you
need it.

## External URL construction

Consumers (OAuth providers, webhook-URL advertisements, etc.) build absolute
URLs via `getPublicUrl()` / `buildPublicUrl(pathname)` in
`src/server/publicUrl.ts`. The base URL resolves in this order:

1. `--public-url <url>` CLI flag
2. `NATSTACK_PUBLIC_URL` env var
3. Computed fallback: `${protocol}://${externalHost}:${gatewayPort}`

Set `--public-url` (or the env var) to the URL that *users' browsers* use
to reach the server. It can differ from the server's bind address when a
reverse proxy or DNS-facing hostname is in front.

## URL rewrite detail (for debugging)

The gateway performs pure URL rewrites; workerd's router is untouched.

| Request to gateway | Rewritten upstream path |
|---|---|
| `/_r/w/workers/foo/callback` with DO `{ className: "X", objectKey: "s" }` | `/_w/workers/foo/X/s/callback` |
| `/_r/w/workers/foo/hello` with regular target `foo` | `/foo/hello` |
| `/_r/s/auth/oauth/callback` | (in-process call into the handler) |

Query strings are preserved on worker rewrites.

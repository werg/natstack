# Wave 3 — Egress Strict-Mode Migration

**Status:** code shipped on the `audit` branch, runtime not yet enabled.
**Owner:** Wave3-Agent A (EgressProxy strict-mode wiring).
**Closes:** audit findings #1, #2, #11, 03-F-03 (cross-ref `00-summary.md` and `05-sandboxing-execution.md` S1/S2).

---

## What changed

Until this wave, every workerd worker / DO got a per-service `network`
binding with `allow: ["public", "local"]` and `trustBrowserCas: true`.
Worker code performed direct outbound TCP/TLS connections, fully
bypassing `EgressProxy`'s consent grants, capability check, rate limit,
breaker, audit log, and credential injection.

**Strict mode now means:**

1. `WorkerdManager` constructs an `EgressProxy` (via the
   `buildEgressProxy(tokenStore, bypassRegistry)` factory in
   `WorkerdManagerDeps`) and starts it on a loopback ephemeral port
   before the first workerd config is generated.
2. Every per-worker / per-DO outbound is wired through that proxy as
   workerd's `globalOutbound` — implemented as an `external` service
   with `http: { style = proxy }` pointing at `127.0.0.1:<egressPort>`.
   The legacy `network` service is only emitted as a fall-back when
   `buildEgressProxy` is omitted (test / early-boot only).
3. `WorkerdManager` mints a stable per-worker `PROXY_AUTH_TOKEN`
   (24-byte base64url) and binds it as the `PROXY_AUTH_TOKEN` env var
   alongside a `PROXY_WORKER_ID` env var inside the worker. The proxy
   validates these via `crypto.timingSafeEqual` against
   `WorkerdManager.getProxyToken(workerId)` on every inbound HTTP and
   CONNECT request.
4. `EgressProxy.handleConnect` is now hardened with:
   - attribution (407 / 401 on missing/wrong worker auth),
   - port allow-list (443 only by default),
   - provider routing (the host MUST match a declared `apiBase`),
   - consent check (worker MUST have a grant for that provider),
   - rate limit + circuit breaker,
   - DNS resolve, then a deny-list check on the resolved IP
     (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
     `169.254.0.0/16`, `0.0.0.0/8`, `100.64.0.0/10`, `::1`, `fe80::/10`,
     `fc00::/7`, `fd00::/7`, IPv4-mapped IPv6 of the same),
   - and connect by **resolved IP** rather than hostname so the address
     is pinned for the lifetime of the tunnel (DNS-rebinding defence).

## What this breaks

**Every existing worker that issues `fetch(...)` will fail under strict
mode** until either (a) it stops doing outbound, or (b) it declares a
provider whose `apiBase` covers the host AND the user grants consent for
that provider for that worker.

The current set of workers in `workspace/workers/`:

| Worker | Outbound today | Provider declared? | Strict-mode status |
|---|---|---|---|
| `workers/hello` | none (returns 200 from a stub) | n/a | OK |
| `workers/fork` | none (returns 200 from a stub) | n/a | OK |
| `workers/test-agent` | none in `index.ts` (DO stub) | n/a | OK at module level. DOs may make outbound — verify per-class. |
| `workers/pubsub-channel` | none in `index.ts` | n/a | OK at module level (channel-do.ts is mostly RPC back to server). |
| `workers/agent-worker` | none in `index.ts`; AiChatWorker DO calls into `pi-ai` which `fetch()`es chatgpt.com / claude.ai / etc. | NO | **WILL BREAK.** Must declare `anthropic`, `openai`, `google` providers (and others as needed) and have user grant consent. |
| `workers/email-sync` | `email-sync-do.ts` `gmailFetch` calls `https://gmail.googleapis.com/gmail/v1/users/me/...` | NO (no manifest declaration) | **WILL BREAK.** Must declare `google` (or a `gmail`-scoped provider) and have user grant consent at install time. |
| `workspace/examples/provider-linear` | `linearGraphQL()` POSTs to `https://api.linear.app/graphql` | YES — `manifest` (`id: "linear"`) and `integrationManifest.providers: ["linear"]` already exist | OK once the user grants consent for `linear`; this is the reference shape. |

There are no other packages under `workspace/workers/` and no other
`fetch(...)` call sites under `workspace/workers/` or `workspace/panels/`
besides those listed (verified via grep on this commit).

**No worker manifests were edited in this wave.** Surfacing the breakage
list here is the deliberate hand-off — the user decides which workers
to migrate vs. retire.

## How to migrate a worker

1. Add a provider entry to the worker package's `package.json` under
   `natstack.providers` (or to a sibling `integrationManifest`-style
   export, depending on the worker's manifest convention). For the
   reference shape, see `workspace/examples/provider-linear/src/index.ts`:

   ```ts
   export const integrationManifest = {
     providers: ["linear"],
     scopes: { linear: ["read", "write"] },
     endpoints: { linear: [{ url: "https://api.linear.app/graphql", methods: ["POST"] }] },
   };
   ```

2. Make sure the provider exists in `packages/shared/src/credentials/providers/`
   with a matching `apiBase`. If not, register a new provider manifest
   there.

3. At install / first-run time, the user grants consent for the worker
   to use that provider via the credentials UI. The grant lands in the
   `credential_consent` SQLite table; `EgressProxy.authorizeRequest`
   reads it via `consentStore.list(workerId)`.

4. The worker's `fetch(...)` calls automatically pick up the
   provider-bound credential — `EgressProxy` injects
   `Authorization: Bearer <accessToken>` on the upstream request.

## Emergency rollback — `STRICT_EGRESS_BYPASS_WORKERS`

If a worker breaks in production and a hot-fix can't ship in time, set
the env var:

```
STRICT_EGRESS_BYPASS_WORKERS=worker-a,worker-b
```

before launching the server. Listed worker IDs (the same ID workerd
binds as `PROXY_WORKER_ID` — i.e. the sanitized worker name for regular
workers, or `do-service:<source>:<className>` for DO services) skip
provider gating and consent checks. They still go through the rest of
the pipeline (proxy auth, port allow-list, IP deny-list, rate limit,
circuit breaker), so this is NOT a full bypass — the worker still
cannot reach loopback / IMDS / RFC1918, and a missing token is still a
401.

**This is the only documented escape hatch.** Every bypass use is logged
at `warn` level by the proxy with the worker id, on every request.
Operators should monitor the logs and unset the env var as soon as the
real fix lands.

The bypass list also accepts an explicit array via
`new WorkerdManager({ bypassWorkerIds: [...] })` for tests / scripted
deployment. Both sources are unioned.

## Wiring to be done outside this wave

This wave makes the strict-mode plumbing complete inside
`WorkerdManager` + `EgressProxy`. To switch it on in the running
server, two follow-ups are required (deliberately out of scope here —
they touch `src/server/index.ts`, `packages/shared/src/credentials/*`,
and the worker runtime helpers, which other wave-3 agents own):

1. **`src/server/index.ts`** must construct shared
   `ProviderRegistry` / `ConsentGrantStore` / `CredentialStore` /
   `AuditLog` / `RateLimiter` factory / `CircuitBreaker` instances and
   pass a `buildEgressProxy(tokenStore, bypassRegistry)` factory into
   `new WorkerdManager({ ... })` that closes over them. Today the
   `credentialService` constructs its own private store; that store
   should be hoisted up to a container singleton so both the credential
   service and the egress proxy see the same consent grants.

2. **Worker runtime helper** must inject the
   `X-NatStack-Worker-Id` and `Authorization: Bearer <PROXY_AUTH_TOKEN>`
   headers on every `fetch(...)` call inside the worker. Today the
   workerd `external` service routes to the proxy by transport, but
   it does NOT auto-stamp these headers — the worker code currently
   calls `fetch(url)` with no auth. Without the runtime helper change,
   strict mode rejects every worker request with 407
   ("Missing x-natstack-worker-id"). The helper lives in
   `workspace/packages/runtime/` and is owned by the runtime agent.

A fuller switchover sequence is therefore:

1. Land the runtime header helper.
2. Land the index.ts wiring (passes `buildEgressProxy` into
   WorkerdManager).
3. Migrate provider declarations + consent flow for the workers in the
   table above (or accept the breakage and retire those that don't ship).

Until step (1) and (2) ship, `WorkerdManager` runs in fall-back mode
(no `buildEgressProxy` provided → legacy `network` service). The audit
finding #1 stays open for the runtime / index agents to close.

## Test coverage added

`src/server/services/__tests__/egressProxy.test.ts` (11 tests):

- 407 on missing `X-NatStack-Worker-Id`.
- 401 on unknown worker id.
- 401 on wrong proxy-auth token (constant-time compare).
- 403 on host that no provider declares (strict-mode no-passthrough).
- 403 on provider-match without a consent grant.
- 200 on provider-match + consent, with `Authorization: Bearer
  <accessToken>` injected on the upstream request.
- Legacy `X-NatStack-Proxy-Auth` header fallback also accepted.
- CONNECT to `169.254.169.254:443` rejected (no provider declaration).
- CONNECT to `127.0.0.1:443` rejected post-DNS even with bypass on.
- CONNECT to port 22 rejected by port allow-list (even with bypass on).
- CONNECT with no worker-id header rejected with 407.

Existing `workerdManager.test.ts` and `workerdService.test.ts` continue
to pass against the rewritten config-generation path; the
`buildOutboundService` helper falls back to the legacy `network`
service when no `buildEgressProxy` factory is supplied (test mode).

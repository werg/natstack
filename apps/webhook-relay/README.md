# NatStack webhook relay

Cloudflare Worker that receives provider webhooks (GitHub, Slack, Stripe,
…), HMAC-verifies them, queues them per tenant, and serves them to the
NAT-traversal-required NatStack desktop over an authenticated long-poll.

Closes audit findings **F-02** (webhook ingress had no signature check)
and **F-03** (Slack/Stripe verifiers had no replay window) from
`docs/audit/06-http-webhooks-external.md`.

## Routes

| Method | Path                                  | Auth                       | Purpose                                            |
|--------|---------------------------------------|----------------------------|----------------------------------------------------|
| GET    | `/healthz`                            | none                       | Liveness check.                                    |
| POST   | `/webhook/:provider/:tenantId`        | provider HMAC + replay     | Public ingress for provider webhooks.              |
| GET    | `/pull/:tenantId`                     | tenant bearer              | Long-poll for queued events (≤25s).                |
| POST   | `/ack/:tenantId/:eventId`             | tenant bearer              | Drop a delivered event from the queue.             |
| POST   | `/admin/tenant/:tenantId/init`        | `ADMIN_BOOTSTRAP_SECRET`   | Mint a fresh per-tenant bearer.                    |
| POST   | `/admin/tenant/:tenantId/secrets`     | tenant bearer              | Set/rotate per-provider HMAC secrets for tenant.   |

## Deploy

```bash
cd apps/webhook-relay
pnpm install

# Provision KV namespaces (one-time per environment).
wrangler kv:namespace create EVENTS_KV
wrangler kv:namespace create NONCES_KV
wrangler kv:namespace create TENANTS_KV
# → paste the resulting `id` values into wrangler.toml

# Set the operator bootstrap secret (used to mint per-tenant bearers).
wrangler secret put ADMIN_BOOTSTRAP_SECRET

wrangler deploy
```

## Bootstrap a tenant

```bash
# 1. Mint a tenant bearer (returned ONCE — store it on the desktop).
curl -X POST https://relay.example.workers.dev/admin/tenant/acme/init \
  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_SECRET"
# → { "tenantId": "acme", "bearer": "<64-hex>" }

# 2. Configure provider HMAC secrets (tenant-bearer auth).
curl -X POST https://relay.example.workers.dev/admin/tenant/acme/secrets \
  -H "Authorization: Bearer <tenant-bearer>" \
  -H "Content-Type: application/json" \
  -d '{ "secrets": { "github": "<gh-webhook-secret>", "slack": "<slack-signing>" } }'

# 3. Point provider's webhook at:
#    https://relay.example.workers.dev/webhook/github/acme
```

## Desktop puller

The NatStack desktop process registers a `webhook.startRelayPuller(tenantId)`
RPC method (shell-only policy). It reads the bearer from
`NATSTACK_RELAY_BEARER_<TENANT_ID>` (uppercased, `-`/`.` replaced with
`_`) and the relay URL from `NATSTACK_RELAY_URL`.

The puller maintains a single long-running `GET /pull/:tenantId` and
reconnects with exponential backoff (250 ms → 30 s cap) on error or
timeout.

See `src/server/services/webhookRelayClient.ts` for the implementation.

## Trade-offs taken

- **KV (not Durable Objects).** KV is eventually consistent — a freshly
  enqueued event can take a few seconds to appear in the long-poll. We
  accept this because (a) DO costs more and adds migration complexity,
  (b) providers themselves retry on 5xx with much longer backoff, (c) the
  desktop reconnects every 25s anyway. If you need strict ordering or
  single-writer semantics, swap `queue.ts` for a DO backend.
- **Long-poll (not SSE / WebSocket).** Workers' WebSocket support is
  per-connection rather than fan-out, so SSE would mostly behave like
  long-poll for a single subscriber. Long-poll keeps the desktop's
  retry logic identical to a normal HTTP client and is friendly to
  hostile networks (no idle-timeout disconnects from middleboxes).
- **Per-tenant secrets in KV (not wrangler.toml).** Stateful, but lets
  us add a tenant without a deploy. The bootstrap secret stays in
  `wrangler secret`.
- **Verifiers duplicated** in `src/verifiers.ts` rather than imported
  from `packages/shared/`. Workers don't have `node:crypto`; the shared
  verifier uses it. Both implementations must agree — keep them in sync.

## Security notes

- All bearer comparisons are constant-time
  (`bearerEqual` in `verifiers.ts`).
- Replay nonces use KV `expirationTtl: 600` (2x the 5-minute timestamp
  window) so a duplicate that races the boundary is still caught.
- `wrangler.toml` carries placeholders for KV ids and (intentionally) no
  account / zone / secret values. `wrangler` will reject deploy without
  real KV ids.
- TLS pinning between the desktop puller and this Worker is a
  follow-up: the desktop's `tlsPinning.ts` infrastructure currently
  pins per-host fingerprints, and adding `*.workers.dev` requires
  policy work outside this Worker's scope (TODO in
  `webhookRelayClient.ts`).

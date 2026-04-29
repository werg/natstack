# NatStack webhook relay

Cloudflare Worker that will forward public provider webhook callbacks from
`hooks.snugenv.com` to a reachable NatStack server.

The relay must stay thin: it preserves the raw body and provider headers, signs
a NatStack relay envelope, and forwards to the server. Provider signature
verification, replay protection, subscription ownership, and userland delivery
belong on the NatStack server.

The target plan is tracked in `docs/credential-system-human-tasks.md`.

## Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` or `/health` | none | Liveness check. |
| POST | `/i/:subscriptionId` | relay envelope to server | Planned generic ingress path; forwards to `/_r/s/webhookIngress/:subscriptionId`. |

The current implementation still contains legacy `/calendar/:leaseId` and
`/pubsub/:providerId` forwarding paths. Those are migration scaffolding and
should not be advertised to new integrations.

## Deploy

```bash
cd apps/webhook-relay
pnpm install

# Configure the NatStack server this Worker forwards to.
wrangler secret put NATSTACK_SERVER_BASE_URL

# Required once generic ingress lands: HMAC key for relay envelope signing.
wrangler secret put NATSTACK_RELAY_SIGNING_SECRET

# Optional temporary compatibility secret for legacy bearer forwarding.
wrangler secret put NATSTACK_SERVER_BEARER_TOKEN

wrangler deploy
```

## Configuration

`NATSTACK_SERVER_BASE_URL` must be an externally reachable NatStack server base
URL, without a trailing path. Example: `https://natstack.example.com`.

`NATSTACK_RELAY_SIGNING_SECRET` is required by the planned generic ingress path.
The Worker signs the forwarded method/path/query/timestamp/body-hash envelope;
the server verifies it before provider-specific webhook verification.

`NATSTACK_SERVER_BEARER_TOKEN` is temporary compatibility plumbing. Do not build
new webhook authentication on top of it.

## Provider URLs

Configure providers to call the generic public ingress URL:

```text
https://hooks.snugenv.com/i/<subscriptionId>
```

# NatStack webhook relay

Cloudflare Worker that forwards public provider webhook callbacks from
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
| POST | `/i/:subscriptionId` | relay envelope to server | Generic ingress path; forwards to `/_r/s/webhookIngress/:subscriptionId`. |

## Deploy

```bash
cd apps/webhook-relay
pnpm install

# Configure the NatStack server this Worker forwards to.
wrangler secret put NATSTACK_SERVER_BASE_URL

# Required for generic ingress: HMAC key for relay envelope signing.
wrangler secret put NATSTACK_RELAY_SIGNING_SECRET

wrangler deploy
```

## Configuration

`NATSTACK_SERVER_BASE_URL` must be an externally reachable NatStack server base
URL, without a trailing path. Example: `https://natstack.example.com`.

`NATSTACK_RELAY_SIGNING_SECRET` is required by the generic ingress path.
The Worker signs the forwarded method/path/query/timestamp/body-hash envelope;
the server verifies it before provider-specific webhook verification.

## Provider URLs

Configure providers to call the generic public ingress URL:

```text
https://hooks.snugenv.com/i/<subscriptionId>
```

# NatStack webhook relay

Cloudflare Worker that forwards public provider webhook callbacks to a reachable
NatStack server. The relay does not validate provider signatures or store events;
the NatStack server owns verification, lease lookup, subscription ownership, and
delivery through the credential webhook service.

## Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` or `/health` | none | Liveness check. |
| POST | `/calendar/:leaseId` | optional relay bearer to server | Forwards to `/_r/s/credentialWebhooks/calendar/:leaseId`. |
| POST | `/pubsub/:providerId` | optional relay bearer to server | Forwards to `/_r/s/credentialWebhooks/pubsub/:providerId`. |

## Deploy

```bash
cd apps/webhook-relay
pnpm install

# Configure the NatStack server this Worker forwards to.
wrangler secret put NATSTACK_SERVER_BASE_URL

# Optional: bearer presented to the NatStack server as Authorization.
wrangler secret put NATSTACK_SERVER_BEARER_TOKEN

wrangler deploy
```

## Configuration

`NATSTACK_SERVER_BASE_URL` must be an externally reachable NatStack server base
URL, without a trailing path. Example: `https://natstack.example.com`.

`NATSTACK_SERVER_BEARER_TOKEN` is optional. When set, the Worker overwrites the
incoming `Authorization` header with `Bearer <token>` before forwarding.

## Provider URLs

Configure providers to call the relay URL for the delivery type:

```text
https://relay.example.workers.dev/calendar/<leaseId>
https://relay.example.workers.dev/pubsub/<providerId>
```

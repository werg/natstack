# NatStack callback relay

Cloudflare Worker that fronts the two third-party-inbound surfaces a NatStack
home server cannot expose directly (it sits behind NAT with no public endpoint):
public **webhooks** and OAuth **redirect callbacks**. Both ride one shared,
authenticated **backhaul** the home server holds open to this relay; they differ
only in durability (plan §7).

There is **no** `NATSTACK_SERVER_BASE_URL` anymore. Routing is multi-tenant: each
home server opens one outbound WebSocket to `/backhaul` (into the global
`RelayRegistry` Durable Object) and claims its own `subscriptionId`s
**first-writer-wins**, bound to that backhaul connection. The shared
`NATSTACK_RELAY_SIGNING_SECRET` only proves "a NatStack server" — it is one
un-versioned key, too weak for tenant isolation, so the per-server connection is
the trust anchor.

## Profiles

| Profile | Durability | Path |
| --- | --- | --- |
| **Webhook** (stateful) | Durable per-subscription buffer in DO storage, TTL + alarm retry, response relayed back to the provider. Survives a briefly-offline server. | `POST /i/<subscriptionId>` |
| **OAuth** (dumb / ephemeral) | None. Interactive, client online; a broken handoff fails loud and the user retries. | `GET /oauth/callback/<transactionId>?code&state` |

The HMAC relay envelope (`src/envelope.ts`) carries over verbatim: every buffered
webhook is signed `method\npath\nquery\ntimestamp\nbodySha256` and the home
server verifies it byte-for-byte (`verifyRelayEnvelope`). It is re-signed with a
fresh timestamp on each delivery attempt so buffered/retried deliveries stay
inside the server's skew window.

### OAuth — one path per platform (fails loud, no silent second path)

- **mobile → deep-link.** The relay hosts the Apple App Site Association /
  Android assetlinks (`/.well-known/...`) anchored on `/oauth/callback/*`, so the
  OS hands the URL straight into the already-connected app, which forwards
  `{state, code}` over the WebRTC pipe. The landing HTML is only reached if the
  deep-link failed — it then renders an error and refuses to forward.
- **desktop → backhaul-forward.** The landing pushes `{state, code}` **verbatim**
  down the owning server's backhaul. If that backhaul is down, the landing fails
  loud (503).

PKCE keeps the relay harmless on both paths: the `codeVerifier` never leaves the
home server, so the `code` the relay sees is useless to it. `state` is the CSRF
token — relayed verbatim, never re-signed. Lookup is by the explicit
`transactionId` carried through the landing, not a `state`-scan.

## Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` or `/health` | none | Liveness. |
| WS | `/backhaul?serverId&ts&sig` | HMAC handshake | Home server's persistent backhaul into the registry DO. |
| POST | `/i/:subscriptionId` | first-writer-wins owner | Webhook ingress → buffered → delivered over the backhaul. |
| GET | `/oauth/callback/:transactionId` | transaction registration | OAuth landing (desktop backhaul-forward; mobile deep-link host). |
| GET | `/.well-known/apple-app-site-association` | none | Apple universal-link host. |
| GET | `/.well-known/assetlinks.json` | none | Android App Links host. |

## Deploy

```bash
cd apps/webhook-relay
pnpm install

# Backhaul auth + relay-envelope signing (required).
wrangler secret put NATSTACK_RELAY_SIGNING_SECRET

wrangler deploy
```

The Durable Object binding + migration are in `wrangler.toml`.

## Configuration

- `NATSTACK_RELAY_SIGNING_SECRET` — HMAC key. Authenticates the backhaul upgrade
  (`sig = v1=HMAC(secret, "<serverId>\n<ts>")`) and signs the relay envelope. The
  Worker/DO fail closed when it is unset.
- `NATSTACK_APPLE_APP_ID` — `<teamId>.<bundleId>` (comma-separated for multiple);
  powers the Apple App Site Association.
- `NATSTACK_ANDROID_PACKAGE_NAME`, `NATSTACK_ANDROID_SHA256_CERT_FINGERPRINTS`
  (uppercase, colon-separated; comma-separated for multiple) — power assetlinks.

When the universal-link env is unset, the `.well-known` routes return 503 rather
than serving a broken association.

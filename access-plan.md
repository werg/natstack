# Runtime RPC Access Plan

## Intent

Panels, workers, and Durable Objects communicate through the runtime RPC primitives. HTTP POST is only the transport used by non-WebSocket runtimes to reach the gateway RPC endpoint; it is not a separate application messaging path.

The gateway and egress proxy provide caller authentication. RPC message bodies are not trusted for caller identity.

## Identity Model

- Panels authenticate through their panel caller token.
- Regular workers authenticate through the workerd egress proxy assertion for `worker:<name>`.
- Durable Objects authenticate RPC egress as `do:<source>:<className>:<objectKey>`.
- DO class services may still have a static `do-service:<source>:<className>` egress assertion as a bootstrap/service-level fallback, but credential and capability decisions must use the per-object `do:` caller ID.

The generated workerd router mints an object-scoped assertion for each DO request and passes it to the runtime base. The DO runtime includes that object assertion on internal `/rpc` calls, and the egress proxy verifies it before stamping `req.natstackCaller`.

## RPC Routing

- Outbound RPC from workers and DOs posts to `${GATEWAY_URL}/rpc`.
- Server-to-DO delivery uses `/_w/<source>/<className>/<objectKey>/__rpc` with a runtime RPC envelope.
- Server-to-worker delivery uses `/<workerName>/__rpc` with the same runtime RPC envelope.
- PubSub/channel delivery uses `rpc.emit(targetId, "channel:message", { channelId, message })`.
- Direct DO method POSTs, `__event`, `/inbox/<callerId>/deliver`, `deliveryUrl`, and `inbox:deliver` are not supported communication paths.

## Access Controls

- Authenticated panels, workers, and DOs may RPC-call or emit to runtime participants.
- Server service ACLs remain enforced for calls to `main` services such as credentials, filesystem, git, and harness APIs.
- Recipients that expose participant methods must provide an access policy function. The runtime passes `RpcCallerContext` from the authenticated transport into that policy and into the method handler.
- Ordinary callers cannot spoof event source IDs; the server derives source identity from the authenticated transport.

## PubSub Contract

Participants subscribe with their participant ID and metadata. Metadata may describe the participant, advertised methods, replay hints, context ID, and channel config. It must not contain delivery callback URLs.

The channel DO stores participants by ID and emits all live/replay/ready messages through runtime RPC. Delivery failures are treated as target reachability failures and may remove stale participants.

## Verification Requirements

- DO outbound RPC is authenticated as `do:<source>:<className>:<objectKey>`.
- Different DO objects of the same class receive distinct credential/capability decisions.
- RPC bodies do not carry caller identity. Caller context is derived from the authenticated transport/gateway envelope and exposed as `ctx.sourceId`.
- Direct `/_w/.../<method>`, `__event`, and `/inbox/.../deliver` paths are rejected or absent.
- PubSub subscribe, replay, ready, broadcast, method-call, method-result, and reconnect flows operate through runtime RPC only.

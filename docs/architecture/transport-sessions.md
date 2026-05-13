# Transport Sessions And Recovery

NatStack has two identity layers on every RPC transport:

- `callerId` is durable application identity. Examples: `shell`, a panel ID, a
  worker ID. A caller ID may have zero, one, or many live connections.
- `connectionId` is ephemeral transport identity. It names one authenticated
  socket/session instance and must never be persisted.

Code that stores state across process restarts may store `callerId`, panel IDs,
tokens, and parent/owner relationships. It must not store `connectionId`.

## Event Delivery

The event service has two independent delivery paths.

`emit(event, payload)` is pub/sub broadcast. It only reaches sessions that
called `events.subscribe(event)`.

`emitToCaller(callerId, event, payload)` is direct caller delivery. It bypasses
the subscription table and sends to every live session for that durable caller.
Use this when all live shells/panels/workers for a caller should observe the
same message.

`emitToConnection(callerId, connectionId, event, payload)` is direct session
delivery. It bypasses the subscription table and sends to exactly one live
transport instance. Use this for request-scoped handoffs where a sibling
connection should not receive the message.

There is no overloaded direct-delivery API. Callers must choose caller-wide or
connection-specific delivery explicitly.

## Session Registration

`RpcServer` registers an `EventSession` for every authenticated WebSocket.
`EventSession` is the live-session abstraction used by direct delivery. Its
`connectionId` is only valid while the transport instance is alive.

In-process transports that do not have a WebSocket, such as the Electron shell
IPC subscriber, may register a direct subscriber through `registerSubscriber`.
Those subscribers still occupy an ephemeral session slot in the event service.

Event-name subscriptions are separate from direct delivery. Unsubscribing from
an event removes only pub/sub membership for the current connection; it does not
remove direct-address reachability for the caller/session.

## Recovery

Recovery has two different semantics:

- `resubscribe` is state recovery. It represents current desired subscription
  state. Late handlers may run immediately after a completed resubscribe for the
  current generation.
- `cold-recover` is an edge-triggered server-restart repair event. Late handlers
  must not run retroactively, because no new restart happened for them.

Handlers should be idempotent. Replay and resubscribe paths must tolerate
duplicate, delayed, and missing messages around reconnect boundaries.

## Ownership

Panel ownership is durable only at caller level:

```text
panelId -> ownerCallerId
```

If a handoff has a remembered owner connection, code may try that connection
first and then fall back to caller-wide delivery if the connection is gone.
Persisted records should only retain `ownerCallerId`; the currently live
session is discovered at runtime.

## Invariants

- Never persist `connectionId`.
- Never assume one `callerId` means one live connection.
- Use `emitToCaller` for caller-wide direct delivery.
- Use `emitToConnection` for one transport instance.
- Treat `resubscribe` as stateful and `cold-recover` as edge-triggered.
- Keep pub/sub subscriptions and direct-address reachability independent.

# `@natstack/rpc` vs `@natstack/pubsub`

NatStack ships two RPC subsystems. This is intentional, not legacy: they
solve different problems and are scoped to non-overlapping responsibilities.
This doc fixes the boundary in writing so future contributors don't try to
unify them prematurely or pick the wrong one for a new feature.

## TL;DR

| System | Shape | Use for |
|---|---|---|
| `@natstack/rpc` | Stateless point-to-point method calls + HTTP-Response streaming | Service calls (`credentials.fetch`, `fs.read`, `blobstore.putText`), URL-bound credential proxying, model SDK fetches |
| `@natstack/pubsub` | Stateful pub/sub channels with structured method calls, participant presence, missed-context replay, and binary attachments | Chat (tool calls, content blocks, inline UI, action bars), durable conversation state, multi-participant agentic flows |

If you're routing a single call/response, possibly with a streaming body,
between two endpoints — use rpc. If you're building anything with
subscribers, replay, multiple participants, or chat-message-shaped
attachments — use pubsub.

## Why both exist

The systems evolved for different concerns and meet different invariants:

**rpc is fetch-shaped.** A call has one caller, one target, and returns
a single value or a single `Response` (with optional `ReadableStream`
body). Cancellation is one `AbortSignal`. Errors propagate to one
caller. The streaming primitive added in
`@natstack/rpc/types#StreamingMethodHandler` is a sink-based
HEAD→DATA*→END frame stream, mirroring HTTP chunked transfer.

**pubsub is conversation-shaped.** A call may have multiple subscribers
observing it; the chat needs missed-context replay if a panel
disconnects mid-conversation; participants have presence and metadata
beyond `selfId`; method *results* can carry structured binary
attachments (an image attachment is data + mimeType + filename, not
opaque bytes); the wire protocol has aggregation hooks for
content-block streaming. `MethodCallHandle.stream:
AsyncIterable<MethodResultChunk>` is the streaming primitive — it
yields *typed structured chunks* rather than raw bytes, because chat
messages are structured.

Trying to fit pubsub's needs into rpc would either bloat rpc's surface
(participants, missed-context, attachment shapes) or force chat features
to layer them on top awkwardly. The reverse — fitting rpc's needs into
pubsub — would force every credentials fetch through the pub/sub
machinery and lose the fetch-shaped semantics that make Response-based
APIs work transparently.

## Concretely shared substrate

Some bits ARE shared and should stay shared:

- **`@workspace/runtime` `RpcCaller` interface** — the credentials
  client takes a `RpcCaller` (anything with `call` + `streamCall`).
  Both rpc-based bridges and pubsub-derived adapters can satisfy it.
- **`@natstack/shared/credentials/streamFraming`** — the binary frame
  codec (HEAD/DATA/END/ERROR). Used by rpc for HTTP `/rpc/stream` and
  by `createRpcBridge.streamCall` over IPC/WS. pubsub doesn't use it
  (its chunks are structured, not byte-streams).

## What does NOT need to change

- **Two WebSocket connections per client.** Yes, panels open one WS
  for rpc and one for pubsub. They're cheap; merging them would
  require unifying authentication paths and reconnect/recovery state
  machines that are deliberately scoped per-system.
- **Duplicate base64 helpers** in `bridge.ts` and `rpc-client.ts`.
  They're ~6 lines each and `@natstack/shared/credentials/streamFraming`
  already exposes shared versions; the duplicates exist to keep tiny
  packages dependency-light.

## When unification becomes worth considering

If any of these become true, revisit:

1. A new feature needs *both* shapes simultaneously (e.g. a tool that
   streams bytes into a chat content block).
2. We add a third subsystem with overlapping concerns (e.g. a
   GraphQL-shaped query layer).
3. The cognitive overhead of "which system?" measurably slows
   development. (Hasn't, yet.)

Until then: keep the boundary clean, route new work to the right side,
and link this doc from any commit that touches the question.

## Decision-tree quick reference

```
Are you routing point-to-point with a single caller/target?
├─ Yes
│  ├─ Need a streaming response body? → rpc.streamCall
│  ├─ Need a one-shot value?          → rpc.call
│  └─ Need to expose a method?        → rpc.exposeMethod / exposeStreamingMethod
└─ No (one-to-many, or stateful conversation)
   ├─ Building chat content blocks?    → pubsub MethodCallHandle
   ├─ Subscribing to a channel?        → pubsub connectViaRpc
   └─ Carrying binary attachments?     → pubsub AttachmentInput
```

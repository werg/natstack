# pubsub-server

WebSocket pub/sub server with SQLite persistence, message replay, and channel forking.

## Channel Forking

Channels can be forked to create branching conversation histories. A forked channel inherits all messages from its parent (up to the fork point) and can add its own messages independently.

### Key Properties

- **Single `messages` table**: All messages share one auto-incrementing ID space. Message IDs are globally unique across all channels.
- **`sinceId` works unmodified**: Because IDs are globally monotonic, reconnection replay with `sinceId` naturally filters out already-seen messages even across fork chains.
- **Presence is NOT inherited**: Forked channels start with a clean participant roster. Only presence events on the forked channel itself are replayed.
- **Max fork depth**: 10 levels. The `resolveForkedSegments` method stops walking the parent chain after 10 hops.

### Schema

The `channels` table includes two fork-related columns:

| Column | Type | Description |
|--------|------|-------------|
| `parent_channel` | TEXT (nullable) | Channel this was forked from. NULL for root channels. |
| `fork_point_id` | INTEGER (nullable) | Message ID **in the parent** at the fork point. All parent messages with `id <= fork_point_id` are inherited. |

### API

#### `setChannelFork(channel, parentChannel, forkPointId)`

Set fork metadata on a channel. The channel must already exist (created via `createChannel`). The `forkPointId` is the last message ID in the parent that should be visible to the forked channel.

#### `getChannelFork(channel) -> { parentChannel, forkPointId } | null`

Get fork metadata for a channel. Returns `null` for root channels (channels with no parent).

#### `resolveForkedSegments(channel) -> Array<{ channel, upToId }>`

Walk the `parent_channel` chain and collect segments in root-first order. Each segment specifies the channel name and the upper bound message ID (`upToId`). The leaf segment has `upToId: Infinity`.

Example for a 3-level chain:
```
[
  { channel: "root",   upToId: 50 },       // messages 1..50 from root
  { channel: "fork-1", upToId: 80 },       // messages from fork-1 up to 80
  { channel: "fork-2", upToId: Infinity },  // all messages from fork-2
]
```

#### `queryRange(channel, sinceId, upToId) -> MessageRow[]`

Query messages in a specific channel within the range `(sinceId, upToId]`. Used internally by the replay logic to iterate over fork segments.

### Fork-Aware Query Behavior

The following methods automatically resolve the fork chain and aggregate results across all segments:

| Method | Behavior |
|--------|----------|
| `getMessageCount(channel, type?)` | Sums counts across all segments, respecting each segment's `upToId` boundary. |
| `getMinMessageId(channel, type?)` | Returns the minimum message ID across all segments. |
| `queryBefore(channel, beforeId, limit)` | Paginates from the leaf segment backward through parent segments until `limit` is satisfied. |
| `queryTrailingUpdates(channel, uuids, atOrAfterId)` | Searches for update/error events across all segments, respecting `upToId` boundaries. |
| `getAnchorId(channel, type, offset)` | Walks segments from leaf to root to find the Nth-from-last message of a given type. |

### Replay

When a client connects to a forked channel, the server:

1. Replays roster ops (presence events) from the **forked channel only** (not inherited from parent).
2. Resolves the fork chain via `resolveForkedSegments`.
3. Iterates each segment, querying messages with `queryRange(segment.channel, sinceId, segment.upToId)`.
4. Skips presence events in the replay (already covered by step 1).
5. Computes fork-aware ready metadata (`totalCount`, `chatMessageCount`, `firstChatMessageId`).

### Non-Fork-Affected Operations

These operations are scoped to the channel they are called on and are NOT fork-aware:

- `broadcast()` / `broadcastBinary()` — message emission only goes to subscribers of the current channel.
- `insert()` — messages are always inserted into the specified channel.
- `createChannel()` — channel creation is independent of fork relationships.
- `query()` / `queryByType()` — these query a single channel only. Use `queryRange` + `resolveForkedSegments` for fork-aware queries.

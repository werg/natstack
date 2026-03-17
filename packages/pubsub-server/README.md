# pubsub-server (deprecated)

> **Note:** The standalone PubSub server has been replaced by the **Channel DO** (Durable Object). Channels now run as DOs in workerd with SQLite-backed storage. Worker DOs communicate with channels directly via `callDO()` / `stub.fetch()` instead of HTTP POST to a separate server process.
>
> For the current channel architecture, see:
> - `workspace/workers/README.md` — Worker authoring guide with ChannelClient API
> - `workspace/skills/paneldev/WORKERS.md` — Reference for AI agents building workers
> - `docs/agentic-architecture.md` — Full architecture overview

## Channel Forking (preserved in Channel DO)

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

### Fork-Aware Query Behavior

The following methods automatically resolve the fork chain and aggregate results across all segments:

| Method | Behavior |
|--------|----------|
| `getMessageCount(channel, type?)` | Sums counts across all segments, respecting each segment's `upToId` boundary. |
| `getMinMessageId(channel, type?)` | Returns the minimum message ID across all segments. |
| `queryBefore(channel, beforeId, limit)` | Paginates from the leaf segment backward through parent segments until `limit` is satisfied. |
| `queryTrailingUpdates(channel, uuids, atOrAfterId)` | Searches for update/error events across all segments, respecting `upToId` boundaries. |
| `getAnchorId(channel, type, offset)` | Walks segments from leaf to root to find the Nth-from-last message of a given type. |

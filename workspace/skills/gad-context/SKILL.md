---
name: gad-context
description: >-
  Use this skill when the user asks about Pi/gad history, provenance, why code
  changed, assumptions behind a change, branch context, tracked edits, or gad.
  Query NatStack's immutable gad service for branches, history items, message
  blocks, tool calls, file activity, branch heads, state roots, and semantic
  indexes.
---

# gad Context

gad is NatStack's immutable workspace provenance database. It is exposed through
the runtime `gad` service, backed by the `gad-store` workspace durable object and
the workspace blobstore.

Core model:

- `gad_history_items` is the authoritative append-only Pi history DAG.
- `gad_branches` are mutable heads that point at immutable history and state
  hashes.
- `gad_state_roots` point at persistent manifest trees. `gad_manifest_nodes`
  are content-addressed directory nodes; `gad_manifest_entries` links each
  directory entry name to either a child manifest hash or a file version.
- `pi_messages_view`, `pi_message_blocks_view`, `gad_tool_calls_view`, and
  `gad_file_activity_view` are rebuildable read models.
- Blob bytes live in the builtin blobstore; `gad_blobs` stores metadata.
- Direct writes to authoritative tables are break-glass operations.

Use `gad.query(sql, bindings)` for reads. Panels and workers may call
`gad.rawSql(sql, bindings)` for arbitrary SQL. Non-read-only SQL is gated by
the userland approval UI.

```ts
import { gad } from "@workspace/runtime";

const { rows } = await gad.query(
  "SELECT id, head_history_hash, head_state_hash FROM gad_branches ORDER BY updated_at DESC LIMIT ?",
  [10],
);
```

## Common Queries

### Status

```ts
await gad.status();
```

### Recent Branches

```sql
SELECT id, channel_id, context_id, parent_branch_id,
       head_history_hash, head_state_hash, dirty, updated_at
FROM gad_branches
ORDER BY updated_at DESC
LIMIT 20;
```

### Branch History

```sql
SELECT history_id, history_hash, parent_hash, kind, actor, message_id, block_id, tool_call_id,
       input_state_hash, output_state_hash, created_at
FROM gad_branch_history_view
WHERE branch_id = ?
ORDER BY history_id;
```

### Materialized Messages

Prefer the service API when reconstructing chat history:

```ts
const { messages } = await gad.materializePiMessages({ branchId });
```

Or inspect the read model:

```sql
SELECT idx, message_id, role, message_json, finalized
FROM pi_messages_view
WHERE branch_id = ?
ORDER BY idx;
```

### Message Blocks

```sql
SELECT message_id, block_id, block_idx, block_type, tool_call_id, tool_name,
       SUBSTR(text, 1, 800) AS preview
FROM pi_message_blocks_view
WHERE branch_id = ?
ORDER BY message_id, block_idx;
```

### Tool Calls

```sql
SELECT tool_call_id, message_id, block_id, tool_name, provider_handle,
       status, result_summary, requested_history_hash, completed_history_hash
FROM gad_tool_calls_view
WHERE branch_id = ?
ORDER BY id;
```

### File Activity

```sql
SELECT operation, path, before_hash, after_hash,
       input_state_hash, output_state_hash, history_hash
FROM gad_file_activity_view
WHERE branch_id = ?
ORDER BY id;
```

### Branches

```sql
SELECT id, name, channel_id, context_id, parent_branch_id,
       forked_from_history_id, forked_from_state_hash,
       head_history_hash, head_state_hash, dirty, updated_at
FROM gad_branches
ORDER BY updated_at DESC;
```

### Branch Files

Use the service API to list files at a branch head:

```ts
const files = await gad.listGadBranchFiles({ branchId });
```

Use tree-aware APIs for point reads and diffs:

```ts
const file = await gad.readGadFileAtState({ stateHash, path: "src/index.ts" });
const diff = await gad.diffGadStates({ leftStateHash, rightStateHash });
```

Raw SQL over manifests should treat entries as a tree, not as flat paths:

```sql
SELECT parent_hash, name, entry_kind, child_manifest_hash, file_version_id
FROM gad_manifest_entries
WHERE parent_hash = ?;
```

### Raw History Append

Agents should normally let the Pi harness append history. For custom workers,
append immutable facts through the service API:

```ts
const head = await gad.getGadBranchHead({ branchId });
await gad.appendGadHistoryBatch({
  branchId: head.branchId,
  expectedHeadHash: head.headHistoryHash,
  expectedStateHash: head.headStateHash,
  items: [{
    kind: "system_event",
    actor: "worker",
    payload: { note: "indexed external source" },
  }],
});
```

## Writing SQL

Use raw writes sparingly. Approved writes to immutable/head tables mark branches
or workspaces dirty and should be followed by validation/rebuild:

```ts
await gad.rawSql("UPDATE gad_branches SET dirty = 1 WHERE id = ?", [branchId]);
await gad.validateGadHashes({});
```

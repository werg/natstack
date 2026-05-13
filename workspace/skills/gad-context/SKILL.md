---
name: gad-context
description: >-
  Use this skill when the user asks about Pi/gad trajectory, provenance, why code
  changed, assumptions behind a change, branch context, tracked edits, or gad.
  Query NatStack's immutable gad service for branches, trajectory items,
  message blocks, tool calls, state transitions, file blame, branch heads, and
  semantic sidecars.
---

# gad Context

gad is NatStack's immutable workspace provenance database. It is exposed through
the runtime `gad` service, backed by the `gad-store` workspace durable object and
the workspace blobstore.

Core model:

- `gad_trajectory_items` is the authoritative append-only Pi trajectory DAG.
- `gad_branches` are mutable heads that point at immutable trajectory and state
  hashes. Compatibility `head_history_*` fields remain for older callers.
- `gad_state_transitions` records only real workspace state changes.
- `gad_file_change_hunks` and `gad_file_blame_segments` connect file regions
  directly back to the trajectory/tool call that edited them.
- `gad_state_roots` point at persistent manifest trees. `gad_manifest_nodes`
  are content-addressed directory nodes; `gad_manifest_entries` links each
  directory entry name to either a child manifest hash or a file version.
- `pi_messages_view`, `pi_message_blocks_view`, `gad_tool_calls`, and
  `gad_file_activity_view` are rebuildable read models.
- `gad_claims`, `gad_claim_edges`, `gad_theories`,
  `gad_theory_versions`, and `gad_contradictions` are semantic sidecars.
- Blob bytes live in the builtin blobstore; `gad_blobs` stores metadata.
- Direct writes to authoritative tables are break-glass operations.

Use `gad.query(sql, bindings)` for reads. Panels and workers may call
`gad.rawSql(sql, bindings)` for arbitrary SQL. Non-read-only SQL is gated by
the userland approval UI.

```ts
import { gad } from "@workspace/runtime";

const { rows } = await gad.query(
  "SELECT id, head_trajectory_hash, head_state_hash FROM gad_branches ORDER BY updated_at DESC LIMIT ?",
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
       head_trajectory_hash, head_state_hash, dirty, updated_at
FROM gad_branches
ORDER BY updated_at DESC
LIMIT 20;
```

### Branch Trajectory

```sql
SELECT trajectory_id, trajectory_hash, parent_hash, kind, actor, message_id, block_id, tool_call_id,
       input_state_hash, output_state_hash, created_at
FROM gad_branch_trajectory_view
WHERE branch_id = ?
ORDER BY trajectory_id;
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
       status, result_summary, request_trajectory_id, result_trajectory_id
FROM gad_tool_calls
WHERE branch_id = ?
ORDER BY id;
```

### State Producer

Prefer the service API:

```ts
const producer = await gad.getGadStateProducer({ stateHash, branchId });
```

Or query the sidecar:

```sql
SELECT st.*, ti.kind, ti.actor, tc.tool_name
FROM gad_state_transitions st
JOIN gad_trajectory_items ti ON ti.id = st.trajectory_id
LEFT JOIN gad_tool_calls tc ON tc.tool_call_id = st.tool_call_id
WHERE st.output_state_hash = ?;
```

### Snippet Blame

```ts
const rows = await gad.blameGadFileSnippet({
  stateHash,
  path: "src/index.ts",
  startLine: 10,
  endLine: 12,
});
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
       forked_from_trajectory_id, forked_from_state_hash,
       head_trajectory_hash, head_state_hash, dirty, updated_at
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

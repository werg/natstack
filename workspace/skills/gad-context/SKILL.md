---
name: gad-context
description: >-
  Use this skill when the user asks about Pi/gad trajectory, provenance, why code
  changed, assumptions behind a change, branch context, tracked edits, or gad.
  Query NatStack's immutable gad service for branches, recursive trajectory
  chains, message blocks, tool calls, state transitions, file hunks, branch
  heads, and semantic sidecars.
---

# gad Context

gad is NatStack's immutable workspace provenance database. It is exposed through
the runtime `gad` service, backed by the `gad-store` workspace durable object and
the workspace blobstore.

Core model:

- `gad_trajectory_items` is the authoritative append-only Pi trajectory DAG.
- Branch history is not stored in a membership table. Start from
  `gad_branches.head_trajectory_id` and recursively walk
  `gad_trajectory_items.parent_id`.
- `gad_branches` are mutable heads that point at immutable trajectory and state
  hashes.
- `introduced_on_branch_id` records where an item was first appended. It is not
  branch membership.
- `gad_state_transitions` records only real workspace state changes.
  Non-mutating trajectory items have no transition row and no output state.
- `gad_file_change_hunks` connects file regions directly back to the trajectory
  item that edited them.
- Tool calls are reconstructed from `tool_call_requested` and
  `tool_result_observed` trajectory items sharing `tool_call_id`.
- Pi messages are materialized by folding the recursive branch trajectory joined
  to `gad_payloads`.
- `gad_claims`, `gad_claim_edges`, `gad_theories`,
  `gad_theory_versions`, and `gad_contradictions` are semantic sidecars.
- `gad_state_roots` point at persistent manifest trees. `gad_manifest_nodes`
  are content-addressed directory nodes; `gad_manifest_entries` links each
  directory entry name to either a child manifest hash or a file version.
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
WITH RECURSIVE branch_chain AS (
  SELECT ti.*
  FROM gad_branches b
  JOIN gad_trajectory_items ti
    ON ti.workspace_id = b.workspace_id
   AND ti.id = b.head_trajectory_id
  WHERE b.workspace_id = ?
    AND b.id = ?
    AND b.head_trajectory_id IS NOT NULL

  UNION ALL

  SELECT parent.*
  FROM gad_trajectory_items parent
  JOIN branch_chain child
    ON parent.workspace_id = child.workspace_id
   AND parent.id = child.parent_id
)
SELECT id AS trajectory_id, hash AS trajectory_hash, parent_hash,
       introduced_on_branch_id, kind, actor, message_id, block_id, tool_call_id,
       input_state_hash, output_state_hash, created_at
FROM branch_chain
ORDER BY trajectory_id;
```

For more complete SQL recipes, see `docs/gad-query-recipes.md`.

### Materialized Messages

Prefer the service API when reconstructing chat history:

```ts
const { messages } = await gad.materializePiMessages({ branchId });
```

Or inspect canonical message trajectory items:

```sql
WITH RECURSIVE branch_chain AS (
  SELECT ti.*
  FROM gad_branches b
  JOIN gad_trajectory_items ti
    ON ti.workspace_id = b.workspace_id
   AND ti.id = b.head_trajectory_id
  WHERE b.workspace_id = ? AND b.id = ?
  UNION ALL
  SELECT parent.*
  FROM gad_trajectory_items parent
  JOIN branch_chain child
    ON parent.workspace_id = child.workspace_id
   AND parent.id = child.parent_id
)
SELECT bc.id AS trajectory_id, bc.kind, bc.message_id, bc.block_id, p.json
FROM branch_chain bc
LEFT JOIN gad_payloads p
  ON p.workspace_id = bc.workspace_id
 AND p.hash = bc.payload_hash
WHERE bc.kind IN ('message_created', 'message_block_added', 'message_finalized', 'tool_result_observed')
ORDER BY bc.id;
```

### Tool Calls

```sql
WITH RECURSIVE branch_chain AS (
  SELECT ti.*
  FROM gad_branches b
  JOIN gad_trajectory_items ti
    ON ti.workspace_id = b.workspace_id
   AND ti.id = b.head_trajectory_id
  WHERE b.workspace_id = ? AND b.id = ?
  UNION ALL
  SELECT parent.*
  FROM gad_trajectory_items parent
  JOIN branch_chain child
    ON parent.workspace_id = child.workspace_id
   AND parent.id = child.parent_id
)
SELECT id AS trajectory_id, hash AS trajectory_hash, kind, message_id,
       block_id, tool_call_id, payload_hash, created_at
FROM branch_chain
WHERE tool_call_id = ?
ORDER BY id;
```

### State Producer

Prefer the service API:

```ts
const producer = await gad.getGadStateProducer({ stateHash, branchId });
```

Or query the sidecar through the branch chain:

```sql
WITH RECURSIVE branch_chain AS (
  SELECT ti.*
  FROM gad_branches b
  JOIN gad_trajectory_items ti
    ON ti.workspace_id = b.workspace_id
   AND ti.id = b.head_trajectory_id
  WHERE b.workspace_id = ? AND b.id = ?
  UNION ALL
  SELECT parent.*
  FROM gad_trajectory_items parent
  JOIN branch_chain child
    ON parent.workspace_id = child.workspace_id
   AND parent.id = child.parent_id
)
SELECT st.*, bc.hash AS trajectory_hash, bc.kind, bc.actor,
       bc.message_id, bc.block_id, bc.tool_call_id
FROM gad_state_transitions st
JOIN branch_chain bc
  ON bc.workspace_id = st.workspace_id
 AND bc.id = st.trajectory_id
WHERE st.output_state_hash = ?;
```

### Snippet Blame

Snippet blame walks file-version ancestry through `gad_file_change_hunks` so an
unchanged line in a later file version can still trace back to the earlier
trajectory item that introduced it.

```ts
const rows = await gad.blameGadFileSnippet({
  stateHash,
  path: "src/index.ts",
  startLine: 10,
  endLine: 12,
});
```

### Integrity

```ts
const result = await gad.checkGadIntegrity({ branchId });
```

Use this for structured graph/sidecar validation. Use `validateGadHashes` only
when you specifically need hash recomputation and dirty clearing.

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

### Raw Trajectory Append

Agents should normally let the Pi harness append trajectory items. For custom
workers, append immutable facts through the service API:

```ts
const head = await gad.getGadBranchHead({ branchId });
await gad.appendGadTrajectoryBatch({
  branchId: head.branchId,
  expectedTrajectoryHash: head.headTrajectoryHash,
  expectedStateHash: head.headStateHash,
  items: [{
    kind: "system_event",
    actor: "worker",
    payload: { note: "indexed external source" },
  }],
});
```

## Writing SQL

Use raw writes sparingly. Approved writes to immutable/head/sidecar tables mark
branches or workspaces dirty and should be followed by validation.

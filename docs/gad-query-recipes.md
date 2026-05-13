# Gad Query Recipes

Gad uses canonical trajectory rows plus recursive queries. Do not add
branch-local membership tables, precomputed tool-call tables, Pi message tables,
file activity views, or blame segment caches to avoid these traversals.

## Branch Trajectory

Start from the branch head and walk `parent_id`:

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
       introduced_on_branch_id, kind, actor, message_id, block_id,
       tool_call_id, input_state_hash, output_state_hash, created_at
FROM branch_chain
ORDER BY trajectory_id;
```

`introduced_on_branch_id` is append-origin metadata. It is not membership.

## Pi Messages

Use the service API for runtime history:

```ts
const { messages } = await gad.materializePiMessages({ branchId });
```

This folds the recursive branch trajectory and loads canonical payloads from
`gad_payloads`. It is not backed by a stored Pi message projection.

## State Producer

For branch-scoped state provenance, intersect `gad_state_transitions` with the
branch chain:

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

Non-mutating trajectory items have no state transition row.

## Tool Provenance

Tool calls are reconstructed from branch-chain rows sharing `tool_call_id`:

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
SELECT bc.id AS trajectory_id, bc.hash AS trajectory_hash, bc.kind,
       bc.message_id, bc.block_id, bc.tool_call_id, p.json AS payload_json
FROM branch_chain bc
LEFT JOIN gad_payloads p
  ON p.workspace_id = bc.workspace_id
 AND p.hash = bc.payload_hash
WHERE bc.tool_call_id = ?
ORDER BY bc.id;
```

A healthy chain has a `tool_call_requested` before its
`tool_result_observed`.

## File Lineage And Snippet Blame

Start from the file version at a state, then walk hunk lineage through
`before_file_version_id`:

```sql
WITH RECURSIVE file_lineage AS (
  SELECT h.*, 0 AS depth
  FROM gad_file_change_hunks h
  WHERE h.workspace_id = ?
    AND h.path = ?
    AND h.after_file_version_id = ?

  UNION ALL

  SELECT parent.*, file_lineage.depth + 1 AS depth
  FROM gad_file_change_hunks parent
  JOIN file_lineage
    ON parent.workspace_id = file_lineage.workspace_id
   AND parent.path = file_lineage.path
   AND parent.after_file_version_id = file_lineage.before_file_version_id
)
SELECT fl.*, ti.hash AS origin_trajectory_hash, ti.kind, ti.actor,
       ti.message_id, ti.block_id, ti.tool_call_id
FROM file_lineage fl
JOIN gad_trajectory_items ti
  ON ti.workspace_id = fl.workspace_id
 AND ti.id = fl.trajectory_id
ORDER BY fl.depth;
```

`gad.blameGadFileSnippet(...)` applies line-range translation over this lineage.
If a requested range spans multiple independently edited regions, the current
API returns the first overlapping hunk rather than split line-by-line blame.

## Artifact To User Message

Use this trace order:

1. Find the artifact state, file version, hunk, tool call, or trajectory item.
2. Join to `gad_trajectory_items`.
3. If branch context matters, require the trajectory id to appear in the
   recursive branch chain.
4. Follow `tool_call_id` to request/result trajectory rows when present.
5. Follow `message_id` and `block_id` to message trajectory rows and payloads.
6. Prefer user `message_block_added` payloads as the grounding text.

## Theory Updates And Contradictions

Semantic sidecars point back to trajectory ids:

```sql
SELECT tv.*, ti.hash AS trajectory_hash, ti.kind, ti.actor
FROM gad_theory_versions tv
JOIN gad_trajectory_items ti
  ON ti.workspace_id = tv.workspace_id
 AND ti.id = tv.trajectory_id
WHERE tv.workspace_id = ? AND tv.theory_id = ?
ORDER BY tv.id;
```

```sql
SELECT c.*, ti.hash AS detected_trajectory_hash, ti.kind, ti.actor
FROM gad_contradictions c
JOIN gad_trajectory_items ti
  ON ti.workspace_id = c.workspace_id
 AND ti.id = c.detected_trajectory_id
WHERE c.workspace_id = ?
ORDER BY c.id;
```

Use the same branch-chain intersection when reviewing semantic facts in a
specific branch.

## Integrity Checks

Use the service API for graph validation:

```ts
const result = await gad.checkGadIntegrity({ branchId });
```

It reports structured errors for broken parent pointers, branch heads, state
transition rows, file hunk lineage, and tool request/result chains. It does not
repair data. Use `validateGadHashes` for hash recomputation and dirty clearing.

---
name: gad-review
description: >-
  Use this skill when reviewing changes, planning changes, or asking whether
  an edit is justified by user intent. Treat immutable gad trajectory as the
  provenance graph and trace artifacts back to user message blocks.
---

# gad Review

You are reviewing NatStack's immutable gad graph.

The review question is:

> Does this artifact trace back to a statement the user actually made, and does
> anything in scope contradict any user statement?

Authority order:

1. User message blocks folded from the recursive branch trajectory.
2. Tool request/result trajectory items sharing `tool_call_id`.
3. File hunks, state transitions, and tree manifest entries linked directly to
   trajectory ids.
4. Plans, chunks, embeddings, and parsed structures, which are derived.

## Prerequisites

Verify the branch head:

```sql
SELECT id, head_trajectory_id, head_trajectory_hash, head_state_hash,
       dirty, updated_at
FROM gad_branches
WHERE id = ?;
```

Then build the branch chain recursively:

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
SELECT kind, COUNT(*) AS count
FROM branch_chain
GROUP BY kind
ORDER BY kind;
```

If `dirty = 1`, report that raw SQL or external drift may have invalidated
normal provenance until validation succeeds.

For graph-level validation, use:

```ts
const integrity = await gad.checkGadIntegrity({ branchId });
```

Treat any integrity error as a provenance caveat before making claims about
grounding.

## Starting Frontier

- Branch id: start from `gad_branches`, then recurse through
  `gad_trajectory_items.parent_id`.
- File provenance: start from `gad_file_change_hunks`, then expand to
  `gad_state_transitions`, `gad_trajectory_items`, and message/tool payloads.
- Branch question: start from branch head hashes, then use the recursive branch
  chain.
- Tool question: start from branch-chain rows with the same `tool_call_id`.
- State question: start from `gad_state_transitions`, then join to the branch
  chain by `trajectory_id`.
- Snippet question: use `gad.blameGadFileSnippet(...)`.

## Expansion Operators

### From A User Message

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
WHERE bc.kind IN ('message_created', 'message_block_added')
ORDER BY bc.id;
```

### From A Tool Call

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
SELECT bc.id AS trajectory_id, bc.hash AS trajectory_hash, bc.kind, bc.actor,
       bc.message_id, bc.block_id, bc.tool_call_id,
       bc.input_state_hash, bc.output_state_hash, p.json AS payload_json
FROM branch_chain bc
LEFT JOIN gad_payloads p
  ON p.workspace_id = bc.workspace_id
 AND p.hash = bc.payload_hash
WHERE bc.tool_call_id = ?
ORDER BY bc.id;
```

### From File Provenance

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

For branch-scoped review, intersect those `trajectory_id` values with the
recursive branch chain.

### From A State

```sql
SELECT st.*, ti.hash AS trajectory_hash, ti.kind, ti.actor,
       ti.message_id, ti.block_id, ti.tool_call_id
FROM gad_state_transitions st
JOIN gad_trajectory_items ti
  ON ti.workspace_id = st.workspace_id
 AND ti.id = st.trajectory_id
WHERE st.output_state_hash = ?;
```

For branch-scoped review, require that `st.trajectory_id` appears in the
recursive branch chain.

### From A Branch

```sql
SELECT id, parent_branch_id, forked_from_trajectory_id, forked_from_state_hash,
       head_trajectory_id, head_trajectory_hash, head_state_hash, dirty
FROM gad_branches
WHERE id = ?;
```

Use `gad.listGadBranchFiles({ branchId })` to inspect the branch's current
Pi-mediated state.

For state comparisons, prefer `gad.diffGadStates({ leftStateHash,
rightStateHash })`; it walks the manifest tree and skips unchanged subtrees by
hash. For a specific file, use `gad.readGadFileAtState({ stateHash, path })`.

## Judgment Rules

- If an edit cannot be traced to a user message or a tool result requested by a
  user-driven assistant turn, call that out.
- If a branch is dirty, state that provenance may be invalid until validation.
- If semantic chunks or plans contradict materialized user messages, trust the
  materialized user messages.
- If a tool result exists without a matching `tool_call_requested`, report a
  broken provenance chain.
- For reusable SQL patterns, consult `docs/gad-query-recipes.md`.

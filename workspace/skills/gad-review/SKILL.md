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

1. User message blocks materialized from `gad_trajectory_items`.
2. Tool request/result history linked by `(branch_id, tool_call_id)`.
3. File activity, state hashes, and tree manifest entries.
4. Plans, chunks, embeddings, and parsed structures, which are derived.

## Prerequisites

Verify the branch head and runtime-critical read models:

```sql
SELECT id, head_trajectory_hash, head_state_hash, dirty, updated_at
FROM gad_branches
WHERE id = ?;
```

```sql
SELECT kind, COUNT(*) AS count
FROM gad_branch_trajectory_view
WHERE branch_id = ?
GROUP BY kind
ORDER BY kind;
```

If `dirty = 1`, report that raw SQL or external drift may have invalidated
normal provenance until validation succeeds.

## Starting Frontier

- Branch id: start from `gad_branch_trajectory_view` for that branch.
- File list: start from `gad_file_activity_view` for those paths.
- Branch question: start from `gad_branches` and the branch head hashes.
- Tool question: start from `gad_tool_calls`.
- State question: start from `gad_state_transitions`.
- Snippet question: use `gad.blameGadFileSnippet(...)`.

## Expansion Operators

### From A User Message

```sql
SELECT m.idx, b.message_id, b.block_id, b.block_idx, b.text
FROM pi_messages_view m
JOIN pi_message_blocks_view b
  ON b.branch_id = m.branch_id AND b.message_id = m.message_id
WHERE m.branch_id = ? AND m.role = 'user'
ORDER BY m.idx, b.block_idx;
```

### From A Tool Call

```sql
SELECT *
FROM gad_tool_calls
WHERE branch_id = ? AND tool_call_id = ?;
```

```sql
SELECT trajectory_id, trajectory_hash, kind, actor, message_id, block_id,
       input_state_hash, output_state_hash, created_at
FROM gad_branch_trajectory_view
WHERE branch_id = ? AND tool_call_id = ?
ORDER BY trajectory_id;
```

### From File Activity

```sql
SELECT operation, path, before_hash, after_hash, input_state_hash,
       output_state_hash, history_hash
FROM gad_file_activity_view
WHERE path = ?
ORDER BY id DESC
LIMIT 20;
```

### From A Branch

```sql
SELECT id, parent_branch_id, forked_from_trajectory_id, forked_from_state_hash,
       head_trajectory_hash, head_state_hash, dirty
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
- If a branch is dirty, do not rely on derived read models alone.
- If semantic chunks or plans contradict materialized user messages, trust the
  materialized user messages.
- If a tool result exists without a matching `tool_call_requested`, report a
  broken provenance chain.

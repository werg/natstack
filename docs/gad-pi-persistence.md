# Gad Trajectory Persistence

Gad is the authoritative persistence system for Pi-mediated agent trajectories,
workspace state, and semantic provenance. Agent DOs keep execution-local state
only: runner lifecycle, subscriptions, delivery cursors, dispatched calls,
approval metadata, and a cached gad head.

This is personal software and a bounded local system. The storage model favors
clear provenance and simple reasoning over precomputed branch-local tables.
Branch history is therefore a recursive query over the canonical trajectory
parent chain, not a materialized membership table.

## Model

- `gad_trajectory_items` is the canonical append-only trajectory DAG. Every
  message, tool call, file mutation, claim, contradiction, and theory update has
  one trajectory identity.
- Each trajectory item has `parent_id` and `parent_hash`. Forks are represented
  by new branch refs that point at an existing trajectory item; inherited history
  is discovered by walking parents.
- `gad_branches` are mutable refs into the DAG. They keep the branch head
  trajectory and the current workspace state hash.
- `introduced_on_branch_id` on `gad_trajectory_items` is only where an item was
  first appended. It is not branch membership.
- There is no branch trajectory membership table, precomputed tool-call table,
  precomputed Pi message table, file activity view, or file blame segment cache.
- Sidecars join directly to trajectory ids when they store typed facts:
  `gad_state_transitions`, `gad_file_change_hunks`, `gad_claims`,
  `gad_claim_edges`, `gad_theories`, `gad_theory_versions`, and
  `gad_contradictions`.
- Runtime startup materializes `AgentMessage[]` by folding the recursive branch
  trajectory and reading canonical payloads from `gad_payloads`.
- Runtime writes use `appendGadTrajectoryBatch`, which inserts trajectory rows,
  payloads, state/tree rows, typed sidecars, and CAS-advances the branch head in
  one transaction.
- Workspace state is a persistent content-addressed manifest tree. Directory
  nodes live in `gad_manifest_nodes`; `gad_manifest_entries` links directory
  names to child manifest hashes or file versions.

## Recursive Branch Queries

The central branch operator is a recursive CTE from the branch head through
`gad_trajectory_items.parent_id`:

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
SELECT *
FROM branch_chain
ORDER BY id;
```

Use this CTE whenever a query says "for this branch" or "in this trajectory".
Do not add branch-local membership tables to avoid the recursive query.
See [gad-query-recipes.md](./gad-query-recipes.md) for copy-pasteable query
patterns.

## State Roots

Only mutating trajectory items produce state transitions. Non-mutating events
store `output_state_hash = NULL` and have no `gad_state_transitions` row.

To answer "what produced this state?", use:

```ts
const producer = await gad.getGadStateProducer({ stateHash, branchId });
```

or SQL:

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
SELECT st.*, ti.hash AS trajectory_hash, ti.kind, ti.actor,
       ti.message_id, ti.block_id, ti.tool_call_id
FROM gad_state_transitions st
JOIN branch_chain ti
  ON ti.workspace_id = st.workspace_id
 AND ti.id = st.trajectory_id
WHERE st.output_state_hash = ?;
```

## File Provenance

File mutations populate `gad_file_change_hunks`. A hunk points directly to the
trajectory item that edited the file. Snippet blame starts from the file version
at a state, finds overlapping hunks, then follows `trajectory_id` into the
recursive branch chain.

When a later edit does not touch the requested snippet, blame walks file-version
ancestry recursively through `before_file_version_id` until it finds the hunk
that last changed the requested lines:

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
SELECT *
FROM file_lineage
ORDER BY depth;
```

```ts
const blame = await gad.blameGadFileSnippet({
  stateHash,
  path: "src/index.ts",
  startLine: 10,
  endLine: 18,
});
```

The blame result includes the origin trajectory hash, kind, actor, and tool call
id. From there callers can continue to the tool request/result items, message
blocks, and user-directed trajectory.

If a requested range spans multiple independently edited regions, the current
snippet blame API returns the first overlapping hunk rather than split
line-by-line blame.

## Tool Calls

Tool calls are not a separate stored entity. They are reconstructed from
trajectory items:

- `tool_call_requested` records the request, message block, provider handle, and
  parameters in its payload.
- `tool_result_observed` records the result and completion status.
- Both rows share `tool_call_id`.

Branch-scoped tool call queries fold the recursive branch chain by
`tool_call_id`.

## Integrity

`checkGadIntegrity` validates graph shape and typed sidecars without mutating or
repairing data:

```ts
const integrity = await gad.checkGadIntegrity({ branchId });
```

It reports structured errors for broken trajectory parents, branch heads, state
transitions, file hunk lineage, and tool request/result chains.
`validateGadHashes` remains the hash recomputation and dirty-clearing path.

## Runtime APIs

```ts
const head = await gad.ensureGadBranch({ branchId, channelId, contextId });

await gad.appendGadTrajectoryBatch({
  branchId: head.branchId,
  expectedTrajectoryHash: head.headTrajectoryHash,
  expectedStateHash: head.headStateHash,
  items: [
    { kind: "message_created", messageId: "msg:0", payload: { role: "user" } },
    {
      kind: "message_block_added",
      messageId: "msg:0",
      blockId: "msg:0:block:0",
      payload: { block: { type: "text", text: "hello" } },
    },
    { kind: "message_finalized", messageId: "msg:0", payload: {} },
  ],
});

const { messages } = await gad.materializePiMessages({ branchId });
```

Semantic updates use the same trajectory spine:

```ts
await gad.appendGadTrajectoryBatch({
  branchId,
  expectedTrajectoryHash,
  expectedStateHash,
  items: [{
    kind: "claim_asserted",
    actor: "agent",
    payload: {
      text: "The artifact depends on the user's request to persist Pi trajectories.",
      relation: "supports",
    },
  }],
});
```

## Raw SQL

Panels and workers may use arbitrary read-only SQL. Non-read-only SQL goes
through userland approval. Writes to authoritative trajectory, head, state,
file, or semantic sidecar tables are break-glass operations and mark branches
dirty.

## Schema Reset

This is pre-release state. `GadWorkspaceDO` schema version 8 resets gad storage
to the recursive trajectory and sidecar schema. `AgentWorkerBase` schema version
11 removes local Pi persistence tables; Pi state lives in gad.

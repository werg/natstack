# Gad Trajectory Persistence

Gad is the authoritative persistence system for Pi-mediated agent trajectories,
workspace state, and semantic provenance. Agent DOs keep execution-local state
only: runner lifecycle, subscriptions, delivery cursors, dispatched calls,
approval metadata, and a cached gad head.

## Model

- `gad_trajectory_items` is the canonical append-only spine. Every message,
  tool call, file mutation, claim, contradiction, and theory update has one
  trajectory identity.
- `gad_branches` are mutable refs into that spine. They keep the current
  trajectory head and current workspace state hash.
- Sidecar tables join to trajectory ids for typed queries:
  - `gad_tool_calls`
  - `gad_state_transitions`
  - `gad_file_change_hunks`
  - `gad_file_blame_segments`
  - `gad_claims`, `gad_claim_edges`, `gad_theories`,
    `gad_theory_versions`, `gad_contradictions`
- Runtime startup materializes `AgentMessage[]` from projection tables.
- Runtime writes use `appendGadHistoryBatch`, which inserts trajectory rows,
  sidecar rows, projections, and CAS-advances the branch head in one
  transaction.
- Workspace state is a persistent content-addressed manifest tree. Directory
  nodes live in `gad_manifest_nodes`; `gad_manifest_entries` links directory
  names to child manifest hashes or file versions.
- Forks create a new branch ref pointing at an existing trajectory/state hash
  and copy derived projection rows, but never copy immutable trajectory rows.

Compatibility views named `gad_history_items`, `gad_branch_history_view`, and
`gad_tool_calls_view` remain available for older queries, but new code should
prefer trajectory and sidecar tables.

## State Roots

Only mutating trajectory items produce state transitions. Non-mutating events do
not store an output state hash. To answer "what produced this state?", use:

```ts
const producer = await gad.getGadStateProducer({ stateHash, branchId });
```

or SQL:

```sql
SELECT st.*, ti.kind, ti.actor, tc.tool_name
FROM gad_state_transitions st
JOIN gad_trajectory_items ti ON ti.id = st.trajectory_id
LEFT JOIN gad_tool_calls tc ON tc.tool_call_id = st.tool_call_id
WHERE st.output_state_hash = ?;
```

Blob bytes live in the builtin blobstore. Gad stores blob metadata and immutable
references.

State reads should go through tree-aware APIs:

```ts
const files = await gad.listGadBranchFiles({ branchId });
const file = await gad.readGadFileAtState({ stateHash, path: "src/index.ts" });
const diff = await gad.diffGadStates({ leftStateHash, rightStateHash });
```

## File Blame

File mutations populate `gad_file_change_hunks` and
`gad_file_blame_segments`. To trace a snippet back to the agentic trajectory and
tool call that introduced it:

```ts
const blame = await gad.blameGadFileSnippet({
  stateHash,
  path: "src/index.ts",
  startLine: 10,
  endLine: 18,
});
```

The blame result joins back to `gad_trajectory_items` and `gad_tool_calls`, so
callers can continue from the snippet to the tool call, message block, and
branch trajectory.

## Required Runtime APIs

```ts
const head = await gad.ensureGadBranch({ branchId, channelId, contextId });

await gad.appendGadHistoryBatch({
  branchId: head.branchId,
  expectedHeadHash: head.headHistoryHash,
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

Semantic updates use the same spine:

```ts
await gad.appendGadHistoryBatch({
  branchId,
  expectedHeadHash,
  expectedStateHash,
  items: [{
    kind: "claim_asserted",
    actor: "agent",
    payload: {
      text: "The artifact depends on the user's request to persist Pi history.",
      relation: "supports",
    },
  }],
});
```

## Raw SQL

Panels and workers may use arbitrary SQL. Read-only SQL executes directly.
Non-read-only SQL goes through userland approval. Writes to authoritative
trajectory/head/sidecar tables are break-glass operations: they mark state dirty
and normal append paths should validate/rebuild before continuing.

## Schema Reset

This is pre-release state. `GadWorkspaceDO` schema version 4 drops older local
schemas and recreates the trajectory and sidecar tables. `AgentWorkerBase`
schema version 10 drops local `pi_sessions` and `pi_messages`.

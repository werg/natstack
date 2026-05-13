# Immutable Gad/Pi Persistence

Gad is the authoritative persistence system for Pi-mediated branch history and
workspace provenance. Agent DOs keep execution-local state only: runner
lifecycle, subscriptions, delivery cursors, dispatched calls, approval metadata,
and a cached gad head.

## Model

- Durable chat history is an append-only DAG in `gad_history_items`.
- Branches are mutable heads in `gad_branches`.
- Runtime startup materializes `AgentMessage[]` from branch read models.
- Runtime writes use `appendGadHistoryBatch`, which inserts history rows and
  CAS-advances the branch head in one transaction.
- Workspace state is a persistent content-addressed manifest tree. Directory
  nodes live in `gad_manifest_nodes`; `gad_manifest_entries` links directory
  names to child manifest hashes or file versions. Unchanged subtrees keep the
  same hash across branches and state roots.
- Tool calls are identified by `(branch_id, tool_call_id)`.
- Forks create a new branch head pointing at an existing history item/state hash
  and copy derived projection rows, but never copy immutable history rows.

## State Roots

V1 keeps RuntimeFs as the execution filesystem. Gad state roots are authoritative
for Pi-mediated state, and all Pi file tools should keep RuntimeFs and gad state
consistent. External drift must be imported as `workspace_observed` or
`file_observed` history before it is treated as branch state.

Blob bytes live in the builtin blobstore. Gad stores blob metadata and immutable
references.

State reads should go through tree-aware APIs:

```ts
const files = await gad.listGadBranchFiles({ branchId });
const file = await gad.readGadFileAtState({ stateHash, path: "src/index.ts" });
const diff = await gad.diffGadStates({ leftStateHash, rightStateHash });
```

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

## Raw SQL

Panels and workers may use arbitrary SQL. Read-only SQL executes directly.
Non-read-only SQL goes through userland approval. Writes to immutable/head tables
are break-glass operations: they mark state dirty and normal append paths should
validate/rebuild before continuing.

## Schema Reset

This is pre-release state. `GadWorkspaceDO` schema version 4 drops the older
mutable-turn schema and recreates the immutable tables. `AgentWorkerBase` schema
version 10 drops local `pi_sessions` and `pi_messages`.

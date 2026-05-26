# GAD Architecture

GAD is the workspace provenance system. It is split into two ledgers with different visibility rules:

- Pi entries are the model-visible conversation branch. They store messages, model changes, compactions, labels, summaries, and other entries that can be materialized back into prompt context.
- GAD events are sidecar provenance. They store tool dispatches, file observations and mutations, approvals, branch events, system events, claims, theories, contradictions, and indexing work. They are never implicitly materialized into Pi context.

There is no legacy trajectory compatibility layer. The store starts from the clean `pi_*` and `gad_*` schema and drops old persistence tables when initialized.

## Stored Values

SQLite rows are indexes, not blob containers. Any protocol field that can grow without a strict product bound is encoded as a `natstack.blob-ref.v1` stored value before it reaches GAD. Producers call the shared `encodeAgenticEventStoredValues` / `encodeChannelPayloadStoredValues` helpers with a blobstore writer; GAD rejects raw unbounded fields such as invocation `request`, invocation `result`, approval `details`, system `details`, custom `update`, UI `props`, and message type `source`.

Trajectory and channel tables therefore use `*_ref_json` columns. These columns contain bounded payloads, previews, and content-addressed blob references. GAD also maintains `trajectory_blob_refs` and `channel_blob_refs` indexes so diagnostics, hydration tools, and blob lifetime management can find every referenced digest. Full bytes are read through blobstore APIs; default trajectory/channel reads stay ref-only unless a caller explicitly hydrates a stored value.

## Pi Branches

`pi_branches` points at a head Pi entry and a head worktree state. `appendPiEntryBatch` appends entries with optimistic checks for `expectedHeadEntryHash` and `expectedStateHash`.

Each Pi entry records:

- `parent_entry_id` and `parent_entry_hash`
- `entry_hash`, computed from canonical Pi entry content
- `pre_state_hash` and `post_state_hash`
- raw entry JSON plus projected columns for message blocks, tool calls, model changes, and compaction boundaries

`materializePiMessages` walks the selected branch and applies compaction rules before returning model-visible messages.

## GAD Events

`gad_events` is an append-only Merkle chain. Every event hash covers:

- previous event hash
- event id and kind
- anchor kind and id
- canonical payload
- canonical metadata

Projection tables are derived from this log. `replayGadEvents` clears projections and rebuilds them from ordered events. Event rows themselves are not rewritten during replay.

## Worktree States

Worktree states are content-addressed:

- file versions point to blob hashes and modes
- manifest nodes form a recursive tree
- manifest hashes cover sorted child directories and files
- state hashes cover the manifest root hash

File mutation events produce state transitions. A successful observed mutation records the input state, output state, mutation row, and one or more file change hunks. Payload-supplied hunks preserve line ranges and text hashes; otherwise the projection records a coarse whole-file hunk.

## Lifecycle Projections

Dispatches and approvals are state machines:

- dispatches must start with `dispatch_pending`
- pending dispatches may become resolved or abandoned once
- approvals must start with `approval_requested`
- approvals may be resolved once

Out-of-order or duplicate terminal events are rejected at projection time.

## Integrity

`checkGadIntegrity` verifies:

- Pi parent links and entry hashes
- Pi branch heads and head states
- GAD event chain hashes
- worktree state hashes
- manifest hashes
- state transition input/output state existence
- file mutation transition links

`validateGadHashes` is a string-oriented wrapper around the same integrity checks. `clearDirtyAfterValidation` currently delegates to validation because this clean store does not keep a separate dirty-bit migration path.

## Index Jobs

`gad_index_jobs` tracks asynchronous indexing work with explicit lifecycle methods:

- `enqueueGadIndexJob`
- `claimGadIndexJobs`
- `completeGadIndexJob`
- `failGadIndexJob`
- `listGadIndexJobs`
- `processGadIndexJobs`

Jobs can be queued, running, retry, failed, or complete. Failed jobs are requeued by enqueueing the same source/job pair again. Status metrics expose queued/retry, running, and failed counts.

## Operational Surface

The GAD browser panel exposes branch, entry, event, file, tool-call, integrity, and status views. It can refresh data, run integrity checks, validate hashes, and replay GAD event projections.

Raw SQL is read-only through the service and store. Production writes must go through typed GAD methods so they preserve event hashes, projections, and lifecycle rules.

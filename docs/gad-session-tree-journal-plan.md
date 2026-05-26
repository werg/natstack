# Pi Entry DAG And GAD Sidecar Event Model

This is the target persistence design for agent conversations, tool execution,
worktree state, and GAD provenance.

The current mixed `gad_trajectory_items` model is not trusted enough to preserve
for compatibility. This design starts from first principles:

- Pi owns the canonical model-visible conversation.
- Worktree state is a separate world model.
- Runtime, audit, and semantic facts are GAD sidecars.
- Derived query data is maintained transactionally from canonical facts.

The central split is:

```text
Pi entry DAG:
  model-visible session entries and their normalized content blocks

GAD sidecar event log:
  append-only runtime/world/semantic events anchored to Pi/world entities

Typed GAD projections:
  queryable tables derived from GAD sidecar events

GAD worktree state graph:
  git-like content-addressed blobs, manifest trees, state hashes, transitions,
  diffs, branch refs, and blame metadata
```

There are no fake transcript placeholders, no mixed Pi/GAD branch rows, and no
GAD provenance rows in Pi context.

## Core Decisions

1. Pi session entries form an immutable DAG.
2. Branches are named heads pointing into that DAG.
3. Pi entries do not have `branch_id`; branch membership is determined by
   walking from a branch head to root.
4. Each Pi entry records `pre_state_hash` and `post_state_hash`.
5. `pi_branches.head_state_hash` is a cache of the head entry's
   `post_state_hash`, not an independent source of truth.
6. Message blocks are normalized because they are real nested entities.
7. Tool calls are normalized because sidecars need a stable join target.
8. Tool results are not a separate table; a tool result is a Pi message.
9. Dispatch lifecycle is GAD-only. Pi history contains exactly one real
   `toolResult` message per resolved tool call.
10. GAD sidecars use one append-only event log for replay/audit, plus typed
    projection tables for queries.
11. Sidecars use a unified anchor convention.
12. Hashing is explicit: Pi entries form a Merkle chain, and GAD events form an
    event Merkle chain.
13. Raw Pi JSON is retained for exact reconstruction at the Pi boundary, but
    queryable fields are columns.
14. GAD remains a git replacement through its worktree state graph, not through the
    mixed Pi/GAD trajectory log.
15. `post_state_hash` is immutable once a Pi entry is appended because it is
    part of the Pi entry Merkle hash.
16. Worktree mutations must be finalized before appending the Pi entry whose
    `post_state_hash` reflects them.
17. `gad_events` is the canonical sidecar audit/replay log. Typed GAD tables are
    projections from it.
18. Approvals are their own sidecar domain, not a dispatch kind.
19. The durable object's SQLite database is already scoped to one Natstack
    workspace. The target schema therefore does not carry a `workspace_id`
    tenant column.
20. If the same database ever needs to represent multiple repo roots or working
    directories, introduce an explicit `project_id` or `project_root_id`.
    Do not call that dimension `workspace_id`.

## Scope And Naming

`workspace` is a Natstack deployment/runtime boundary. The durable object and
its SQLite database are already scoped to that workspace, so the schema does not
store a workspace tenant key.

The git-like file model in this document is called the worktree model:

- `gad_worktree_states` stores immutable file tree snapshots.
- `gad_state_transitions` stores edges between worktree states.
- file paths are relative to the tracked worktree root.

If one Natstack workspace later needs multiple independent tracked roots, add a
separate project dimension:

```sql
CREATE TABLE gad_projects (
  project_id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  name TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

In that version, tables that represent worktree-specific facts would carry
`project_id`, and global Pi/session tables would only carry it where the branch
or entry is intentionally tied to one project. That is a different requirement
from tenant scoping and should not be named `workspace_id`.

## Domain Boundaries

### Pi Canonical

Pi stores what the model sees or what Pi's `Session` needs to rebuild context:

- user messages
- assistant messages
- tool result messages
- model changes
- thinking-level changes
- compactions
- branch summaries
- custom/custom_message entries
- labels
- session info

### Pi Projections

These are derived from Pi entries and inserted in the same transaction:

- message blocks
- assistant tool-call index

### GAD Sidecars

GAD stores facts Pi does not contain:

- file observations
- file mutations
- file versions
- worktree states
- worktree state transitions
- manifest trees
- dispatch lifecycle
- approval lifecycle
- credential/runtime interruptions
- branch/snapshot/system audit events
- claims, theories, contradictions

## GAD As A Git Replacement

GAD should still provide the core value we want from git:

- content-addressed file content
- immutable tree snapshots
- named branch refs
- cheap state identity by hash
- diff between two states
- reading any file at any state
- blame from file ranges back to the operation that produced them
- fork/time-travel from historical states
- audit linkage from world changes back to the conversation/tool/runtime event
  that caused them

The revised design keeps those capabilities, but relocates them to the world
state graph instead of the mixed trajectory log.

Conceptual mapping:

| Git Concept | GAD Concept |
| --- | --- |
| blob | `gad_blobs` |
| tree | `gad_manifest_nodes` + `gad_manifest_entries` |
| commit tree/root | `gad_worktree_states.manifest_root_hash` |
| commit id | `gad_worktree_states.state_hash` |
| commit parent edge | `gad_state_transitions.input_state_hash -> output_state_hash` |
| ref/branch | `pi_branches.head_state_hash` plus branch metadata |
| commit metadata | `gad_state_transitions` + `gad_events` |
| diff | manifest comparison between two `state_hash` values |
| blame | `gad_file_change_hunks` and file-version lineage |

The Pi entry DAG and the GAD worktree state graph are connected by state hashes:

- every Pi entry has `pre_state_hash`
- every Pi entry has `post_state_hash`
- every branch caches `head_state_hash`
- every mutating GAD event records the state transition it caused

That gives us the important time-travel query:

> What worktree state did this Pi entry see, and what worktree state existed
> immediately after it?

It also gives us the reverse query:

> Which Pi entry/tool call/runtime event produced this worktree state or file
> hunk?

### Empty Worktree State

The system has one canonical empty worktree state.

```text
EMPTY_MANIFEST_HASH = hash of an empty manifest tree
EMPTY_STATE_HASH = sha256("gad-state-v1", {
  manifestRootHash: EMPTY_MANIFEST_HASH
})
```

Rules:

- A new branch with no Pi entries starts at `EMPTY_STATE_HASH`.
- The first Pi entry on a branch uses `EMPTY_STATE_HASH` as `pre_state_hash`.
- Non-mutating entries inherit their parent's `post_state_hash`.
- Every `post_state_hash` must reference a row in `gad_worktree_states`.
- The empty state must be inserted during schema initialization.

### Required Git-Like Operations

The worktree-state layer must support these APIs:

```ts
getWorktreeState(stateHash): WorktreeState
readFileAtState(stateHash, path): FileSnapshot | null
listFilesAtState(stateHash): FileSnapshot[]
diffStates(leftStateHash, rightStateHash): StateDiff
blameFileSnippet(stateHash, path, startLine, endLine): BlameResult[]
getStateProducer(stateHash): StateProducer | null
forkBranchFromEntry(sourceBranchId, entryId, newBranchId): BranchHead
forkBranchFromState(sourceBranchId, stateHash, newBranchId): BranchHead
```

`forkBranchFromEntry` is conversation-first. It sets both:

- new branch `head_entry_id` to the selected Pi entry
- new branch `head_state_hash` to that entry's `post_state_hash`

`forkBranchFromState` is world-first. It creates a branch with:

- `head_state_hash` set to the selected state
- `head_entry_id` null unless the state can be tied to a Pi entry

World-first branches are useful for file-only workflows and review tools, but
agent conversation branches should normally fork from Pi entries.

## Pi Schema

### Branches

Branches are mutable names for immutable Pi entry heads.

```sql
CREATE TABLE pi_branches (
  branch_id TEXT NOT NULL,
  name TEXT NOT NULL,

  channel_id TEXT,

  head_entry_id TEXT,
  head_entry_hash TEXT,
  head_state_hash TEXT NOT NULL,

  forked_from_branch_id TEXT,
  forked_from_entry_id TEXT,
  forked_from_state_hash TEXT,

  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (branch_id)
);

CREATE INDEX idx_pi_branches_channel
  ON pi_branches(channel_id);
```

Rules:

- `head_entry_id` is either null or references `pi_session_entries.entry_id`.
- `head_entry_hash` is a denormalized cache of the head entry's `entry_hash`.
- If `head_entry_id` is null, `head_state_hash` must be `EMPTY_STATE_HASH` or a
  deliberately selected world-first state.
- If `head_entry_id` is not null, `head_state_hash` must equal the head entry's
  `post_state_hash`.
- Forking inserts a new branch row pointing at an existing entry. It does not
  copy entries.
- `forked_from_branch_id`, `forked_from_entry_id`, and
  `forked_from_state_hash` are historical provenance for branch creation.
- There is no separate `parent_branch_id`; branch ancestry is fork provenance.
- There is no branch-level `dirty` flag. Incomplete work is represented by
  unresolved dispatch/approval/runtime sidecars, not by mutating a branch flag.
- There is no `context_id` unless a concrete caller needs it later and defines
  its semantics.

### Session Entries

This is the canonical Pi session DAG. It intentionally contains message-level
columns directly; a separate `pi_messages` table would duplicate the same entity.

```sql
CREATE TABLE pi_session_entries (
  entry_id TEXT NOT NULL,
  parent_entry_id TEXT,

  entry_type TEXT NOT NULL,
  actor TEXT,

  entry_hash TEXT NOT NULL,
  parent_entry_hash TEXT,

  pre_state_hash TEXT NOT NULL,
  post_state_hash TEXT NOT NULL,

  -- Message fields. Set when entry_type = 'message'.
  role TEXT,
  timestamp_ms INTEGER,

  -- Assistant message fields.
  api TEXT,
  provider TEXT,
  model TEXT,
  response_model TEXT,
  response_id TEXT,
  stop_reason TEXT,
  error_message TEXT,

  usage_input INTEGER,
  usage_output INTEGER,
  usage_cache_read INTEGER,
  usage_cache_write INTEGER,
  usage_total_tokens INTEGER,
  usage_cost_input REAL,
  usage_cost_output REAL,
  usage_cost_cache_read REAL,
  usage_cost_cache_write REAL,
  usage_cost_total REAL,

  -- ToolResult message fields.
  tool_call_id TEXT,
  tool_name TEXT,
  is_error INTEGER,
  tool_result_summary TEXT,
  tool_result_details_hash TEXT,

  -- Non-message session entry fields used often enough to query.
  model_change_provider TEXT,
  model_change_model_id TEXT,
  thinking_level TEXT,
  compaction_first_kept_entry_id TEXT,
  compaction_tokens_before INTEGER,

  raw_entry_json TEXT NOT NULL,
  metadata_json TEXT,
  introduced_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (entry_id),
  UNIQUE (entry_hash)
);

CREATE INDEX idx_pi_entries_parent
  ON pi_session_entries(parent_entry_id);

CREATE INDEX idx_pi_entries_type
  ON pi_session_entries(entry_type);

CREATE INDEX idx_pi_entries_tool_result
  ON pi_session_entries(tool_call_id)
  WHERE role = 'toolResult';

CREATE INDEX idx_pi_entries_model
  ON pi_session_entries(provider, model)
  WHERE role = 'assistant';

CREATE INDEX idx_pi_entries_state
  ON pi_session_entries(post_state_hash);
```

Allowed `entry_type` values:

- `message`
- `model_change`
- `thinking_level_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `session_info`

No `branch_id` is stored here. Entries can be shared across branches.

`raw_entry_json` stores the canonical Pi `SessionTreeEntry` body needed for
lossless round-tripping. It is not required to be byte-for-byte identical to the
incoming JSON. Large inline payloads, especially images, may be represented by
blob references and rehydrated at the Pi boundary.

Entry IDs are sourced from Pi's `SessionTreeEntry`; this layer does not derive
them from content. Including `entryId` in `entry_hash` therefore does not create
a hash circularity.

Storage discipline:

- `raw_entry_json` is the only lossless round-trip copy of the full Pi entry's
  logical content.
- Normalized columns are query/index surfaces.
- Do not duplicate arbitrary nested payloads into additional JSON columns unless
  they are independently queried.
- Tool-result `details` remains in `raw_entry_json`; only `tool_result_summary`
  and `tool_result_details_hash` are extracted for search/integrity.

### Message Blocks

Message content blocks are nested entities and get their own table.

```sql
CREATE TABLE pi_message_blocks (
  block_id TEXT NOT NULL,
  message_entry_id TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  block_type TEXT NOT NULL, -- text | image | thinking | toolCall

  -- text block
  text TEXT,
  text_signature TEXT,

  -- thinking block
  thinking TEXT,
  thinking_signature TEXT,
  thinking_redacted INTEGER,

  -- image block
  image_blob_hash TEXT,
  image_mime_type TEXT,
  image_byte_size INTEGER,

  -- toolCall block
  tool_call_id TEXT,
  tool_name TEXT,
  tool_arguments_json TEXT,
  tool_arguments_hash TEXT,
  thought_signature TEXT,

  PRIMARY KEY (block_id),
  UNIQUE (message_entry_id, block_index)
);

CREATE INDEX idx_pi_blocks_message
  ON pi_message_blocks(message_entry_id, block_index);

CREATE INDEX idx_pi_blocks_tool_call
  ON pi_message_blocks(tool_call_id)
  WHERE tool_call_id IS NOT NULL;

CREATE INDEX idx_pi_blocks_type
  ON pi_message_blocks(block_type);
```

Rules:

- User string content becomes one synthetic text block.
- Assistant `ToolCall` blocks create corresponding `pi_tool_calls` rows.
- Images are stored as blob references in block columns and in canonicalized
  `raw_entry_json`, not inline base64. Pi boundary code rehydrates inline base64
  only when needed for Pi APIs.
- Blocks do not store a second raw JSON copy. Full block fidelity lives in the
  parent entry's `raw_entry_json`; block columns are extracted query surfaces.

### Tool Calls

Tool calls are derived from assistant `toolCall` blocks and are a stable join
target for GAD sidecars.

```sql
CREATE TABLE pi_tool_calls (
  tool_call_id TEXT NOT NULL,

  assistant_entry_id TEXT NOT NULL,
  block_id TEXT NOT NULL,

  tool_name TEXT NOT NULL,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (tool_call_id)
);

CREATE INDEX idx_pi_tool_calls_assistant
  ON pi_tool_calls(assistant_entry_id);

CREATE INDEX idx_pi_tool_calls_name
  ON pi_tool_calls(tool_name, created_at);
```

No `branch_id` is stored here. Branch-scoped tool-call queries intersect tool
calls with the Pi entry chain for that branch.

Tool arguments are not duplicated here. They live on the referenced
`pi_message_blocks` row as `tool_arguments_json` and `tool_arguments_hash`.

## GAD Event Log

GAD sidecars use one append-only event log for replay and audit. Typed sidecar
tables are projections from this log.

```sql
CREATE TABLE gad_events (
  event_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,

  event_hash TEXT NOT NULL,
  prev_event_hash TEXT,

  kind TEXT NOT NULL,

  anchor_kind TEXT,
  anchor_id TEXT,

  payload_ref_json TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (event_seq),
  UNIQUE (event_id),
  UNIQUE (event_hash)
);

CREATE INDEX idx_gad_events_anchor
  ON gad_events(anchor_kind, anchor_id, event_seq);

CREATE INDEX idx_gad_events_kind
  ON gad_events(kind, event_seq);
```

`anchor_kind` values:

- `entry`
- `tool_call`
- `mutation`
- `state`
- `file_version`
- `dispatch`
- `approval`
- `claim`
- `theory`
- `contradiction`
- `branch`
- `system`

Rules:

- Every GAD sidecar write appends one `gad_events` row.
- Typed projection tables are updated in the same transaction.
- GAD events never participate in Pi context materialization.
- Event chains are per database. `event_seq` is monotonically increasing within
  the DO database, and `prev_event_hash` points to the prior event in that same
  database.
- `payload_ref_json` is typed by `kind`. Payload schemas live with the GAD journal
  API definitions, and replay must validate each event against the schema for
  its `kind` before applying projections.

Anchor discipline:

- `gad_events.anchor_kind` and `gad_events.anchor_id` are the canonical anchor.
- Typed projection tables may duplicate common join columns such as
  `tool_call_id`, `mutation_id`, or `result_entry_id` only as denormalized query
  indexes.
- Duplicated projection columns must be derivable from the event anchor or
  event payload. They are not independent authority.
- If a projection row can be anchored to multiple entity types, it should keep
  `anchor_kind` and `anchor_id`. If it is always anchored to one entity type,
  it may keep the direct typed foreign key instead.

Projection event-id discipline:

- Immutable projection rows use `event_id`.
- Mutable projection rows use `created_event_id` and `latest_event_id`.
- Resolved lifecycle rows also use a typed resolution column such as
  `resolved_event_id`.
- Projection event columns point back to `gad_events`; they are not separate
  audit records.

## GAD Worktree And File Schema

### Blobs

```sql
CREATE TABLE gad_blobs (
  hash TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT,
  policy_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hash)
);
```

### Worktree States

```sql
CREATE TABLE gad_worktree_states (
  state_hash TEXT NOT NULL,
  manifest_root_hash TEXT NOT NULL,

  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (state_hash)
);
```

`gad_worktree_states` is the state object table. It is content-addressed by the
manifest root and any future state metadata we decide is part of state identity.
Parentage does not live here; parentage lives in `gad_state_transitions`.
Producer information also lives in `gad_state_transitions`; the state row is the
object identity, not the commit metadata.

### State Transitions

This is the git-commit-edge equivalent. It records that one worktree state led
to another and why.

```sql
CREATE TABLE gad_state_transitions (
  event_id TEXT NOT NULL,

  input_state_hash TEXT NOT NULL,
  output_state_hash TEXT NOT NULL,

  produced_by_tool_call_id TEXT,
  produced_by_mutation_id TEXT,

  summary TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (event_id)
);

CREATE INDEX idx_gad_state_transitions_input
  ON gad_state_transitions(input_state_hash);

CREATE INDEX idx_gad_state_transitions_output
  ON gad_state_transitions(output_state_hash);
```

Rules:

- Every successful worktree mutation creates a state transition.
- Non-mutating events do not create state transitions.
- `pi_session_entries.post_state_hash` should match a known
  `gad_worktree_states.state_hash`.
- For mutating tool results, the world transition is finalized before the Pi
  `toolResult` entry is appended. The resulting Pi entry stores the final
  `post_state_hash` at insert time.
- `pi_branches.head_state_hash` is updated to the output state of the branch
  head entry.
- A transition id is not separate from `event_id`; one successful mutating event
  creates one transition. Multi-mutation tool calls create multiple ordered
  events/transitions.
- Multi-mutation tool calls use the output of the final transition as the
  `toolResult` entry's `post_state_hash`; intermediate states remain reachable
  through `gad_state_transitions` for that `tool_call_id`.
- The transition does not need a direct `produced_by_entry_id`. The Pi entry
  relationship is derivable from `pi_session_entries.post_state_hash` and, for
  tool calls, `gad_dispatches.result_entry_id`.

### Manifest Tree

```sql
CREATE TABLE gad_file_versions (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mode INTEGER NOT NULL DEFAULT 33188,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (path, content_hash, mode)
);

CREATE INDEX idx_gad_file_versions_path
  ON gad_file_versions(path);

CREATE TABLE gad_manifest_nodes (
  hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hash)
);

CREATE TABLE gad_manifest_entries (
  parent_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  entry_kind TEXT NOT NULL,
  child_manifest_hash TEXT,
  file_version_id INTEGER,
  PRIMARY KEY (parent_hash, name)
);

CREATE INDEX idx_gad_manifest_entries_child
  ON gad_manifest_entries(child_manifest_hash);

CREATE INDEX idx_gad_manifest_entries_file
  ON gad_manifest_entries(file_version_id);
```

`gad_file_versions` deduplicates repeated observations of the same file content
at the same path and mode. Inserts should use the unique
`(path, content_hash, mode)` key and reuse the existing row on conflict.

### File Mutations

```sql
CREATE TABLE gad_file_mutations (
  mutation_id TEXT NOT NULL,

  created_event_id TEXT NOT NULL,
  latest_event_id TEXT NOT NULL,
  anchor_kind TEXT NOT NULL,
  anchor_id TEXT NOT NULL,

  tool_call_id TEXT,
  path TEXT NOT NULL,
  operation TEXT NOT NULL, -- write | edit | delete
  status TEXT NOT NULL,    -- planned | ok | error | abandoned

  planned_tool TEXT,
  planned_params_json TEXT,

  before_hash TEXT,
  before_size INTEGER,
  after_hash TEXT,
  after_size INTEGER,

  input_state_hash TEXT,
  output_state_hash TEXT,
  state_transition_event_id TEXT,

  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (mutation_id)
);

CREATE INDEX idx_gad_mutations_anchor
  ON gad_file_mutations(anchor_kind, anchor_id);

CREATE INDEX idx_gad_mutations_tool
  ON gad_file_mutations(tool_call_id);

CREATE INDEX idx_gad_mutations_path
  ON gad_file_mutations(path, created_at);

CREATE INDEX idx_gad_mutations_state
  ON gad_file_mutations(output_state_hash);
```

`gad_file_mutations` is a projection from `gad_events`. If a planned mutation
later becomes `ok` or `error`, append a second GAD event, update
`latest_event_id`, and update the projection row transactionally. Replay
rebuilds the projection.

For successful mutations, `state_transition_event_id` links to the transition
event that created `output_state_hash`.

### File Observations

Reads and inspections are not mutations. They get their own projection because
they are useful for provenance and blame-like reasoning, but they must not imply
a worktree state transition.

```sql
CREATE TABLE gad_file_observations (
  observation_id TEXT NOT NULL,

  event_id TEXT NOT NULL,
  anchor_kind TEXT NOT NULL,
  anchor_id TEXT NOT NULL,

  tool_call_id TEXT,
  path TEXT NOT NULL,
  observed_state_hash TEXT NOT NULL,

  file_version_id INTEGER,
  content_hash TEXT,
  size INTEGER,
  mime_type TEXT,

  range_start_line INTEGER,
  range_end_line INTEGER,
  range_start_byte INTEGER,
  range_end_byte INTEGER,

  summary TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (observation_id)
);

CREATE INDEX idx_gad_observations_anchor
  ON gad_file_observations(anchor_kind, anchor_id);

CREATE INDEX idx_gad_observations_tool
  ON gad_file_observations(tool_call_id);

CREATE INDEX idx_gad_observations_path
  ON gad_file_observations(path, created_at);

CREATE INDEX idx_gad_observations_state
  ON gad_file_observations(observed_state_hash);
```

Rules:

- Observations append `gad_events` rows and update this projection.
- Observations do not create `gad_state_transitions`.
- Observations capture the state that was read through `observed_state_hash`.
- If the read resolves to a known file version, `file_version_id` and
  `content_hash` are set for joins to manifests and blobs.

### File Change Hunks

```sql
CREATE TABLE gad_file_change_hunks (
  id INTEGER PRIMARY KEY,
  mutation_id TEXT NOT NULL,
  path TEXT NOT NULL,

  before_file_version_id INTEGER,
  after_file_version_id INTEGER,

  old_start_line INTEGER,
  old_line_count INTEGER,
  new_start_line INTEGER,
  new_line_count INTEGER,

  old_start_byte INTEGER,
  old_byte_count INTEGER,
  new_start_byte INTEGER,
  new_byte_count INTEGER,

  old_text_hash TEXT,
  new_text_hash TEXT
);

CREATE INDEX idx_gad_hunks_path
  ON gad_file_change_hunks(path, id);

CREATE INDEX idx_gad_hunks_after
  ON gad_file_change_hunks(after_file_version_id);

CREATE INDEX idx_gad_hunks_before
  ON gad_file_change_hunks(before_file_version_id);
```

## GAD Runtime Schema

### Dispatches

Dispatch lifecycle is not Pi history. Pi gets a real `toolResult` only when the
dispatch resolves.

```sql
CREATE TABLE gad_dispatches (
  dispatch_call_id TEXT NOT NULL,

  created_event_id TEXT NOT NULL,
  latest_event_id TEXT NOT NULL,

  tool_call_id TEXT NOT NULL,
  kind TEXT NOT NULL,   -- channel-tool | ask-user | ui-prompt
  status TEXT NOT NULL, -- pending | resolved | abandoned | error

  provider_participant_id TEXT,
  provider_handle TEXT,
  method_name TEXT,

  params_json TEXT,

  result_entry_id TEXT,
  resolved_event_id TEXT,
  abandoned_reason TEXT,
  error_message TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,

  PRIMARY KEY (dispatch_call_id)
);

CREATE INDEX idx_gad_dispatches_tool
  ON gad_dispatches(tool_call_id);

CREATE INDEX idx_gad_dispatches_status
  ON gad_dispatches(status, created_at);
```

Rules:

- No placeholder `toolResult` is ever written to Pi.
- The harness/agent loop must be able to pause on a dispatched call.
- When the dispatch resolves, append exactly one real Pi `toolResult` entry and
  set `result_entry_id`, `resolved_event_id`, and `latest_event_id`.
- Dispatch result payloads are not buffered in `gad_dispatches`; the actual
  result lives in the Pi `toolResult` entry and in the resolved event payload.
- Approvals are represented by `gad_approvals`, not by
  `gad_dispatches.kind = 'approval'`.

### Approvals

```sql
CREATE TABLE gad_approvals (
  approval_id TEXT NOT NULL,

  requested_event_id TEXT NOT NULL,
  latest_event_id TEXT NOT NULL,

  tool_call_id TEXT NOT NULL,
  requested_by_entry_id TEXT NOT NULL,

  approval_level INTEGER,
  request_ref_json TEXT,

  decision TEXT, -- approved | denied | dismissed | expired
  resolved_event_id TEXT,
  resolved_by TEXT,
  resolved_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (approval_id)
);

CREATE INDEX idx_gad_approvals_tool
  ON gad_approvals(tool_call_id);
```

Rules:

- Approval requests and decisions are GAD events.
- `requested_event_id` points at the request event.
- `latest_event_id` points at the current projection state.
- `resolved_event_id` is set only after a decision.
- `requested_by_entry_id` is denormalized from
  `pi_tool_calls.assistant_entry_id` for direct approval queries.
- Approval decisions do not create Pi entries by themselves; any model-visible
  consequence is represented by later Pi entries.

### Credential Interruptions

```sql
CREATE TABLE gad_credential_interruptions (
  interruption_id TEXT NOT NULL,

  created_event_id TEXT NOT NULL,
  latest_event_id TEXT NOT NULL,
  anchor_kind TEXT,
  anchor_id TEXT,

  provider_id TEXT NOT NULL,
  model_base_url TEXT,
  resume_entry_id TEXT,
  resolved_event_id TEXT,
  status TEXT NOT NULL, -- pending | resumed | abandoned

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,

  PRIMARY KEY (interruption_id)
);
```

### Branch And System Events

```sql
CREATE TABLE gad_branch_events (
  branch_event_id TEXT NOT NULL,

  event_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- created | forked | renamed | snapshot_marked

  source_branch_id TEXT,
  source_entry_id TEXT,
  source_state_hash TEXT,

  payload_ref_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (branch_event_id)
);

CREATE TABLE gad_system_events (
  system_event_id TEXT NOT NULL,

  event_id TEXT NOT NULL,
  anchor_kind TEXT,
  anchor_id TEXT,

  kind TEXT NOT NULL,
  payload_ref_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (system_event_id)
);
```

## GAD Semantic Schema

Semantic tables are GAD sidecars anchored to Pi/world/runtime entities.

```sql
CREATE TABLE gad_claims (
  id INTEGER PRIMARY KEY,
  claim_hash TEXT NOT NULL,

  created_event_id TEXT NOT NULL,
  latest_event_id TEXT NOT NULL,
  anchor_kind TEXT,
  anchor_id TEXT,

  text TEXT NOT NULL,
  normalized_text TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  confidence REAL,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (claim_hash)
);

CREATE TABLE gad_claim_edges (
  id INTEGER PRIMARY KEY,

  event_id TEXT NOT NULL,
  source_claim_id INTEGER NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE gad_theories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  current_version_id INTEGER,
  UNIQUE (name)
);

CREATE TABLE gad_theory_versions (
  id INTEGER PRIMARY KEY,
  theory_id INTEGER NOT NULL,

  event_id TEXT NOT NULL,
  anchor_kind TEXT,
  anchor_id TEXT,

  parent_version_id INTEGER,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE gad_contradictions (
  id INTEGER PRIMARY KEY,

  created_event_id TEXT NOT NULL,
  latest_event_id TEXT NOT NULL,
  anchor_kind TEXT,
  anchor_id TEXT,

  left_claim_id INTEGER,
  right_claim_id INTEGER,
  resolved_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  notes TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
```

## Hashing

### Canonical JSON

All hashes use stable canonical JSON:

- object keys sorted lexicographically
- `undefined` omitted
- UTF-8 encoding
- no whitespace significance

### Pi Entry Hash

Pi entries form a Merkle chain:

```ts
entry_hash = sha256("pi-entry-v1", {
  entryId,
  parentEntryHash,
  entryType,
  preStateHash,
  postStateHash,
  rawEntryJsonCanonical
});
```

`parent_entry_hash` is included in the hash input. Two branches diverge when
their head hashes differ and their parent-chain hashes first differ.

### GAD Event Hash

GAD sidecar events also form a Merkle chain:

```ts
event_hash = sha256("gad-event-v1", {
  prevEventHash,
  eventId,
  kind,
  anchorKind,
  anchorId,
  payloadCanonical,
  metadataCanonical
});
```

The GAD event chain provides replayability for sidecar domains without making
sidecars part of Pi context.

## Append Semantics

### Append A Pi Entry

`PiSessionStore.appendEntry(entry)`:

1. Reads the current branch head and parent state.
2. Computes `pre_state_hash`.
3. Computes `post_state_hash`.
   - non-mutating entries inherit parent `post_state_hash`
   - entries associated with completed file mutations use the mutation output
     state
4. Computes `entry_hash`.
5. Inserts `pi_session_entries`.
6. Inserts `pi_message_blocks` for message entries.
7. Inserts `pi_tool_calls` for assistant tool-call blocks.
8. Updates `pi_branches.head_entry_id`, `head_entry_hash`, and
   `head_state_hash`.

This happens in one transaction. There is no code path that can insert a message
without inserting its blocks and tool-call projections.

### Move A Branch Head

Pi's `SessionStorage.setLeafId` maps to moving the current branch head.

The `PiSessionStore` instance must be scoped to a branch, or the method must
receive an explicit `branch_id`; the storage layer should not infer this from
global process state.

`setLeafId(entryId)`:

1. Loads the target `pi_session_entries` row.
2. Verifies that the target entry is reachable from the branch's current head
   or is an allowed fork target for an explicit branch switch.
3. Updates `pi_branches.head_entry_id` to `entryId`.
4. Updates `pi_branches.head_entry_hash` from the target entry's `entry_hash`.
5. Updates `pi_branches.head_state_hash` from the target entry's
   `post_state_hash`.

The update must keep all three cached head fields consistent. Moving a branch
head does not mutate Pi entries.

### Record A GAD Sidecar Event

`GadSidecarJournal.appendEvent(event)`:

1. Reads previous GAD event hash.
2. Computes event hash.
3. Inserts `gad_events`.
4. Updates the relevant typed projection table.
5. Updates worktree state tables when applicable.

Typed projection rows are rebuildable from `gad_events`.

### Record A Worktree Mutation

Successful file/worktree mutations must update the worktree state graph:

1. Append a `gad_events` row for the observed mutation.
2. Store new blob metadata in `gad_blobs`.
3. Create a `gad_file_versions` row when file content changes.
4. Build or reuse manifest nodes and entries.
5. Create a `gad_worktree_states` row for the new manifest root.
6. Create a `gad_state_transitions` row from input state to output state.
   The transition row uses the same `event_id` as the mutation observation
   event from step 1.
7. Insert or update the `gad_file_mutations` projection row:
   - if a planned row exists, update `latest_event_id`, `status`,
     `output_state_hash`, and `state_transition_event_id`
   - if no planned row exists, insert a direct `status = 'ok'` row with
     `created_event_id = latest_event_id = state_transition_event_id`
8. Insert `gad_file_change_hunks` when hunk data can be computed.
9. Return the output state to the caller.

This is the GAD equivalent of creating a commit. The state hash is the durable
identity of the resulting worktree; the transition records why it exists.

This flow never updates a Pi entry after append. If the mutation belongs to a
tool call, the runtime completes the mutation flow first, then appends the Pi
`toolResult` entry with `post_state_hash` set to the final output state.

### Dispatch Resolution

Dispatch flow:

1. Assistant emits tool call. This creates a `pi_tool_calls` row.
2. Runtime creates a `gad_dispatches(status='pending')` event/row.
3. Agent loop pauses on the dispatched call.
4. Runtime receives result.
5. If the result mutates worktree state, runtime records all GAD mutation
   events/transitions first.
6. Runtime appends one real Pi `toolResult` entry using the final state hash.
7. Runtime appends a `dispatch_resolved` GAD event and updates
   `gad_dispatches.result_entry_id`, `resolved_event_id`, and
   `latest_event_id`.
8. Harness continues from the real tool result.

No placeholder is stored in Pi.

## Read Semantics

### Pi Context

Pi context is built only from the Pi entry DAG.

Compaction changes the visible context. A raw parent-chain walk is still useful
for audit/debugging, but model context must treat the newest compaction entry on
the branch as a boundary:

- include the compaction summary entry
- include retained entries from `compaction_first_kept_entry_id` through the
  compaction entry's former head, when `compaction_first_kept_entry_id` is set
- include entries appended after the compaction
- exclude ancestors older than `compaction_first_kept_entry_id`
- if `compaction_first_kept_entry_id` is null, the compaction summary replaces
  the entire prior prefix

That means context materialization is a two-step operation:

1. Walk the full parent chain from branch head and preserve chain depth.
2. Find the newest compaction entry in that chain and apply the boundary before
   emitting entries root-to-head.

Sketch:

```sql
WITH RECURSIVE chain(entry_id, depth) AS (
  SELECT b.head_entry_id, 0
  FROM pi_branches b
  WHERE b.branch_id = ?
    AND b.head_entry_id IS NOT NULL

  UNION ALL

  SELECT e.parent_entry_id, chain.depth + 1
  FROM pi_session_entries e
  JOIN chain
    ON e.entry_id = chain.entry_id
  WHERE e.parent_entry_id IS NOT NULL
),
newest_compaction AS (
  SELECT c.entry_id, c.depth, e.compaction_first_kept_entry_id
  FROM chain c
  JOIN pi_session_entries e
    ON e.entry_id = c.entry_id
  WHERE e.entry_type = 'compaction'
  ORDER BY c.depth ASC
  LIMIT 1
),
kept_boundary AS (
  SELECT c.depth
  FROM chain c
  JOIN newest_compaction nc
    ON nc.compaction_first_kept_entry_id = c.entry_id
)
SELECT e.*
FROM chain
JOIN pi_session_entries e
  ON e.entry_id = chain.entry_id
LEFT JOIN newest_compaction nc ON 1=1
LEFT JOIN kept_boundary kb ON 1=1
WHERE nc.entry_id IS NULL
   OR chain.depth < nc.depth
   OR chain.entry_id = nc.entry_id
   OR (
        nc.compaction_first_kept_entry_id IS NOT NULL
        AND chain.depth > nc.depth
        AND chain.depth <= kb.depth
      )
ORDER BY
  CASE
    WHEN nc.entry_id IS NULL THEN 0
    WHEN chain.entry_id = nc.entry_id THEN 0
    WHEN chain.depth > nc.depth THEN 1
    ELSE 2
  END,
  chain.depth DESC;
```

The parent chain defines order. Do not order Pi context by timestamp. The
implementation may use application code instead of this exact SQL, but it must
honor the compaction boundary.

### Branch-Scoped Tool Calls

```sql
WITH RECURSIVE chain(entry_id, depth) AS (
  SELECT b.head_entry_id, 0
  FROM pi_branches b
  WHERE b.branch_id = ?
    AND b.head_entry_id IS NOT NULL

  UNION ALL

  SELECT e.parent_entry_id, chain.depth + 1
  FROM pi_session_entries e
  JOIN chain
    ON e.entry_id = chain.entry_id
  WHERE e.parent_entry_id IS NOT NULL
)
SELECT tc.*
FROM pi_tool_calls tc
JOIN chain
  ON chain.entry_id = tc.assistant_entry_id
JOIN pi_message_blocks b
  ON b.block_id = tc.block_id
ORDER BY chain.depth DESC, b.block_index;
```

### State At Entry

```sql
SELECT pre_state_hash, post_state_hash
FROM pi_session_entries
WHERE entry_id = ?;
```

This is the key time-travel primitive.

### State Producer

```sql
SELECT st.*, e.kind, e.anchor_kind, e.anchor_id, e.payload_ref_json
FROM gad_state_transitions st
JOIN gad_events e
  ON e.event_id = st.event_id
WHERE st.output_state_hash = ?
ORDER BY e.event_seq DESC;
```

### Diff States

Diffing two states compares manifest trees, not Pi entries.

Algorithm:

1. Load each state's `manifest_root_hash`.
2. Recursively walk `gad_manifest_entries`.
3. Compare path to file version/content hash.
4. Return added, removed, and changed paths.

### Read File At State

```sql
SELECT fv.*
FROM gad_worktree_states ws
JOIN gad_manifest_entries me
  ON me.parent_hash = ws.manifest_root_hash
JOIN gad_file_versions fv
  ON fv.id = me.file_version_id
WHERE ws.state_hash = ?
  -- plus recursive manifest path walk for the requested path
```

The actual implementation should use a path-walking helper over manifest nodes,
not a flat join.

### Artifact Provenance For Tool Call

```sql
SELECT m.*, h.*
FROM gad_file_mutations m
JOIN gad_events e
  ON e.event_id = m.created_event_id
LEFT JOIN gad_file_change_hunks h
  ON h.mutation_id = m.mutation_id
WHERE m.tool_call_id = ?
ORDER BY e.event_seq, h.id;
```

### File Blame

Blame starts from the file version at a state, then walks hunk lineage backward:

```sql
WITH RECURSIVE file_lineage AS (
  SELECT h.*, 0 AS depth
  FROM gad_file_change_hunks h
  WHERE h.path = ?
    AND h.after_file_version_id = ?

  UNION ALL

  SELECT parent.*, file_lineage.depth + 1
  FROM gad_file_change_hunks parent
  JOIN file_lineage
    ON parent.path = file_lineage.path
   AND parent.after_file_version_id = file_lineage.before_file_version_id
)
SELECT fl.*, m.tool_call_id, m.anchor_kind, m.anchor_id, st.input_state_hash,
       st.output_state_hash
FROM file_lineage fl
JOIN gad_file_mutations m
  ON m.mutation_id = fl.mutation_id
LEFT JOIN gad_state_transitions st
  ON st.event_id = m.state_transition_event_id
ORDER BY fl.depth;
```

### Pi Find Entries

`PiSessionStore.findEntries` must not become an accidental full-database scan. It
supports these indexed access patterns:

- by `entry_id`
- by `entry_hash`
- by `entry_type`
- by message `role`
- by tool result `tool_call_id`
- by `post_state_hash`
- by branch-visible context chain
- by raw branch parent chain for audit/debugging

Branch-scoped `findEntries` first computes the branch chain, then intersects it
with the requested predicate. By default it uses compaction-aware visible
context semantics. Callers that need old hidden entries must request the raw
parent chain explicitly.

Cross-branch queries return entry DAG identities. They do not imply branch
ownership.

## Retention And Garbage Collection

V1 should prefer retention over deletion. The system is explicitly designed for
time travel, audit, replay, and branch recovery, so garbage collection must be a
separate operation with clear roots.

Reachability roots:

- all live `pi_branches.head_entry_id`
- all live `pi_branches.head_state_hash`
- branch fork source entries and states
- explicit snapshots/bookmarks
- unresolved dispatches, approvals, and credential interruptions
- `gad_events` rows inside the retained audit horizon

Derived retention:

- Pi entries reachable from retained branch heads through parent links
- GAD states reachable from retained branch heads and retained transitions
- blobs and file versions reachable from retained manifest roots
- typed projection rows whose `event_id` is retained

Policy for v1:

- Do not hard-delete Pi entries or GAD events automatically.
- Allow compaction to remove entries from model context, not from audit storage.
- Allow blob pruning only for blobs unreachable from any retained state.
- Keep typed projections rebuildable from retained `gad_events`.
- If storage pressure requires event truncation later, first create a signed
  checkpoint event containing projection/state hashes and document that replay
  before the checkpoint is intentionally unavailable.

This keeps correctness simple while still giving a future implementation a
clean GC boundary.

## Mapping From Current Mixed Entries

| Current Type | New Home |
| --- | --- |
| `message` | `pi_session_entries`, `pi_message_blocks`, `pi_tool_calls` |
| `model_change` | `pi_session_entries` columns + raw JSON |
| `thinking_level_change` | `pi_session_entries` columns + raw JSON |
| `compaction` | `pi_session_entries` columns + raw JSON |
| `branch_summary` | `pi_session_entries` raw JSON |
| `custom` | `pi_session_entries` raw JSON |
| `custom_message` | `pi_session_entries` raw JSON |
| `label` | `pi_session_entries` raw JSON |
| `session_info` | `pi_session_entries` raw JSON |
| `leaf` | `pi_branches.head_entry_id` |
| `message_block` | `pi_message_blocks` |
| `tool_call_requested` | `pi_tool_calls` |
| `tool_result_observed` | `pi_session_entries` where role = `toolResult` |
| `file_observed` | `gad_events`, `gad_file_observations` |
| `file_read` | `gad_events`, `gad_file_observations` |
| `file_mutation_intent` | `gad_events`, `gad_file_mutations(status='planned')` |
| `file_mutation_observed` | `gad_events`, `gad_file_mutations`, state/file projections |
| `workspace_observed` | `gad_events`, `gad_worktree_states`, manifest tables |
| `approval_requested` | `gad_events`, `gad_approvals` |
| `approval_resolved` | `gad_events`, `gad_approvals` |
| `dispatch_abandoned` | `gad_events`, `gad_dispatches` |
| `branch_created` | `gad_events`, `gad_branch_events` |
| `snapshot_marked` | `gad_events`, `gad_branch_events` |
| `claim_asserted` | `gad_events`, `gad_claims`, `gad_claim_edges` |
| `claim_revised` | `gad_events`, `gad_claims`, `gad_claim_edges` |
| `contradiction_detected` | `gad_events`, `gad_contradictions` |
| `theory_updated` | `gad_events`, `gad_theories`, `gad_theory_versions` |
| `system_event` | `gad_events`, `gad_system_events` |

## Implementation Plan

### 1. Replace Schema

Create the new `pi_*` and `gad_*` tables. For local/dev clean break, drop the
old mixed trajectory schema.

### 2. Build Pi Store

Implement `PiSessionStore implements SessionStorage`:

- `appendEntry`
- `getEntry`
- `findEntries`
- `getPathToRoot`
- `getEntries`
- `getLeafId`
- `setLeafId`

It writes `pi_session_entries`, `pi_message_blocks`, and `pi_tool_calls`
atomically.

### 3. Build GAD Sidecar Journal

Implement typed sidecar methods:

- `recordFileObservation`
- `recordFileMutationPlanned`
- `recordFileMutationObserved`
- `recordDispatchPending`
- `recordDispatchResolved`
- `recordDispatchAbandoned`
- `recordApprovalRequested`
- `recordApprovalResolved`
- `recordCredentialInterruption`
- `recordSystemEvent`
- `recordClaim`
- `recordTheoryUpdate`
- `recordContradiction`

Each method appends a `gad_events` row and updates typed projection tables.

### 4. Fix Harness Dispatch Semantics

Patch or wrap the agent loop so dispatched calls pause instead of requiring a
fake `toolResult` placeholder.

Result:

- no Pi placeholder messages
- one real `toolResult` per resolved tool call
- continuation starts after the real result is appended

### 5. Update Branch/Fork Logic

Forking creates a new `pi_branches` row pointing at an existing `entry_id`.

No entries are copied.

### 6. Update Query APIs

Replace mixed trajectory APIs with explicit APIs:

- `pi.getBranchHead`
- `pi.getSessionPath`
- `pi.findEntries`
- `pi.getStateAtEntry`
- `pi.listToolCalls`
- `gad.getWorktreeState`
- `gad.readFileAtState`
- `gad.listFilesAtState`
- `gad.diffStates`
- `gad.getStateProducer`
- `gad.listEvents`
- `gad.getFileMutations`
- `gad.getDispatch`
- `gad.getToolProvenance`
- `gad.blameFileSnippet`

### 7. Rebuild Tests

Required tests:

- append user message creates one entry and one text block
- append assistant tool call creates entry, block, and tool-call row
- append tool result creates one entry with role `toolResult`
- branch fork shares ancestor entries
- context order follows parent chain, not timestamp
- state at entry is queryable
- file mutation changes state and hunks
- file observation records the observed state without creating a transition
- diff between two worktree states reports added/removed/changed paths
- read file at historical state returns the right file version
- blame walks file hunk lineage back to the producing mutation/tool call
- fork from Pi entry carries that entry's `post_state_hash`
- fork from raw worktree state creates a world-first branch with no Pi head
- dispatch pauses without Pi placeholder
- dispatch resolution appends exactly one tool result
- mutating dispatch records world transitions before appending the tool result
- multi-mutation dispatch binds the tool result to the final output state
- approvals are stored in `gad_approvals`, not `gad_dispatches`
- compaction-aware context excludes replaced ancestors
- raw parent-chain reads can still see entries hidden from model context
- `findEntries` uses indexed predicates and branch-chain intersections
- GAD events replay typed sidecar tables
- image blocks store blob refs and rehydrate at Pi boundary
- hash chain detects divergence

## Acceptance Criteria

- Pi context materialization reads only `pi_*` tables.
- GAD sidecars never enter Pi context.
- Branches are heads into an immutable entry DAG.
- Every Pi entry has explicit state binding.
- GAD has content-addressed blobs, manifests, worktree states, and explicit
  state transitions sufficient for git-like diff/read/blame/fork operations.
- Tool calls are stable join targets.
- Tool results are Pi messages, not separate duplicated entities.
- Dispatch lifecycle is entirely outside Pi until the real result exists.
- GAD sidecars are replayable from `gad_events`.
- Anchors use the same `anchor_kind`/`anchor_id` convention.
- Hash chain semantics are specified and tested.

## Summary

The target model is:

```text
Pi entry DAG:
  exact conversation state plus normalized blocks/tool calls

World state:
  blobs, file versions, manifests, worktree states, state transitions,
  file mutations, diffs, blame

GAD event log:
  append-only replay/audit spine for non-Pi sidecars

Typed GAD projections:
  fast queries over file, runtime, and semantic facts
```

This is smaller and stricter than the previous plan. It normalizes the entities
we actually need, removes redundant Pi subtype tables, binds worktree state to
entries, eliminates dispatch placeholders, and preserves sidecar replayability
without keeping a mixed Pi/GAD trajectory table.

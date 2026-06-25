# GAD Diagnostics And Runtime State

Use this guide when an agent, channel, turn, invocation, eval, or worktree state
looks inconsistent. Prefer bounded inspector APIs first. Hydrated history APIs
are for targeted follow-up after you know the exact event, envelope, digest, or
state hash you need.

Do not query raw branch tables such as `trajectory_branches`; that table is not
part of the current public GAD schema. If an inspector points you to a specific
artifact and SQL is still necessary, first discover the current schema with a
bounded read and then query only the exact rows you need.

## Current Diagnostic APIs

### Publication Integrity

Use `gad.inspectPublicationIntegrity({ channelId, branchId })` to validate the
trajectory-to-channel publication invariant.

It distinguishes:

- `expectedMappings`: publications declared by `external.envelope_published`
- `missingMappings`: declared publications without persisted publication joins
- `orphanMappings`: join rows whose event or envelope no longer exists
- `sequenceMismatches`: join rows whose `channel_seq` disagrees with the envelope
- `channelOriginAgenticEnvelopes`: agentic channel envelopes that were not
  trajectory-published; these are usually expected and are not automatically bugs

Do not count every unjoined channel log row as an error. Only
trajectory-published envelopes referenced by `external.envelope_published` must
have join rows.

### Turn State

Use `gad.inspectTurnState({ branchId, channelId })` for stuck typing, open turn,
or streaming assistant-message investigations.

It reports:

- open projected turns
- streaming/non-completed projected messages
- nonterminal projected invocations
- duplicate `turn.opened` invariant failures

Duplicate `turn.opened` is not a recoverable compatibility case. New appends are
rejected, and projection should fail loudly if a corrupt duplicate reaches the
log.

### Invocation State

Use `gad.inspectInvocationState({ invocationId, transportCallId, branchId })`
when method suspension state, trajectory invocation projection, and channel
terminal events appear to disagree.

It reports the projected invocation row plus counts of started and terminal
trajectory events. This tells you whether you are looking at:

- a transport/suspension issue
- a projection issue
- a real nonterminal invocation
- a terminal event that never reached the projection

Agent DO method suspensions are stored in the agent worker, not GAD. Standard
agent workers expose `inspectMethodSuspensions` as a participant method; it
returns local suspension rows joined with `gad.inspectInvocationState(...)` for
the matching branch, invocation id, and transport call id.

```ts
const joined = await chat.callMethod(agentParticipantId, "inspectMethodSuspensions", {});
```

### Channel Envelope Inspection

Use `gad.inspectChannelEnvelopes({ channelId, cursor, limit, payloadKind })` for
normal log inspection. It returns:

- compact payload summaries
- per-column byte counts
- stored blob-ref digests and sizes
- sender metadata summaries

Use `gad.listChannelEnvelopes(...)` only after you know you need hydrated
semantic envelopes. Broad hydrated reads can pull large blob refs back into eval
returns and obscure the useful diagnostic data.

### Storage Diagnostics

Use `gad.inspectStorageDiagnostics({ rowByteLimit, limit })` to find oversized
inline rows or missing blob metadata.

Large payload fields should be encoded as stored refs. If a huge eval/tool result
appears inline in `log_events` or `trajectory_invocations`, treat that as a
storage-boundary bug.

### Channel Roster

Use `gad.inspectChannelRoster({ channelId })` to inspect projected join/update
leave state from presence envelopes without raw SQL. It returns active and
inactive counts plus bounded roster rows.

### Agent Health

Use `gad.inspectAgentHealth({ channelId, branchId })` as the first-pass incident
summary for a channel. It combines:

- publication integrity
- turn state
- invocation state
- roster
- recent channel envelopes
- storage diagnostics

The `summary.ok` flag is false when durable publication, turn, invocation, or
storage invariants need attention.

### Build Provenance

Use the build service to check what source artifact the runtime can actually
see. From `eval`, `rpc` is injected — call it directly (no import):

```ts
const provenance = await rpc.call("main", "build.inspectBuildProvenance", [
  "@workspace-skills/system-testing",
]);
```

The response includes the resolved unit, effective version, sourcemap and
production build keys, and cached artifact metadata.

### Eval And Method Result Caps

Durable method terminal events cap oversized results before publication. Large
`payload.result` / `payload.error` values are replaced with an omitted-result
summary and a blobstore pointer to the full JSON. The channel stored-value
encoder may still store that summary by reference because `payload.result` is a
forced stored path; hydrate targeted envelopes when you need the bounded
summary.

## Current Invariants

- `log_events` is the private, branchable agentic trajectory and channel log
  storage.
- Publication inspectors join only trajectory-published channel envelopes to
  their private source events.
- `payload_ref_json` is the storage column name even when JSON is inline; there
  is no `payload_json` column.
- Presence envelopes project into `channel_roster`.
- Read-only CTEs are allowed through `gad.query`; write CTEs are rejected.
- Manifest/state hashes are synchronous SHA-256 over stable JSON. They are
  content-addressed identifiers, not compatibility placeholders.

## Contexts And Worktrees

Agent contexts behave like isolated workspace checkouts. Each context can have a
different HEAD, index, branch, and pushed state.

When a source edit appears ignored:

1. Inspect the context's git status and branch.
2. Confirm the workspace repo was published from that context.
3. Confirm the runtime build/reload consumed the published artifact.
4. Only then assume the running code path is still broken.

The build system builds workspace units from git, not from uncommitted working
tree files.

## System Testing Self-Diagnostics

`@workspace-skills/system-testing` automatically attaches
`execution.diagnostics` when a test errors. The packet includes build
provenance and, when a headless channel exists, `gad.inspectAgentHealth(...)`.
For failures that happen outside an individual test, call
`runner.collectDiagnostics({ channelId, error })` directly.

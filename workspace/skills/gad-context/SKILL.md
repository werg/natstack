---
name: gad-context
description: Query NatStack's canonical trajectory model for conversation context, runtime events, channel envelopes, worktree states, file provenance, and semantic facts.
---

# GAD Context

Use the `gad` runtime namespace. The storage model is canonical trajectory-first:

- Agent context lives in `log_events` plus projections such as `trajectory_messages`, `trajectory_message_blocks`, `trajectory_invocations`, and `trajectory_approvals`.
- Channel delivery also lives in `log_events`; use the channel inspector APIs to
  read it.
- Published trajectory events are validated through dedicated inspector APIs.
  Do not infer trajectory-to-channel publication health by matching payload text
  or timestamps.
- Worktree state lives in `gad_worktree_states`, manifest tables, file versions, state transitions, mutations, observations, and hunks.

Use only the canonical tables above; older event/session table families do not exist in this schema.

For live incident work, read [DIAGNOSTICS.md](DIAGNOSTICS.md) first. It explains
the summary-first inspector APIs, current invariants, and context/worktree model.

Useful APIs:

- `gad.getTrajectoryBranchHead({ trajectoryId, branchId })`
- `gad.listTrajectoryEvents({ trajectoryId, branchId, cursor, limit })`
- `gad.appendTrajectoryBatch({ trajectoryId, branchId, owner, events })`
- `gad.inspectChannelEnvelopes({ channelId, cursor, limit, payloadKind })` for normal debugging; it returns compact payload summaries, byte counts, and stored-ref digests.
- `gad.listChannelEnvelopes({ channelId, cursor, limit, payloadKind })` only when code needs hydrated semantic envelopes. Do not use it for broad exploratory dumps inside an agent turn.
- `gad.inspectPublicationIntegrity({ channelId, branchId })` to distinguish real missing trajectory publication joins from expected channel-origin envelopes.
- `gad.inspectTurnState({ branchId, channelId })` to summarize open turns, streaming messages, pending invocations, and duplicate turn-open invariant failures.
- `gad.inspectInvocationState({ branchId, invocationId, transportCallId })` to join projected invocation status with started/terminal trajectory events.
- `gad.inspectChannelRoster({ channelId })` to read projected presence/roster state without raw SQL.
- `gad.inspectAgentHealth({ channelId, branchId })` for a one-call bounded channel health report.
- `gad.getChannelReplayWindow({ channelId, mode, sinceSeq, beforeSeq, limit })`
- `gad.getTrajectoryForEnvelope({ envelopeId })`
- `gad.listPublishedEnvelopesForTrajectory({ trajectoryId, branchId, eventId, turnId, channelId, limit })`
- `gad.listGadBranchFiles({ branchId })`
- `gad.diffGadStates({ leftStateHash, rightStateHash })`
- `gad.readGadFileAtState({ stateHash, path })`
- `gad.getGadStateProducer({ stateHash })`
- `gad.blameGadFileSnippet({ stateHash, path })`
- `gad.inspectStorageDiagnostics({ rowByteLimit, limit })`

Current implemented hardening:

- Duplicate `turn.opened` events are rejected at append time and should fail
  projection loudly if corrupt data reaches the log.
- `trajectory_turns.opened_at` is no longer silently overwritten by duplicate
  opens.
- Presence envelopes project into `channel_roster`.
- `gad.query` accepts read-only CTEs and still rejects write CTEs, but it is a
  schema-level escape hatch after bounded inspectors have found the exact table
  or artifact you need.
- Manifest/state hashes are synchronous SHA-256 over stable JSON.
- Standard agent workers expose `inspectMethodSuspensions` to join local
  suspension rows with GAD invocation state.
- Oversized method/eval results are capped before durable terminal invocation
  publication and replaced with an omitted-result summary plus blobstore pointer.
- Inspector APIs return summaries and byte counts so agents do not need to dump
  hydrated history into eval results.

For first-pass diagnostics from eval, prefer inspectors and let
`inspectAgentHealth` derive the default channel branch:

```ts
const channelId = chat.channelId;
const health = await gad.inspectAgentHealth({ channelId, limit: 50 });
const publication = await gad.inspectPublicationIntegrity({ channelId });
const turn = await gad.inspectTurnState({ channelId });
const invocation = await gad.inspectInvocationState({ branchId: health.branchId });
const storage = await gad.inspectStorageDiagnostics({ channelId, limit: 25 });
```

Do not query `trajectory_branches`; it is not a public table in the current GAD
schema. If you need SQL after an inspector points to a concrete artifact, first
confirm the table exists with a bounded schema read and keep the result small.

```sql
SELECT seq, envelope_id, payload_kind, head, appended_at
FROM log_events
ORDER BY seq DESC
LIMIT 100;
```

To connect what an agent privately did to what users or other agents actually
received, use `gad.inspectPublicationIntegrity(...)` and targeted envelope or
lineage APIs after that summary identifies a concrete envelope or event.

Keep the distinction clear:

- `log_events` is the private, branchable agentic trajectory and channel log
  storage.
- Publication inspectors make trajectory/channel relationships queryable without
  asking agents to stitch rows together from raw tables.

Large values are stored by reference. Do not run broad hydrated reads and return
them from `eval`; use `inspect*` APIs first, then fetch one digest or envelope
only when the exact artifact is needed. `payload_ref_json` is the durable column
name even when the value is inline JSON; there is no `payload_json` column.

Contexts behave like isolated workspace state views. A source edit affects the
running app only after the relevant context commits and the runtime build
reloads that artifact. When a fix appears ignored, inspect VCS status, build
events, and runtime build provenance before assuming the code path is still
broken.

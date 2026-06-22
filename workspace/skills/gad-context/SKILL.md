---
name: gad-context
description: Query NatStack's canonical trajectory model for conversation context, runtime events, channel envelopes, worktree states, file provenance, and semantic facts.
---

# GAD Context

Use the `gad` runtime namespace. The storage model is canonical log-first:

- Agent, channel, and VCS history lives in `log_events` plus `log_heads`; `log_kind`
  on the head distinguishes `trajectory`, `channel`, and `vcs` logs.
- Agent context projections live in `trajectory_messages`,
  `trajectory_message_blocks`, `trajectory_invocations`, `trajectory_approvals`,
  `trajectory_turns`, and usage/checkpoint tables.
- Channel delivery is represented by channel log rows in `log_events`. Published
  trajectory events are joined to transmitted channel messages through the
  channel row's `origin_log_id`, `origin_head`, and `origin_envelope_id` columns;
  do not infer this relationship by matching payload text or timestamps.
- Worktree state lives in `gad_worktree_states`, manifest tables, file versions,
  `gad_state_transitions`, `gad_transition_parents`, and `gad_worktree_edit_ops`.

Use only the canonical tables above. Older event/session families such as
`trajectory_events`, `trajectory_branches`, `channel_envelopes`,
`trajectory_channel_publications`, `gad_file_mutations`,
`gad_file_observations`, and `gad_file_change_hunks` are not part of this schema.

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
- `gad.inspectStorageDiagnostics({ rowByteLimit, limit })`

Current implemented hardening:

- Duplicate `turn.opened` events are rejected at append time and should fail
  projection loudly if corrupt data reaches the log.
- `trajectory_turns.opened_at` is no longer silently overwritten by duplicate
  opens.
- Presence envelopes project into `channel_roster`.
- `gad.query` accepts read-only CTEs and still rejects write CTEs.
- Manifest/state hashes are synchronous SHA-256 over stable JSON.
- Standard agent workers expose `inspectMethodSuspensions` to join local
  suspension rows with GAD invocation state.
- Oversized method/eval results are capped before durable terminal invocation
  publication and replaced with an omitted-result summary plus blobstore pointer.
- Inspector APIs return summaries and byte counts so agents do not need to dump
  hydrated history into eval results.

For SQL reads, prefer:

```sql
SELECT h.log_id, h.head, h.log_kind, r.target_json, r.updated_at
FROM log_heads h
LEFT JOIN refs r ON r.ref_name = 'log:' || h.log_id || ':' || h.head
ORDER BY r.updated_at DESC, h.created_at DESC;
```

```sql
SELECT seq, envelope_id AS event_id, hash AS event_hash, prev_hash,
       payload_kind AS kind, causality_json, appended_at
FROM log_events
WHERE log_id = ? AND head = ?
ORDER BY seq DESC
LIMIT 100;
```

To connect what an agent privately did to what users or other agents actually
received, join channel log rows back to their origin trajectory rows:

```sql
SELECT c.log_id AS channel_id, c.seq AS channel_seq, c.envelope_id,
       t.log_id AS trajectory_id, t.head AS branch_id,
       t.turn_id, t.payload_kind AS kind, t.envelope_id AS event_id
FROM log_events c
JOIN log_heads ch ON ch.log_id = c.log_id
                 AND ch.head = c.head
                 AND ch.log_kind = 'channel'
JOIN log_events t ON t.log_id = c.origin_log_id
                 AND t.head = c.origin_head
                 AND t.envelope_id = c.origin_envelope_id
ORDER BY c.log_id, c.seq;
```

Keep the distinction clear:

- trajectory log rows are private, branchable agentic history.
- channel log rows are transmitted PubSub history.
- the `origin_*` columns make published trajectory events queryable from channel
  rows without making them the same record.

Large values are stored by reference. Do not run broad hydrated reads and return
them from `eval`; use `inspect*` APIs first, then fetch one digest or envelope
only when the exact artifact is needed. `payload_ref_json` is the durable column
name even when the value is inline JSON; there is no `payload_json` column.

Contexts behave like isolated workspace state views. A source edit affects the
running app only after the relevant context commits and the runtime build
reloads that artifact. When a fix appears ignored, inspect VCS status, build
events, and runtime build provenance before assuming the code path is still
broken.

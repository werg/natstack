---
name: gad-review
description: Review code provenance using NatStack's canonical trajectory log, channel envelopes, worktree state graph, state transitions, and per-edit operations.
---

# GAD Review

Use the canonical agentic trajectory architecture:

- Conversation authority: `log_events` + `log_heads` where `log_kind = 'trajectory'`; projections live in `trajectory_messages`, `trajectory_message_blocks`, `trajectory_invocations`, and related `trajectory_*` tables.
- Channel publications: channel log rows in `log_events` where the joined `log_heads.log_kind = 'channel'`; published trajectory rows are linked by `origin_log_id`, `origin_head`, and `origin_envelope_id`.
- Worktree provenance: `gad_state_transitions` (input/output state hashes per event) and `gad_worktree_edit_ops` (per-path edit ops with hunks).
- Branch heads: `log_heads` plus `refs` entries named `log:<logId>:<head>` and worktree refs named `worktree:<logId>:<head>`.

Core queries:

```sql
SELECT h.log_id, h.head, h.log_kind, r.target_json, r.updated_at
FROM log_heads h
LEFT JOIN refs r ON r.ref_name = 'log:' || h.log_id || ':' || h.head
ORDER BY r.updated_at DESC, h.created_at DESC;
```

```sql
SELECT envelope_id AS event_id, seq, payload_kind AS kind,
       causality_json, payload_ref_json, appended_at
FROM log_events
WHERE log_id = ? AND head = ?
ORDER BY seq;
```

```sql
SELECT st.event_id, st.invocation_id, st.input_state_hash, st.output_state_hash,
       op.ordinal, op.kind, op.path, op.old_content_hash, op.new_content_hash, op.hunks_json
FROM gad_state_transitions st
JOIN gad_worktree_edit_ops op ON op.event_id = st.event_id
WHERE st.invocation_id = ?
ORDER BY st.created_at, op.ordinal;
```

```sql
SELECT st.*, e.payload_kind AS kind, e.causality_json, e.payload_ref_json
FROM gad_state_transitions st
JOIN log_events e ON e.envelope_id = st.event_id
WHERE st.output_state_hash = ?
ORDER BY e.seq DESC;
```

Use only canonical log, projection, and worktree-state tables; older event/session table families are not part of this schema.

Prefer diagnostic APIs before raw SQL when investigating a live agent:

- `gad.inspectTurnState({ branchId, channelId })` for stuck typing/open turn checks.
- `gad.inspectInvocationState({ invocationId, transportCallId })` for eval/tool status mismatches.
- `gad.inspectPublicationIntegrity({ channelId, branchId })` for publication join issues.
- `gad.inspectChannelEnvelopes({ channelId, limit })` for payload summaries without hydrating large blobs.

For the full current diagnostic workflow and planned hardening designs, read
`../gad-context/DIAGNOSTICS.md`.

Do not treat every agentic channel envelope without `origin_*` columns as a bug.
User/channel-origin agentic envelopes are expected to have no trajectory origin;
only rows meant to publish private trajectory events should point back to an
origin log/head/envelope.

Review posture:

- Prefer fail-loud invariant checks over defensive projection code that hides
  corrupt logs.
- Treat unexpectedly large inline payloads as storage-boundary bugs.
- Treat empty roster, open turn, streaming message, or mismatched invocation
  reports as system state issues until the inspector APIs prove otherwise.
- When a code fix appears ineffective, verify context git state and running
  build provenance before changing the fix.

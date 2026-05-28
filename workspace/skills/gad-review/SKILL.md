---
name: gad-review
description: Review code provenance using NatStack's canonical trajectory log, channel envelopes, worktree state graph, file mutation projections, and blame hunks.
---

# GAD Review

Use the canonical agentic trajectory architecture:

- Conversation facts: `trajectory_events`, `trajectory_messages`, `trajectory_message_blocks`, `trajectory_invocations`.
- Channel publications: `channel_envelopes`.
- Worktree provenance: `gad_file_mutations`, `gad_file_observations`, `gad_state_transitions`, `gad_file_change_hunks`.
- Branch heads: `trajectory_branches`.

Core queries:

```sql
SELECT trajectory_id, branch_id, head_event_id, head_event_hash, head_state_hash, updated_at
FROM trajectory_branches
ORDER BY updated_at DESC;
```

```sql
SELECT event_id, seq, kind, causality_json, payload_ref_json, created_at
FROM trajectory_events
WHERE branch_id = ?
ORDER BY seq;
```

```sql
SELECT m.*, h.*
FROM gad_file_mutations m
LEFT JOIN gad_file_change_hunks h ON h.mutation_id = m.mutation_id
WHERE m.invocation_id = ?
ORDER BY m.created_at, h.id;
```

```sql
SELECT st.*, e.kind, e.causality_json, e.payload_ref_json
FROM gad_state_transitions st
JOIN trajectory_events e ON e.event_id = st.event_id
WHERE st.output_state_hash = ?
ORDER BY e.seq DESC;
```

Use only canonical trajectory, channel, and worktree-state tables; older event/session table families are not part of this schema.

Prefer diagnostic APIs before raw SQL when investigating a live agent:

- `gad.inspectTurnState({ branchId, channelId })` for stuck typing/open turn checks.
- `gad.inspectInvocationState({ invocationId, transportCallId })` for eval/tool status mismatches.
- `gad.inspectPublicationIntegrity({ channelId, branchId })` for publication join issues.
- `gad.inspectChannelEnvelopes({ channelId, limit })` for payload summaries without hydrating large blobs.

For the full current diagnostic workflow and planned hardening designs, read
`../gad-context/DIAGNOSTICS.md`.

Do not treat every agentic channel envelope without a publication join as a bug.
Only trajectory-published envelopes referenced by `external.envelope_published`
must have `trajectory_channel_publications` rows; user/channel-origin agentic
envelopes are expected to be unjoined.

Review posture:

- Prefer fail-loud invariant checks over defensive projection code that hides
  corrupt logs.
- Treat unexpectedly large inline payloads as storage-boundary bugs.
- Treat empty roster, open turn, streaming message, or mismatched invocation
  reports as system state issues until the inspector APIs prove otherwise.
- When a code fix appears ineffective, verify context git state and running
  build provenance before changing the fix.

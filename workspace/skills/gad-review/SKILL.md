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
SELECT event_id, seq, kind, causality_json, payload_json, created_at
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
SELECT st.*, e.kind, e.causality_json, e.payload_json
FROM gad_state_transitions st
JOIN trajectory_events e ON e.event_id = st.event_id
WHERE st.output_state_hash = ?
ORDER BY e.seq DESC;
```

Use only canonical trajectory, channel, and worktree-state tables; older event/session table families are not part of this schema.

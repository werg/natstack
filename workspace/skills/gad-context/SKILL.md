---
name: gad-context
description: Query NatStack's canonical trajectory model for conversation context, runtime events, channel envelopes, worktree states, file provenance, and semantic facts.
---

# GAD Context

Use the `gad` runtime namespace. The storage model is canonical trajectory-first:

- Agent context lives in `trajectory_events` plus projections such as `trajectory_messages`, `trajectory_message_blocks`, `trajectory_invocations`, and `trajectory_approvals`.
- Channel delivery lives in `channel_envelopes`.
- Published trajectory events are joined to transmitted channel messages through
  `trajectory_channel_publications`. Do not infer this relationship by matching
  payload text or timestamps.
- Worktree state lives in `gad_worktree_states`, manifest tables, file versions, state transitions, mutations, observations, and hunks.

Use only the canonical tables above; older event/session table families do not exist in this schema.

Useful APIs:

- `gad.getTrajectoryBranchHead({ trajectoryId, branchId })`
- `gad.listTrajectoryEvents({ trajectoryId, branchId, cursor, limit })`
- `gad.appendTrajectoryBatch({ trajectoryId, branchId, owner, events })`
- `gad.listChannelEnvelopes({ channelId, cursor, limit, payloadKind })`
- `gad.getChannelReplayWindow({ channelId, mode, sinceSeq, beforeSeq, limit })`
- `gad.getTrajectoryForEnvelope({ envelopeId })`
- `gad.listPublishedEnvelopesForTrajectory({ trajectoryId, branchId, eventId, turnId, channelId, limit })`
- `gad.listGadBranchFiles({ branchId })`
- `gad.diffGadStates({ leftStateHash, rightStateHash })`
- `gad.readGadFileAtState({ stateHash, path })`
- `gad.getGadStateProducer({ stateHash })`
- `gad.blameGadFileSnippet({ stateHash, path })`

For SQL reads, prefer:

```sql
SELECT trajectory_id, branch_id, head_event_id, head_event_hash, head_state_hash, updated_at
FROM trajectory_branches
ORDER BY updated_at DESC;
```

```sql
SELECT seq, event_id, event_hash, prev_event_hash, kind,
       causality_json, created_at
FROM trajectory_events
ORDER BY seq DESC
LIMIT 100;
```

To connect what an agent privately did to what users or other agents actually
received, query the publication join:

```sql
SELECT p.channel_id, p.channel_seq, p.envelope_id,
       te.branch_id, te.turn_id, te.kind, te.event_id
FROM trajectory_channel_publications p
JOIN trajectory_events te ON te.event_id = p.event_id
ORDER BY p.channel_id, p.channel_seq;
```

Keep the distinction clear:

- `trajectory_events` is the private, branchable agentic trajectory.
- `channel_envelopes` is the transmitted PubSub history.
- `trajectory_channel_publications` makes the two queryable together without
  making them the same record.

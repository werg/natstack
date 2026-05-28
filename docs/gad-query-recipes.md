# GAD Query Recipes

GAD uses the canonical agentic trajectory schema:

- `trajectory_branches`
- `trajectory_events`
- `trajectory_turns`
- `trajectory_messages`
- `trajectory_message_blocks`
- `trajectory_invocations`
- `trajectory_channel_publications`
- `channel_envelopes`
- `channel_roster`
- `gad_*` worktree provenance tables

For agent-facing guidance, prefer `workspace/skills/gad-context/SKILL.md` and
`workspace/skills/gad-context/DIAGNOSTICS.md`. This file is a developer-oriented
SQL companion for the current schema.

## Safe Inspection Order

Start with bounded APIs:

```ts
await gad.inspectTurnState({ branchId });
await gad.inspectInvocationState({ transportCallId });
await gad.inspectPublicationIntegrity({ channelId, branchId });
await gad.inspectChannelEnvelopes({ channelId, limit: 50 });
await gad.inspectStorageDiagnostics({ rowByteLimit: 512 * 1024 });
```

Use hydrated APIs only after identifying a specific envelope, event, digest, or
state hash.

## Branch Head

```sql
SELECT trajectory_id, branch_id, head_event_id, head_event_hash,
       head_state_hash, created_at, updated_at
FROM trajectory_branches
ORDER BY updated_at DESC;
```

## Recent Trajectory Events

```sql
SELECT branch_id, seq, event_id, turn_id, kind,
       causality_json, created_at
FROM trajectory_events
WHERE branch_id = ?
ORDER BY seq DESC
LIMIT 100;
```

`payload_ref_json` is the durable payload column. It may contain inline JSON or
stored-value refs. There is no `payload_json` column.

## Turn State

Prefer `gad.inspectTurnState`, or use:

```sql
SELECT t.branch_id, t.turn_id, t.opened_at, t.closed_at,
       COUNT(DISTINCT CASE WHEN m.status != 'completed' THEN m.message_id END)
         AS streaming_messages,
       COUNT(DISTINCT CASE WHEN i.status NOT IN
         ('completed', 'failed', 'cancelled', 'abandoned')
         THEN i.invocation_id END) AS nonterminal_invocations
FROM trajectory_turns t
LEFT JOIN trajectory_messages m ON m.branch_id = t.branch_id
LEFT JOIN trajectory_invocations i ON i.branch_id = t.branch_id
WHERE t.branch_id = ?
GROUP BY t.branch_id, t.turn_id, t.opened_at, t.closed_at
ORDER BY t.opened_at DESC;
```

Duplicate turn opens are invariant failures:

```sql
SELECT branch_id, turn_id, COUNT(*) AS count,
       MIN(created_at) AS first_opened_at,
       MAX(created_at) AS last_opened_at
FROM trajectory_events
WHERE kind = 'turn.opened' AND turn_id IS NOT NULL
GROUP BY branch_id, turn_id
HAVING COUNT(*) > 1;
```

## Invocation State

Prefer `gad.inspectInvocationState`, or use:

```sql
SELECT i.branch_id, i.invocation_id, i.transport_call_id,
       i.kind, i.status, i.started_event_id, i.completed_event_id,
       COUNT(CASE WHEN e.kind = 'invocation.started' THEN 1 END)
         AS started_events,
       COUNT(CASE WHEN e.kind IN
         ('invocation.completed', 'invocation.failed',
          'invocation.cancelled', 'invocation.abandoned')
         THEN 1 END) AS terminal_events
FROM trajectory_invocations i
LEFT JOIN trajectory_events e
  ON e.branch_id = i.branch_id
 AND json_extract(e.causality_json, '$.invocationId') = i.invocation_id
WHERE i.transport_call_id = ?
GROUP BY i.branch_id, i.invocation_id, i.transport_call_id, i.kind, i.status,
         i.started_event_id, i.completed_event_id
ORDER BY i.updated_at DESC;
```

## Publication Integrity

Do not treat every unjoined channel envelope as a bug. Only publications declared
by `external.envelope_published` require `trajectory_channel_publications` rows.

Declared publications:

```sql
SELECT event_id, branch_id, payload_ref_json
FROM trajectory_events
WHERE kind = 'external.envelope_published'
ORDER BY branch_id, seq;
```

Join row sanity:

```sql
SELECT p.event_id, p.channel_id, p.channel_seq, p.envelope_id,
       te.event_id AS trajectory_event_id,
       ce.envelope_id AS channel_envelope_id,
       ce.seq AS actual_channel_seq
FROM trajectory_channel_publications p
LEFT JOIN trajectory_events te ON te.event_id = p.event_id
LEFT JOIN channel_envelopes ce ON ce.envelope_id = p.envelope_id
WHERE p.channel_id = ?
ORDER BY p.channel_seq;
```

Expected channel-origin agentic envelopes without joins:

```sql
SELECT ce.channel_id, ce.seq, ce.envelope_id, ce.payload_kind
FROM channel_envelopes ce
LEFT JOIN trajectory_channel_publications p ON p.envelope_id = ce.envelope_id
WHERE ce.payload_kind = 'agentic.trajectory.v1/event'
  AND p.envelope_id IS NULL
ORDER BY ce.seq;
```

## Channel Roster

Presence envelopes project into `channel_roster`:

```sql
SELECT channel_id, participant_id, joined_at, left_at, roles_json
FROM channel_roster
WHERE channel_id = ?
ORDER BY joined_at;
```

If this is empty while presence envelopes exist, inspect presence payload shape
before assuming the participant never joined.

## Storage Diagnostics

Large payload fields should be stored as refs:

```sql
SELECT 'trajectory_events' AS scope, event_id AS id,
       length(payload_ref_json) AS bytes
FROM trajectory_events
WHERE length(payload_ref_json) > 512 * 1024
UNION ALL
SELECT 'channel_envelopes' AS scope, envelope_id AS id,
       length(payload_ref_json) AS bytes
FROM channel_envelopes
WHERE length(payload_ref_json) > 512 * 1024
ORDER BY bytes DESC;
```

Stored refs:

```sql
SELECT 'trajectory' AS ref_scope, event_id AS owner_id,
       field_path, digest, purpose, size, created_at
FROM trajectory_blob_refs
WHERE event_id = ?
UNION ALL
SELECT 'channel' AS ref_scope, envelope_id AS owner_id,
       field_path, digest, purpose, size, created_at
FROM channel_blob_refs
WHERE envelope_id = ?;
```

## Worktree State

Latest branch state:

```sql
SELECT branch_id, head_state_hash
FROM trajectory_branches
WHERE branch_id = ?;
```

Files at a state:

```sql
SELECT mn.path, fv.content_hash, fv.mode
FROM gad_worktree_states ws
JOIN gad_manifest_nodes root ON root.hash = ws.manifest_root_hash
JOIN gad_manifest_entries me ON me.parent_hash = root.hash
JOIN gad_file_versions fv ON fv.id = me.file_version_id
JOIN gad_manifest_nodes mn ON mn.hash = me.child_hash
WHERE ws.state_hash = ?
ORDER BY mn.path;
```

Prefer runtime APIs such as `gad.listGadBranchFiles`, `gad.diffGadStates`, and
`gad.readGadFileAtState` for agent-facing work.

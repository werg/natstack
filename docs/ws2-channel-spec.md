# WS2 — Generic Pub/Sub Substrate: Channel DO De-agentification Spec

Binding implementation spec for workstream WS2 of the Unified Log Architecture
plan (`~/.claude/plans/ok-grat-create-a-unified-shore.md`, §WS2). It builds
ONLY on the Stage-0 foundation contract (`docs/stage0-unified-log-spec.md`):
the gad-store DO's `appendLogEvent` / `forkLog` / `readLog` / `getLogEvent` /
`getLogHead` / `refs` surface and the protocol's `LogEnvelope`. Names and
signatures below are exact. This spec is self-contained: implementers do NOT
need to read the current `channel-do.ts`.

Design principles in force: P1 (every persistent structure is log / value /
ref / cache), P2 (journal before dispatch; pending ≡ intention without outcome
in the log), P3 (cache amnesia), P4 (pure folds), P6 (no coexistence shims for
our own callers).

---

## 0. What exists today (current-state inventory)

`workspace/workers/pubsub-channel/` contains:

| File | Lines | Role today |
|---|---|---|
| `channel-do.ts` | 2,265 | `PubSubChannel extends DurableObjectBase`, schemaVersion 104. Everything: roster, publish, method calls, registry cache, conversation state, alarms, fork, admin inspection. |
| `channel-log-store.ts` | 296 | `ChannelLogStore` interface + `GadChannelLogStore` — delegates durable envelopes to gad-store via the legacy channel adapters (`appendChannelEnvelope`, `getChannelReplayWindow`, `forkChannelLog`, …), blob-spills payloads via `blobstore.putText`/`getText`. |
| `broadcast.ts` | 210 | Per-subscriber FIFO emit chains (`queueEmit`), ordered DO delivery (`queueDoEnvelope`), `broadcast()`, `buildChannelEvent`, wire encoders `channelEventToRpcLog`/`channelEventToRpcSignal`. |
| `invocation-calls.ts` | 159 | Raw SQL helpers over `pending_calls`: `storeCall`, `consumeCall`, `peekCall`, `cancelCall`, `cancelCallsForTarget`. |
| `types.ts` | 60 | `SubscribeResult`, `ChannelConfig`, `PresencePayload`, `BroadcastEnvelope`, `StoredAttachment`. |
| `channel-do.test.ts` | 1,456 | The UX-guard suite (must keep passing; legitimate changes enumerated in §9). |

Local SQLite tables (channel DO): `participants(id, metadata, transport,
connected_at, session_id, handle)`, `pending_calls(transport_call_id PK,
invocation_id, turn_id, caller_id, target_id, method, args, created_at,
deadline_at)`, `dedup_keys(key PK, result_id, created_at)`,
`message_types(type_id PK, definition_json, updated_at_seq, cleared_at_seq)`,
plus the generic `state` KV from `DurableObjectBase`.

Agentic concerns currently baked into the transport (all to be extracted or
deleted):

1. **`stampAgentHops(payload)`** (channel-do.ts:1235) — on `publish` of an
   agent-authored `message.completed`, MUTATES the payload:
   `payload.causality.agentHops = agentStreak + 1` (unless already present),
   reading streak from KV `conversation:agentStreak`.
2. **`recordConversationState(participantId, payload, seq)`**
   (channel-do.ts:1245) — on every published `message.completed`, writes six
   KV keys: `conversation:lastCompletedSender`, `:lastCompletedSeq`,
   `:lastCompletedAt`, `:previousCompletedSender`, `:previousCompletedSeq`,
   `:agentStreak`. Exposed via RPC `getConversationState()`. **Wiped in
   `postClone` (channel-do.ts:2243–2248) — the fork conversation-state bug:**
   a forked channel restarts with streak 0 / no last-sender, breaking loop
   detection and `mentioned-or-followup` addressing in forks.
3. **Invocation payload builders** — `invocationStartedPayload`,
   `invocationResultPayload`, `invocationOutputPayload`,
   `invocationCancelledPayload` (channel-do.ts:220–360) synthesize
   `invocation.*` AgenticEvents for the call transport.
4. **Message-type registry cache** — local `message_types` table +
   `ensureRegistryHydrated()` (full re-fetch from GAD on first use per wake) +
   `cacheMessageTypeMutation`/`cacheMessageTypes`/`localMessageTypes` +
   `registryMutationFromPublishedPayload()` (derives a
   `RegistryMutationInput` from `messageType.registered/cleared` payloads,
   throws `Invalid registry payload …` on malformed ones) +
   `appendRegistryEvent` → GAD `appendChannelEnvelopeWithRegistryMutation`.
5. **Transport schema validation** — `publish()` runs
   `storedAgenticEventSchema.safeParse(payload)` for
   `payloadKind === AGENTIC_EVENT_PAYLOAD_KIND` and throws the first zod issue
   message.

**Who reads agentHops from payloads today:** exactly one reader —
`trajectory-vessel-base.ts:4680` (`const causality = (agentic?.causality ?? {})
as { agentHops?: number }`) feeding `resolveShouldRespond` at :4719 via
`AddressedMessage.agentHops`. `addressing.ts` itself never touches payloads —
it consumes the already-extracted `AddressedMessage` (so `addressing.ts` and
`addressing.test.ts` are untouched by this spec).

**Who reads conversation KV:** `getConversationState()` RPC, called only by
`channel-client.ts:158` (`@workspace/agentic-do`), consumed only at
`trajectory-vessel-base.ts:4691` inside `shouldRespond` (with the
"previous-slot" correction: when deciding for the just-delivered event whose
seq equals `lastCompletedSeq`, it uses `previousCompletedSender`).

**Who reads the message_types cache:** RPC `getMessageTypes()` /
`getMessageType(typeId)` on the channel DO (panel sandbox-card rendering path
through pubsub client). GAD already owns the authoritative
`channel_message_types` table.

**Where `delivery_cursor` lives:** NOT in the channel DO. It is a
vessel-side table — `trajectory-vessel-base.ts:3450` (DDL), read at :5168,
written at :5175 (`last_delivered_seq` per channel), cleared at :8042, dumped
in diagnostics at :8442/:8592. Its only purpose is dedup/ordering of channel
deliveries into the agent. Under the plan it is a cache pretending to be
authority (P1): the last-observed envelope seq is derivable by folding the
agent's own trajectory log (every delivered envelope that mattered produced a
logged consequence) or by replaying the channel log from any seq —
deliveries are idempotent by envelopeId. **Deletion lands with the vessel in
the Stage B cut (WS1.7)**; WS2's obligation is only that nothing NEW depends
on it and the replacement read ("what have I seen") is a fold, not a table.
No channel-side change is required for this item.

**The terminal-ordering bug (the concrete fix target):**
`handleMethodResult()` (channel-do.ts:1889) first calls
`consumeCall(this.sql, transportCallId)` — a SYNCHRONOUS SELECT+DELETE of the
`pending_calls` row (channel-do.ts:1899, invocation-calls.ts:42–70) — and only
then awaits `settleConsumedMethodCall → deliverCallResult`, whose GAD append of
the terminal `invocation.completed/failed/cancelled/abandoned` happens at
channel-do.ts:2078. A crash/hibernation between the sync delete and the async
append permanently loses the durable terminal: the pending row is gone (so no
retry path exists) and the log has a started without a terminal forever — the
caller hangs until unrelated recovery. The started path is the mirror-correct
order today (row stored, then append), and stays convergent under §5.

Other current behaviors that MUST be preserved exactly (the "do not break"
list — each is asserted by `channel-do.test.ts`):

- `subscribe(participantId, metadata)`:
  - caller identity check (`rpcCallerId` must equal participantId when set);
  - DO participants detected by `participantId.startsWith("do:")`, parsed as
    `do:{source}:{className}:{objectKey}` (objectKey may contain `:`);
    DO existence verified via `main.workers.resolveDurableObject`;
  - channel init on first `metadata.contextId` (KV `contextId`, `createdAt`,
    optional `config`); context mismatch throws;
  - handle uniqueness: a second live participant advertising the same
    `metadata.handle` is rejected with the message
    `Participant handle "{h}" is already in use by another participant ({id}) in this channel. Handles must be unique.`;
  - advertised method-name validation: each `metadata.methods[].name` must
    match `/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/` and not be in
    `{read, edit, write, grep, find, ls}`;
  - re-subscribe with same id: leave-presence published with reason
    `replaced` (session id changed or unknown) or `graceful`, old row deleted,
    emit/delivery chains reset; on session replacement, still-pending calls
    targeting this participant are re-delivered as signals
    (`redeliverPendingCallsTo`);
  - subscribe-time hints stripped from stored metadata: `contextId`,
    `channelConfig`, `replay`, `sinceId`, `replayMessageLimit`, `transport`,
    `PARTICIPANT_SESSION_METADATA_KEY`;
  - join presence published BEFORE replay is built (initial roster snapshot
    includes self);
  - replay: `mode = "after"` when `replay !== false && sinceId > 0`, else
    `initial` with limit `replayMessageLimit ?? 50` (0 when `replay === false`);
    replay events, then roster snapshot, then `ready` control message, all
    through the per-subscriber FIFO (`queueEmit`, plus `queueDoEnvelope` for
    DO transports); fatal delivery errors (`TARGET_NOT_REACHABLE`,
    `RECONNECT_GRACE_EXPIRED`, `DO_NOT_CREATED`) evict the participant
    silently;
  - returns `{ ok, channelConfig?, envelope }`.
- `publish(participantId, type, payload, opts)`:
  - `idempotencyKey` dedup: `dedup_keys` row + `publishDedupInFlight`
    in-memory map dedupes CONCURRENT publishes before the append settles
    (one GAD append for two racing publishes; both resolve `{id: sameSeq}`);
    a reserved key with NULL result (crashed earlier attempt) is re-owned;
  - presence/join consumes seq 1, so the first publish lands at seq 2
    (tests assert exact ids);
  - sender metadata for the durable envelope comes from the roster row;
  - broadcast `{kind:"log", phase:"live"}` after append, with `ref` echoed
    only to the sender;
  - oversized payload fields are blob-spilled (`natstack.blob-ref.v1`) on the
    durable side and hydrated on replay; blobstore failure fails the publish.
- Method-call transport:
  - `callMethod(callerPid, targetPid, callId, method, args, opts)` stores a
    pending call keyed by `transportCallId` (default `callId`), appends a
    durable `invocation.started` with `envelopeId = invocationId` (via
    `messageId`), `causality = {invocationId, transportCallId}`, payload
    `{name: method, invocationType: "panel", request: args, transport:
    {kind:"channel", channelId, target, transportCallId}, userVisible:false}`,
    broadcasts it, then dispatches: DO target → `rpc.call(target,
    "onMethodCall", [channelId, transportCallId, method, args, {invocationId,
    turnId}])` fire-and-forget via `waitUntil` (the DO's return value settles
    the call through `handleMethodResult`); RPC target → no extra dispatch
    (the log broadcast IS the delivery). Missing target → immediate error
    settle. `opts.timeoutMs` sets `deadline_at`.
  - `submitMethodResult` / `submitMethodProgress`: provider-identity auth —
    only the call's target may submit; wrong participant throws
    `… rejected: participant X is not target Y for method call Z`; no pending
    call ⇒ result drops with diagnostic `{id: undefined}` / progress is a
    quiet no-op.
  - `submitMethodProgress` appends durable `invocation.output` for a
    still-pending call only (small chunks stay inline, no blob).
  - `cancelMethodCall(callId)` / `timeoutMethodCall(callId, reason?)` append
    `invocation.cancelled` with actor `system`, terminalOutcome `cancelled`;
    timeout additionally publishes a `ui.feedback` event (category
    `method_call_failed`, occurrenceKey `method_call_failed:{transportCallId}`)
    targeted at the non-responsive provider.
  - `failPendingCallsTargeting(targetId, reason)` on unsubscribe/eviction:
    every pending call targeting the leaver gets a durable
    `invocation.abandoned` terminal with a reason-specific message.
  - Terminal payload mapping (`invocationResultPayload`): outcome
    `cancelled`/`stale_dispatch` → `invocation.cancelled`; `abandoned` →
    `invocation.abandoned`; otherwise `invocation.failed` (outcome
    `infrastructure_error` or `tool_error`, reasonCode default
    `method_failed`) / `invocation.completed` (`{result}`).
  - `ensureMethodRoot` — before any output/terminal append, if no envelope
    with `envelopeId === invocationId` exists in the log, append a synthetic
    `invocation.started` (caller/target `unknown` fallbacks) so terminals are
    never orphaned.
  - Terminal events persist even when the caller has already left (append
    happens regardless; broadcast skipped if caller absent).
- Presence: durable `presence` envelopes for join/leave/update with PUBLIC
  metadata (`publicParticipantMetadata` — method schemas are stripped to
  `[{name}]`); typing state is signal-only (`broadcastPresenceSignal`, no
  append); `touch()` bumps `connected_at`; stale RPC participants (no
  heartbeat for 5 min) evicted by alarm, with abandoned-terminals + leave
  presence.
- `sendSignal` / signal broadcasts: never appended, `kind:"signal"` wire shape.
- `error(participantId, messageId, errorMessage, code?)`: durable `error`
  envelope `{id, error, code?}`.
- `updateConfig` merges + persists KV `config`, appends durable
  `config-update` envelope as sender `system`, refreshes the channel title
  registry (`setOwnTitle`/`setOwnTitleExplicitly`, default label `Channel`).
- `broadcastStoredEnvelopes(envelopeIds)` — re-broadcasts envelopes appended
  to GAD out-of-band (used by trajectory publication fan-out).
- `getParticipants()` returns `{participantId, metadata, transport, doRef?}`.
- `postClone(parentChannelId, forkPointId)` — fixes `__objectKey`, records
  `forkedFrom`/`forkPointId`, forks the durable log, clears roster +
  pending_calls + dedup_keys (+ today: conversation KV).
- Admin surface (privileged callers: id `main`, or kind
  `server`/`shell`/`harness`): `adminUnsubscribeParticipant`,
  `adminUpdateParticipantMetadata`, `adminSetParticipantTypingState`,
  `adminInspectSchema` (incl. invariant `durable-log-delegated-to-gad`: no
  local `channel_envelopes` table), `adminInspectLog`, `adminInspectEnvelope`,
  `adminReconstructTranscript`, `adminValidateLog`, `getState`.

---

## 1. Target architecture overview

```
workspace/packages/channel-policies/        NEW package (pure, vitest-only)
  src/index.ts                              ChannelPolicy interface + registry
  src/conversation-v1.ts                    agentic.conversation.v1 policy
  src/conversation-v1.test.ts

workspace/workers/pubsub-channel/
  channel-do.ts        (~550 lines)  RPC surface + wiring ONLY
  roster.ts            NEW           participants table, presence, validation
  calls.ts             NEW           pending_calls cache + settle pipeline
                                     (replaces invocation-calls.ts — delete it)
  policy-host.ts       NEW           policy_state cache + fold/annotate host
  log-store.ts         NEW           rewritten channel-log-store.ts on the
                                     unified-log API (delete channel-log-store.ts)
  broadcast.ts         KEPT          unchanged except ChannelEvent.annotations
  types.ts             KEPT          + zod participantMetadataSchema
  channel-do.test.ts   KEPT          updated per §9
```

The channel DO becomes a generic substrate: durable ordered log + live fan-out
+ roster + call transport. Every agentic decision (hop stamping, conversation
fold, invocation payload shapes) lives in `@workspace/channel-policies`,
selected by name from channel config — fixed registry, not user code
(annotation must be atomic with sequencing; sandboxing is unnecessary
pre-release).

State taxonomy after this spec (P1 classification — normative):

| Structure | Kind | Derivation |
|---|---|---|
| Channel log (`log_events` rows in gad-store, `logId=channelId, head="main"`) | **Log** | authority |
| `participants` table | operational transport state (live connections — not derivable from the log; presence events are journal *observations* of it) |
| `pending_calls` table | **Cache** | `derivePendingCalls(fold(log))` — §5 |
| `policy_state:*` KV | **Cache** | `policy.reduce` folded through `foldedThroughSeq` — §4 |
| `dedup_keys` table | **Cache** | lineage-scoped envelopeId dedupe in GAD is the authority (§3.2); rows only short-circuit the round-trip |
| KV `contextId`, `config`, `createdAt`, `forkedFrom`, `forkPointId`, `__objectKey` | **Ref**-like channel metadata (mutable pointers/config; config changes journaled as `config-update` envelopes) |

`message_types` table: DELETED (GAD's `channel_message_types` projection is
the only copy). Conversation KV: DELETED (absorbed into policy_state).

---

## 2. `log-store.ts` — unified-log access (replaces `channel-log-store.ts`)

Talks to gad-store DIRECTLY through Stage-0 core methods (P6: do not build on
the legacy channel adapters, which die in Stage B). Same blob spill/hydrate
behavior as today (`encodeChannelPayloadStoredValues` /
`hydrateStoredValueRefs` via `main.blobstore.putText/getText`).

```ts
// log-store.ts
import { CHANNEL_LOG_HEAD } from "@workspace/agentic-protocol"; // "main", Stage 0

export interface ChannelAppendInput {
  payloadKind: string;                 // "agentic.trajectory.v1/event" | "presence" | "error" | "config-update" | ...
  payload: unknown;
  senderId: string;
  senderMetadata?: Record<string, unknown>;   // PUBLIC metadata; stored under annotations.metadata
  envelopeId?: string;                 // deterministic ids welcome (invocationId, terminal:{id}, ik:{key})
  annotations?: Record<string, unknown>;      // policy annotations (agentHops, ...)
  attachments?: StoredAttachment[];    // stored under annotations.attachments
}

export class ChannelLog {
  constructor(rpc: RpcCallerLike, channelId: string) {}

  /** appendLogEvent({logId: channelId, head: "main", logKind: "channel",
   *  events: [{envelopeId, actor: participantRefFromMetadata(senderId, meta),
   *            payloadKind, payload: <blob-encoded>,
   *            annotations: {...input.annotations,
   *                          ...(metadata ? {metadata} : {}),
   *                          ...(attachments ? {attachments} : {})}}]})
   *  Returns the appended envelope mapped to ChannelEvent. */
  append(input: ChannelAppendInput): Promise<ChannelEvent>;

  /** forkLog({fromLogId: parentChannelId, fromHead: "main",
   *           toLogId: channelId, toHead: "main", atSeq: throughSeq}) */
  forkFrom(parentChannelId: string, throughSeq: number | null): Promise<void>;

  /** getLogEvent({logId: channelId, head: "main", envelopeId}) — lineage-aware. */
  getByEnvelopeId(envelopeId: string): Promise<ChannelEvent | null>;
  hasEnvelope(envelopeId: string): Promise<boolean>;

  /** readLog pages (ascending), lineage-aware. */
  read(opts: { afterSeq?: number; beforeSeq?: number; limit?: number;
               payloadKind?: string }): Promise<LogEnvelope[]>;

  /** Replay windows: same ChannelReplayEnvelope shapes as today
   *  (mode/logEvents/snapshots/ready{totalCount, envelopeCount,
   *  firstEnvelopeSeq, replayFromId, replayToId, hasMoreBefore?}).
   *  totalCount/headSeq from getLogHead; firstEnvelopeSeq = forkSeq+1 for
   *  forked channels else 1; hasMoreBefore computed against that bound. */
  replayInitial(limit, ctx): Promise<ChannelReplayEnvelope>;
  replayAfter(sinceSeq, ctx): Promise<ChannelReplayEnvelope>;     // limit 500
  replayBefore(beforeSeq, limit, ctx): Promise<ChannelReplayEnvelope>;

  inspectRows(opts): Promise<Record<string, unknown>[]>;          // for admin*
  inspectEnvelope(envelopeId): Promise<Record<string, unknown>[]>;
}
```

`ChannelEvent` mapping from `LogEnvelope` (extends today's
`eventFromGadEnvelope`):

```ts
{
  id: envelope.seq,
  messageId: String(envelope.envelopeId),
  type: envelope.payloadKind,
  payload: <hydrated payload>,
  senderId: envelope.actor.participantId ?? envelope.actor.id,
  senderMetadata: envelope.annotations?.metadata ?? envelope.actor.metadata,
  ts: Date.parse(envelope.appendedAt),
  attachments: envelope.annotations?.attachments,
  annotations: <envelope.annotations minus metadata/attachments>,  // NEW, §7
}
```

**`ChannelEvent` gains `annotations?: Record<string, unknown>`** (additive,
optional — declared in `@workspace/harness` where ChannelEvent lives;
`buildChannelEvent` in broadcast.ts gains a trailing optional `annotations`
parameter). This is the carrier for `agentHops` to subscribers.

**Deleted from the transport (moved to GAD append-time, Stage-0 §2.3 step 6):**
`storedAgenticEventSchema.safeParse` in `publish()`. GAD already validates any
`payloadKind === AGENTIC_EVENT_PAYLOAD_KIND` payload as a stored agentic event
inside the append txn and sanitizes participant refs. The channel passes
payloads through opaquely. Sender-side sanitization
(`sanitizeAgenticEventParticipantRefs`) also moves fully to GAD — the
log-store only does blob encoding.

**Registry mutation moves to a GAD projection (WS2-owned delta to gad-store,
layered on Stage 0):** add a projection applier `projectMessageTypeEvent` in
`workspace/workers/gad-store/index.ts` — when a channel-log append has
`payloadKind === AGENTIC_EVENT_PAYLOAD_KIND` and `payload.kind ===
"messageType.registered" | "messageType.cleared"`, upsert/clear
`channel_message_types` in the same txn (identical SQL semantics to today's
`applyRegistryMutation`: monotone `updated_at_seq` guard, `cleared_at_seq`
max-merge). The payload is already schema-validated by step 6, so a malformed
registration is REJECTED at append (replacing the channel's
`Invalid registry payload` throw with the zod-derived message). The
`appendChannelEnvelopeWithRegistryMutation` adapter remains for any legacy
callers until Stage B but the channel DO stops calling it.

---

## 3. `channel-do.ts` — RPC surface (method-by-method mapping)

| Old (channel-do.ts) | New home | Change |
|---|---|---|
| `subscribe` | channel-do.ts, delegating to `roster.ts` | zod metadata validation (§8.4); handle uniqueness via partial unique index (§8.5); DO columns persisted (§8.3); otherwise byte-identical behavior incl. replay/redelivery |
| `unsubscribe`, `adminUnsubscribeParticipant`, `unsubscribeParticipant` | roster.ts | unchanged |
| `touch` | roster.ts | unchanged |
| `publish` | channel-do.ts | drop `stampAgentHops` + `recordConversationState` + schema validation + registry branch; add policy `annotate` + post-append `foldAppended` (§4); deterministic envelopeId for idempotent publishes (§3.2) |
| `error`, `sendSignal`, `updateMetadata`, `adminUpdateParticipantMetadata`, `setTypingState`, `adminSetParticipantTypingState` | roster.ts / channel-do.ts | unchanged |
| `getReplayAfter`, `getReplayBefore` | channel-do.ts → log-store | unchanged shapes |
| `getParticipants`, `getContextId`, `getConfig`, `updateConfig` | channel-do.ts | unchanged (updateConfig append goes through policy host like any append) |
| `getMessageTypes`, `getMessageType` | channel-do.ts | direct passthrough to gad `listMessageTypes`/`getMessageType` — NO local cache, NO hydration (§6.2) |
| `getConversationState` | **deleted** | replaced by `getPolicyState` (§4.4) |
| `stampAgentHops`, `recordConversationState` | **deleted** | absorbed by `agentic.conversation.v1` policy |
| `invocationStartedPayload` / `invocationResultPayload` / `invocationOutputPayload` / `invocationCancelledPayload` | **moved** to `channel-policies` `callEventPayload` (§4.2) | calls.ts invokes via policy host |
| `registryMutationFromPublishedPayload`, `appendRegistryEvent`, `cacheMessageTypeMutation`, `cacheMessageTypes`, `localMessageTypes`, `ensureRegistryHydrated` | **deleted** | GAD projection (§2) |
| `callMethod` | channel-do.ts → calls.ts | journal-before-dispatch order (§5.2) |
| `submitMethodResult`, `submitMethodProgress`, `assertSubmitterIsTarget`, `pendingCallTarget` | calls.ts | unchanged auth semantics |
| `handleMethodResult`, `settleConsumedMethodCall`, `deliverCallResult` | calls.ts `settleCall` | **terminal ordering fixed** (§5.3) |
| `cancelMethodCall`, `timeoutMethodCall`, `failPendingCallsTargeting`, `publishMethodCallFeedback`, `ensureMethodRoot`, `redeliverPendingCallsTo`, `timeoutExpiredPendingCalls` | calls.ts | same wire behavior; settle pipeline shared |
| `scheduleNextAlarm`, `scheduleDedupCleanup`, `scheduleParticipantCleanup`, `alarm` | channel-do.ts | single scheduler over pure next-time sources (§8.2) + `reconcilePendingCalls` on alarm |
| `broadcastStoredEnvelopes` | channel-do.ts | + `foldAppended` into policy state (out-of-band appends must advance the fold; see §4.3 ordering note) |
| `postClone` | channel-do.ts | + delete `policy_state:*` and rebuild by replay (§4.5); stop deleting conversation KV (gone) |
| `adminInspect*`, `adminValidateLog`, `adminReconstructTranscript`, `getState` | channel-do.ts | table list updated; otherwise unchanged |

`PubSubChannel.schemaVersion` bumps 104 → 105. `migrate()` drops and
recreates `participants`, `pending_calls`, `dedup_keys`; drops `message_types`
without recreation (pre-release, no data migration).

### 3.1 New table DDL (channel DO local SQLite)

```sql
CREATE TABLE IF NOT EXISTS participants (
  id            TEXT PRIMARY KEY,
  metadata      TEXT NOT NULL,
  transport     TEXT NOT NULL CHECK (transport IN ('rpc','do')),
  connected_at  INTEGER NOT NULL,
  session_id    TEXT,
  handle        TEXT,
  do_source     TEXT,        -- parsed once at subscribe (§8.3)
  do_class      TEXT,
  do_object_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_handle
  ON participants(handle) WHERE handle IS NOT NULL;     -- §8.5

CREATE TABLE IF NOT EXISTS pending_calls (               -- CACHE (§5)
  transport_call_id TEXT PRIMARY KEY,
  invocation_id     TEXT NOT NULL,
  turn_id           TEXT,
  caller_id         TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  method            TEXT NOT NULL,
  args              TEXT,
  created_at        INTEGER NOT NULL,
  deadline_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_calls_target ON pending_calls(target_id);
CREATE INDEX IF NOT EXISTS idx_pending_calls_deadline
  ON pending_calls(deadline_at) WHERE deadline_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS dedup_keys (                  -- CACHE (§3.2)
  key        TEXT PRIMARY KEY,
  result_id  INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedup_keys_created ON dedup_keys(created_at);
```

### 3.2 Durable publish idempotency (dedup_keys demoted to true cache)

Today `dedup_keys` is load-bearing: it is the ONLY dedupe for publishes, and
it is TTL-swept after 5 minutes and wiped on `postClone` — a retry after
either event duplicates the message. Fix (P2: idempotency from deterministic
ids scoped to log lineage):

- When `opts.idempotencyKey` is provided, the durable append uses
  deterministic `envelopeId = "ik:" + idempotencyKey`. GAD's lineage-scoped
  idempotent replay (Stage-0 §2.3 step 2) makes the retry a no-op returning
  the existing envelope — durably, forever, fork-aware.
- `dedup_keys` + `publishDedupInFlight` remain ONLY as a fast path that
  short-circuits the GAD round-trip and preserves the concurrent-race
  semantics asserted by the test (`appendCalls === 1` for two racing
  publishes). Deleting every row at any moment changes nothing but latency
  (P3). TTL sweep per §8.1.
- Publishes WITHOUT an idempotencyKey keep `crypto.randomUUID()` envelopeIds.

---

## 4. `@workspace/channel-policies` + `policy-host.ts`

### 4.1 Package API (`workspace/packages/channel-policies/src/index.ts`)

```ts
import type { ParticipantRef, AgenticEvent, InvocationOutcome }
  from "@workspace/agentic-protocol";

/** Minimal durable-envelope view a policy folds over. Pure data. */
export interface PolicyEnvelopeView {
  envelopeId: string;
  seq: number;
  payloadKind: string;
  payload: unknown;                       // hydration NOT guaranteed; policies
                                          // must not depend on blob-spilled fields
  senderId: string;                       // actor.participantId ?? actor.id
  senderKind: string;                     // actor.kind
  annotations?: Record<string, unknown>;
  appendedAt: string;                     // ISO — the ONLY time source (P4)
}

/** Draft of an envelope about to be appended (annotate input). */
export interface PolicyAppendDraft {
  payloadKind: string;
  payload: unknown;
  senderId: string;
  senderKind: string;
}

export interface ChannelCallDescriptor {
  channelId: string;
  caller: ParticipantRef;
  target: ParticipantRef;
  invocationId: string;
  transportCallId: string;
  turnId?: string;
  method: string;
  args?: unknown;
  deadlineAt?: number;                    // epoch ms; journaled (§5.1)
  createdAt: string;                      // injected by host — NOT wall clock in the policy (P4)
}

export interface ChannelCallTerminalInput {
  descriptor: Pick<ChannelCallDescriptor,
    "channelId" | "caller" | "invocationId" | "transportCallId" | "turnId">;
  result: unknown;
  isError: boolean;
  terminalOutcome?: InvocationOutcome;
  terminalReasonCode?: string;
  createdAt: string;
}

/** Synthesizes the call-transport event payloads. All pure. */
export interface ChannelCallEventBuilders {
  started(input: ChannelCallDescriptor): AgenticEvent;
  terminal(input: ChannelCallTerminalInput): AgenticEvent;   // completed/failed/cancelled/abandoned mapping per §0
  output(input: { descriptor: ChannelCallTerminalInput["descriptor"];
                  output: unknown; createdAt: string }): AgenticEvent;
  cancelled(input: { descriptor: ChannelCallTerminalInput["descriptor"];
                     actorId: string; reason: string; createdAt: string }): AgenticEvent;
}

export interface ChannelPolicy<S = unknown> {
  readonly name: string;                  // registry key, e.g. "agentic.conversation.v1"
  readonly version: number;               // bump ⇒ policy_state cache invalidated
  init(): S;
  /** Pure fold over durable envelopes in seq order (P4: no clock/random/IO). */
  reduce(state: S, envelope: PolicyEnvelopeView): S;
  /** Pure pre-append pass. Returns annotations to merge onto the envelope
   *  being appended, or null. MUST NOT mutate the payload. Runs atomically
   *  with sequencing (host appends state-fold + annotate + append under the
   *  DO's single-threaded execution). */
  annotate(state: S, draft: PolicyAppendDraft): Record<string, unknown> | null;
  /** Present on policies that own the call transport's event vocabulary. */
  callEventPayload?: ChannelCallEventBuilders;
}

export const CHANNEL_POLICIES: ReadonlyMap<string, ChannelPolicy>;
export function getChannelPolicy(name: string): ChannelPolicy;  // throws on unknown
export const DEFAULT_CHANNEL_POLICIES: readonly string[];        // ["agentic.conversation.v1"]
```

Channel config gains `policies?: string[]` (in `types.ts` `ChannelConfig`);
default `DEFAULT_CHANNEL_POLICIES`. Exactly one configured policy may carry
`callEventPayload`; the host errors at init otherwise.

### 4.2 `agentic.conversation.v1` (`src/conversation-v1.ts`)

State (exact shape — this is also the `getPolicyState` wire shape):

```ts
interface ConversationStateV1 {
  lastCompletedSender: string | null;
  lastCompletedSeq: number | null;
  lastCompletedAt: string | null;          // = envelope.appendedAt, never wall clock
  previousCompletedSender: string | null;
  previousCompletedSeq: number | null;
  agentStreak: number;
}
```

- `init()` → all null / 0.
- `reduce(state, env)`: if `env.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND`
  and `(env.payload as AgenticEvent).kind === "message.completed"`: shift
  current → previous slots, set `lastCompletedSender = env.senderId`,
  `lastCompletedSeq = env.seq`, `lastCompletedAt = env.appendedAt`,
  `agentStreak = payload.actor.kind === "agent" ? state.agentStreak + 1 : 0`.
  Everything else: identity.
- `annotate(state, draft)`: if draft is an agent-authored `message.completed`
  (payload `actor.kind === "agent"`), return
  `{ agentHops: explicit ?? state.agentStreak + 1 }` where `explicit` is a
  pre-existing `payload.causality.agentHops` (caller-computed values win,
  matching today's `if (causality.agentHops === undefined)` guard — but the
  value is COPIED to annotations, never written into the payload). Else null.
- `callEventPayload`: ports the four builders verbatim from
  channel-do.ts:220–360, with two changes: (a) `createdAt` comes from the
  input, not `new Date()` (host injects it — same timestamp the append will
  carry); (b) `started` includes `transport.deadlineAt` when set (§5.1).

This policy absorbs `stampAgentHops` + `recordConversationState` + the
invocation payload builders. Its fold survives forks because it is rebuilt
from the forked log (§4.5) — the fork conversation-state wipe bug is fixed
structurally.

### 4.3 `policy-host.ts` (channel DO module)

```ts
export class PolicyHost {
  constructor(deps: {
    sql; getStateValue; setStateValue; deleteStateValue;
    log: ChannelLog;                       // for rebuild-by-replay
    policies: ChannelPolicy[];             // resolved from config at first use
  }) {}

  /** KV cache per policy: key `policy_state:{name}`, value JSON
   *  { stateJson: string, foldedThroughSeq: number, policyVersion: number }.
   *  P1 cache; derivation = fold(reduce, log[1..foldedThroughSeq]). */

  /** Load cached state; if absent or policyVersion !== policy.version,
   *  rebuild: state = init(); page readLog({afterSeq: folded, limit: 500})
   *  folding until head; persist. If present but behind head (out-of-band
   *  appends), fold only the tail. */
  getState(name: string): Promise<{ state: unknown; foldedThroughSeq: number }>;

  /** Pure annotate pass over all configured policies; merged result. */
  annotate(draft: PolicyAppendDraft): Promise<Record<string, unknown> | null>;

  /** Fold ONE just-appended envelope into every policy's cached state and
   *  persist {stateJson, foldedThroughSeq: env.seq, policyVersion}.
   *  Skips (idempotent) when env.seq <= foldedThroughSeq. */
  foldAppended(env: PolicyEnvelopeView): void;

  callBuilders(): ChannelCallEventBuilders;   // from the unique owning policy

  /** postClone: delete every `policy_state:*` key, then getState() each
   *  configured policy (forces rebuild-by-replay over the forked lineage). */
  rebuildAfterFork(): Promise<void>;
}
```

Append pipeline (every durable append in the DO goes through ONE helper):

```
appendDurable(input):
  1. state = host.getState(...)            // catches up tail if needed
  2. ann   = host.annotate(draft)          // pure
  3. event = log.append({...input, annotations: merge(input.annotations, ann)})
  4. host.foldAppended(view(event))        // advance cache
  5. return event
```

Because the DO is single-threaded per event-loop turn and `getState` catches
up any gap before `annotate`, annotation is atomic with sequencing. The
`policy_state` write is AFTER the durable append: a crash between 3 and 4
leaves `foldedThroughSeq` behind head, which step 1 heals on the next append
or read (cache amnesia by construction). `broadcastStoredEnvelopes` calls
`host.foldAppended` for each re-broadcast envelope the same way (and tolerates
gaps via the same catch-up).

### 4.4 RPC: `getPolicyState` (replaces `getConversationState`)

```ts
async getPolicyState(name?: string): Promise<{
  policy: string;            // resolved name (default "agentic.conversation.v1")
  version: number;
  foldedThroughSeq: number;
  state: unknown;            // ConversationStateV1 for the default policy
}>
```

Caller updates (P6, no shim — same cut):
- `workspace/packages/agentic-do/src/channel-client.ts:158` —
  `getConversationState()` method replaced by
  `getPolicyState(name?)` with the shape above.
- `workspace/packages/agentic-do/src/trajectory-vessel-base.ts:4691`
  (`shouldRespond`) — destructures `state` as `ConversationStateV1`; the
  previous-slot correction logic is unchanged (`lastCompletedSeq === event.id
  ⇒ use previousCompletedSender`).

### 4.5 `postClone` (new body)

```
postClone(parentChannelId, forkPointId):
  1. fix __objectKey (unchanged)
  2. setStateValue forkedFrom / forkPointId (unchanged)
  3. await log.forkFrom(parentChannelId, forkPointId)     // no-copy forkLog
  4. DELETE FROM participants; DELETE FROM pending_calls; DELETE FROM dedup_keys
  5. delete all `policy_state:*` KV keys
  6. await policyHost.rebuildAfterFork()    // replay forked lineage → conversation
                                            // state SURVIVES the fork (bug fix)
  7. reconcilePendingCalls()                // §5.4 — rebuilds rows for any call
                                            // started-without-terminal in the
                                            // inherited prefix (they will be
                                            // abandoned/redelivered by normal
                                            // roster flow as targets resubscribe)
```

---

## 5. `calls.ts` — pending_calls as a declared cache

### 5.1 Journal completeness (the started payload must fully describe the call)

The `invocation.started` payload already carries everything needed to rebuild
a pending row except the deadline. Additions:

- `InvocationTransport` channel variant
  (`workspace/packages/agentic-protocol/src/events.ts:211`) gains
  `deadlineAt?: number` (epoch ms); `invocationTransportSchema`
  (`schemas.ts:138`) gains `deadlineAt: z.number().int().positive().optional()`.
- `callEventPayload.started` writes it when `opts.timeoutMs` was given.

Row ⇄ log field mapping (`derivePendingCalls` uses exactly this):

| pending_calls column | log source (started event `e`, envelope `env`) |
|---|---|
| transport_call_id | `e.causality.transportCallId` (== `e.payload.transport.transportCallId`) |
| invocation_id | `e.causality.invocationId` |
| turn_id | `e.turnId` |
| caller_id | `env.senderId` (== `e.actor.participantId ?? e.actor.id`) |
| target_id | `e.payload.transport.target.participantId ?? .id` |
| method | `e.payload.name` |
| args | `e.payload.request` (JSON) |
| created_at | `Date.parse(env.appendedAt)` |
| deadline_at | `e.payload.transport.deadlineAt ?? null` |

### 5.2 `callMethod` — journal before dispatch (P2)

New order (old order was: storeCall row → append started → broadcast →
dispatch):

```
1. APPEND invocation.started   envelopeId = invocationId (deterministic, as today)
   — via appendDurable (policy annotate/fold included)
2. INSERT pending_calls row    (cache write)
3. scheduleNextAlarm()
4. broadcast started (log, live)
5. dispatch: DO target → waitUntil(onMethodCall …); RPC target → nothing extra;
   missing target → settleCall(transportCallId, error, …) immediately
```

Crash between 1 and 2: reconcile (§5.4) re-inserts the row. Crash between
2-and-dispatch: redelivery on target resubscribe / reconcile nudge covers it
(delivery is at-least-once over the call lifetime, as today).

### 5.3 `settleCall` — the corrected terminal ordering (THE bug fix)

Replaces `handleMethodResult` + `settleConsumedMethodCall` +
`deliverCallResult`:

```
settleCall(transportCallId, result, isError, terminalOutcome?, terminalReasonCode?, opts?):
  1. pending = peekCall(transportCallId)            // READ, do NOT delete
     if !pending: log diagnostic, return undefined  // already terminal — the
                                                    // deterministic id below makes
                                                    // double-settle a no-op anyway
  2. ensureMethodRoot(pending)                      // unchanged: append synthetic
                                                    // started if envelopeId
                                                    // invocationId is absent
  3. APPEND terminal to GAD FIRST, with deterministic
        envelopeId = "terminal:" + transportCallId
     payload from policy callEventPayload.terminal(...) — kind per the §0
     outcome mapping; attachments via opts. Idempotent: a duplicate settle
     replays in GAD (same id, same lineage) and returns the existing envelope.
  4. DELETE pending_calls row (consume — cache delete AFTER durable append)
  5. scheduleNextAlarm()
  6. broadcast terminal (log, live) — skipped if caller no longer in roster
     (the durable event is still appended; test "persists method terminal
     events even when the caller participant has left")
  return event.id (seq)
```

Crash matrix (all converge — this is the §10 crash-injection test):
- after 3, before 4: row still present, but the log has a terminal →
  `derivePendingCalls` excludes it → reconcile deletes the row. A concurrent
  duplicate settle replays the same envelopeId (no second terminal).
- after 4, before 6: terminal durable, broadcast lost → subscribers recover it
  from replay (canonical recovery path, unchanged).
- The OLD failure (row deleted, terminal never appended) is structurally
  impossible: nothing deletes the row before the append returns.

All terminal producers route through `settleCall`:
`submitMethodResult` (after target-auth), DO `onMethodCall` return,
`cancelMethodCall` / `timeoutMethodCall` (these use
`callEventPayload.cancelled` with actor `system`, then steps 3–6 with the same
`terminal:{transportCallId}` envelopeId — first terminal in wins, exactly-once
per lineage), and `failPendingCallsTargeting` (abandoned terminals; iterate
targets' rows with peek-then-settle, not bulk-delete-then-append as today —
delete `cancelCallsForTarget`'s delete-first behavior).

`submitMethodProgress` is unchanged in behavior (peek; append
`invocation.output` via policy builder; random envelopeId; no consume).

### 5.4 `derivePendingCalls` + reconcile

```ts
/** Pure fold: pending ⟺ invocation.started without a terminal in the log. */
export function derivePendingCalls(envelopes: PolicyEnvelopeView[]): PendingCallRow[] {
  // single pass, ascending seq:
  //  - started (payload.transport?.kind === "channel" && transport.transportCallId):
  //      map.set(transportCallId, rowFrom(env))   // §5.1 mapping
  //  - terminal kinds {invocation.completed, .failed, .cancelled, .abandoned}
  //      with causality.transportCallId: map.delete(transportCallId)
  //  - invocation.output: ignored
  return [...map.values()];
}
```

`reconcilePendingCalls()` (DO method in calls.ts): page the full lineage view
via `log.read({payloadKind: AGENTIC_EVENT_PAYLOAD_KIND, afterSeq, limit:500})`,
compute `derivePendingCalls`, then diff against the table: insert missing
rows, delete orphans (row without a non-terminal started). Runs:
- on `alarm()` (cheap guard: skip when a KV `calls_reconciled_through` equals
  current head seq; update it after each reconcile and each settle/append),
- in `postClone` step 7,
- NOT on every wake (the deterministic terminal id already makes the bug
  class harmless; reconcile is the convergence sweep).

`pending_calls` thereby satisfies P3: `DELETE FROM pending_calls` at any
moment + one reconcile restores identical behavior (cache-amnesia test §10).

`invocation-calls.ts` is deleted; `storeCall`/`peekCall` move into calls.ts as
private helpers; `consumeCall`/`cancelCall`/`cancelCallsForTarget` disappear
(consumption is step 4 of `settleCall`).

---

## 6. Deletion list (exhaustive)

1. **Conversation KV** — the six `conversation:*` keys, `stampAgentHops`,
   `recordConversationState`, `getConversationState` (RPC + channel-client
   method), and the `postClone` lines deleting them. Replaced by
   `agentic.conversation.v1` + `getPolicyState`.
2. **Channel-side message-type registry cache** — `message_types` table,
   `_registryHydrated`, `_registryHydrationPromise`, `ensureRegistryHydrated`,
   `cacheMessageTypeMutation`, `cacheMessageTypes`, `localMessageTypes`,
   `appendRegistryEvent`, `registryMutationFromPublishedPayload`, and the
   registry branch inside `publish`. `getMessageTypes()`/`getMessageType()`
   become one-line passthroughs to gad `listMessageTypes`/`getMessageType`
   (no replacement read path needed — GAD owns the projection and the panel
   read frequency is low).
3. **Transport schema validation** — the `storedAgenticEventSchema.safeParse`
   block in `publish` and the `adminValidateLog` per-row JSON checks shrink to
   shape checks only (GAD validates at append; `checkLogIntegrity` covers the
   chain).
4. **`delivery_cursor`** — vessel-side (`trajectory-vessel-base.ts:3450/
   5168/5175/8042/8442/8592` and the two integration-test touchpoints). Falls
   with the vessel in the Stage B cut (WS1.7); the replacement
   "last-observed seq" is folded from events by the new agent-loop driver.
   WS2 deliverable: nothing in the new channel modules may reference it, and
   `README.md` (workspace/workers/README.md:309) drops the row.
5. **`channel-log-store.ts`** (replaced by `log-store.ts`) and
   **`invocation-calls.ts`** (absorbed into `calls.ts`).
6. The channel's use of legacy gad adapters: `appendChannelEnvelope`,
   `appendChannelEnvelopeWithRegistryMutation`, `getChannelReplayWindow`,
   `getChannelEnvelope`, `forkChannelLog`, `listMessageTypes` *as append/read
   path* — log-store targets `appendLogEvent`/`readLog`/`getLogEvent`/
   `getLogHead`/`forkLog` (registry reads keep `listMessageTypes`/
   `getMessageType`, which survive as projection reads).

---

## 7. Annotations-based agentHops (client plumbing)

Write side: §4.2 `annotate` puts `agentHops` in `envelope.annotations` —
payloads are never mutated by the transport again.

Carrier: `ChannelEvent.annotations?: Record<string, unknown>` (§2), populated
by `buildChannelEvent` from the durable envelope for both `phase:"replay"` and
`phase:"live"` deliveries, and present in the `kind:"log"` RPC wire messages
(`channelEventToRpcLog` passes the event through unchanged — no encoder
change needed beyond the type).

Read side (compatible with `addressing.ts`, which is UNCHANGED — its
`AddressedMessage.agentHops` input field and `addressing.test.ts` are
untouched):

- `trajectory-vessel-base.ts:4680/4719`: replace
  `causality.agentHops` with
  `(event.annotations?.["agentHops"] as number | undefined)`. No payload
  fallback — under big-bang sequencing there is no dual-read window (plan
  WS1.5/WS2.7); the same extraction rule is the contract for WS1's new
  `TurnDispatcher`/agent-loop addressing.
- `events.ts:100` keeps `agentHops?: number` on `EventCausality` for now
  (clients may still send caller-computed hops, which `annotate` copies into
  annotations); the field becomes write-only input and is removed with the
  vessel in Stage B.

UX guard: chat reducers (`reducer-channel.ts`, `channel-chat-merge.ts`,
`useChannelMessages`) never read `agentHops` or annotations — verified:
`reducer-channel.ts` consumes only `payloadKind`, `payload`, `seq`, `from`,
`envelopeId`. Their tests must pass unchanged.

---

## 8. Smell fixes

1. **Dedup TTL sweep** — drop the `dedup_cleanup_at` KV latch (today a key
   inserted while no publish succeeds is never swept, and the latch gates the
   sweep on the happy path). New: `idx_dedup_keys_created` (§3.1);
   `alarm()` always runs `DELETE FROM dedup_keys WHERE created_at < now - 5min`;
   the next-time source is `SELECT MIN(created_at) + 5min FROM dedup_keys`.
2. **Single `scheduleNextAlarm`** over three PURE next-time sources, each
   `(sql, now) => number | null` (epoch ms): `nextDedupSweepAt`,
   `nextParticipantSweepAt` (`now + 60s` iff any `transport='rpc'` row
   exists), `nextCallDeadlineAt` (`MIN(deadline_at)`). `scheduleNextAlarm()`
   = `setAlarm(max(min(non-null sources) - now, 100))`; delete
   `scheduleDedupCleanup` and `scheduleParticipantCleanup`. `alarm()` body:
   `evictStaleParticipants(); sweepDedupKeys(); timeoutExpiredPendingCalls();
   reconcilePendingCalls-if-stale; scheduleNextAlarm()`.
3. **`do_source`/`do_class`/`do_object_key` columns** — `parseDOParticipantId`
   runs ONCE at subscribe and populates the columns (§3.1);
   `getParticipants()` builds `doRef` from columns; broadcast/dispatch decide
   `transport === 'do'` from the column as today. The parser stays exported
   for subscribe only.
4. **zod `participantMetadataSchema` at subscribe** (in `types.ts`):

   ```ts
   export const participantMetadataSchema = z.object({
     name: z.string().optional(),
     type: z.string().optional(),
     handle: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/).optional(),
     roles: z.array(z.string()).optional(),
     methods: z.array(z.object({
       name: z.string()
         .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
         .refine((n) => !["read","edit","write","grep","find","ls"].includes(n),
                 { message: "method name collides with a built-in tool name" }),
     }).passthrough()).optional(),
     contextId: z.string().optional(),
     channelConfig: z.record(z.string(), z.unknown()).optional(),
     replay: z.boolean().optional(),
     sinceId: z.number().int().nonnegative().optional(),
     replayMessageLimit: z.number().int().positive().optional(),
   }).passthrough();   // unknown keys flow through to stored metadata
   ```

   `subscribe` parses with this FIRST; a zod failure throws with the issue
   path+message. The hand-rolled method-name loop is deleted (the error
   message changes — see §9). Entries in `methods` whose `name` is missing
   continue to pass (today's "unknown shape" tolerance) because only the
   declared key is validated and `name` absent fails… NOTE: to preserve the
   tolerance, model name as `z.string()…optional()` and refine only when
   present.
5. **Partial unique index on handles** (§3.1). The pre-INSERT SELECT check is
   KEPT for its friendly error message (tests and agents depend on the text);
   the index is the race-proof enforcement. A constraint violation that slips
   past the check is caught and rethrown with the same friendly message.

---

## 9. Test plan

### 9.1 `channel-do.test.ts` — must keep passing; legitimate changes only

Mechanical updates forced by Stage 0 (the gad TABLE rename, not WS2 itself):
every assertion querying `gad.sql … FROM channel_envelopes` switches to
`log_events` with columns per Stage-0 DDL: `payload_ref_json` (same name),
`annotations_json` replaces `metadata_json`/`attachments_json` (assert
`JSON.parse(annotations_json).metadata` / `.attachments`). Affected tests:
"stores durable publishes as opaque channel envelopes", "dedupes concurrent
publishes…", "does not persist full method schemas…", "routes pause method
calls…", "uses GAD as the durable channel log backend…" (sqlite_master check
stays — channel side never had the table), "routes by transport id…",
"appends a durable invocation.completed terminal…" (attachments now under
annotations), "appends a durable invocation.cancelled…", "appends a durable
invocation.output…", "drops a method result…", "appends a durable
invocation.abandoned…", "does not block channel cancellation…", "persists
method terminal events…", "spills oversized method results…", "forks the
GAD-backed channel log during postClone". Also the test harness's direct
`gad.instance.appendChannelEnvelopeWithRegistryMutation` calls keep working
(adapter survives until Stage B).

Semantic changes (each is a deliberate behavior move, update the assertion):

| Test | Change |
|---|---|
| "rejects malformed message type registry events instead of persisting plain log rows" | Rejection now comes from GAD append-time schema validation, not the channel's `Invalid registry payload` throw. Matcher changes from `/Invalid registry payload/` to the zod-derived message (e.g. `/displayMode/`). The no-row assertion is unchanged. |
| "hydrates the message type registry from GAD instead of trusting a partial local cache" | The cache-poisoning setup (private `cacheMessageTypeMutation` call) no longer exists. Test renames to "reads message types directly from GAD"; keep the two gad-side registrations and the `getMessageTypes()` assertion verbatim, delete the poison block. |
| "settles pending method calls as an error from malformed terminal invocation events" | Still rejects (`/terminalOutcome/` matcher still valid — GAD uses the same `storedAgenticEventSchema`), pending row still present. Comment updates only. |
| "reports an envelope-only schema" / `adminInspectSchema` | Inspected table list: `message_types` gone, `participants` has three new columns + handle index. The `channel_envelopes`-absent invariant unchanged. |
| "routes pause method calls through visible method invocation transport" | `callMethod` now appends BEFORE inserting the row and before dispatch; the `rpcCalls` assertion and event assertions are order-insensitive enough to pass unchanged — verify only that the started append precedes `onMethodCall` (it now provably does). |

Everything else — seq numbering (`result.id === 2`), replay windows,
live delivery, eviction-on-fatal-delivery, provider-identity auth, abandoned/
cancelled outcome preservation, blob spill, fork replay (`[2,3]` then `[4]`) —
must pass without assertion changes.

### 9.2 New tests (same file or siblings)

1. **Terminal-ordering crash injection**: stub the gad append for
   `terminal:{id}` to (a) throw after persisting, (b) throw before — assert:
   row survives a failed append; a successful append followed by simulated
   crash-before-delete + `reconcilePendingCalls()` removes the row without a
   second terminal (`SELECT COUNT(*) FROM log_events WHERE envelope_id =
   'terminal:…'` is 1); duplicate `settleCall` is a no-op returning the same
   seq.
2. **`derivePendingCalls` cache amnesia**: start two calls, settle one,
   `DELETE FROM pending_calls`, reconcile → exactly the unsettled row is
   back with method/args/deadline intact; then settle it normally.
3. **Policy fold replay ≡ incremental** (channel-policies package test, pure):
   fold a scripted envelope sequence in one pass vs. via repeated
   `foldAppended`; states identical. Property: `reduce` is
   timestamp-deterministic (no wall clock).
4. **Fork-then-publish conversation state regression**: parent accumulates
   agentStreak 2; fork; child `getPolicyState()` shows streak 2 (rebuilt by
   replay, NOT zero); an agent publish on the child gets
   `annotations.agentHops === 3`.
5. **Annotations stamping**: agent `message.completed` publish → durable
   `annotations_json` contains `agentHops`; payload `causality` does NOT gain
   it; live `ChannelEvent.annotations.agentHops` delivered; explicit
   caller-provided `causality.agentHops` wins.
6. **Idempotent publish across restart**: publish with idempotencyKey, wipe
   `dedup_keys`, publish again with same key → same seq, one `log_events` row
   (envelopeId `ik:{key}` lineage dedupe).
7. **Dedup TTL sweep** without any successful publish; **handle unique index**
   race (two inserts, second throws friendly message); **single alarm**
   next-time sources unit tests (pure).
8. **getPolicyState shape** + vessel previous-slot correction still holds via
   `agent-worker-base.integration.test.ts` (update its `getConversationState`
   touchpoints to `getPolicyState`).

### 9.3 Unchanged suites (UX guards)

`addressing.test.ts` (zero diffs), `reducer-channel`/`channel-chat-merge`/
`useChannelMessages`/`transcriptPipeline` tests (payload shapes for
`agentic.trajectory.v1/event` are byte-identical), gadStore.test.ts (Stage-0
owned; WS2 adds only the `projectMessageTypeEvent` coverage there: registry
upsert/clear ordering via plain `appendLogEvent` of `messageType.*`
publications).

---

## 10. Build order — 4 independently implementable chunks

**Chunk 1 — `@workspace/channel-policies` (no infra dependencies).**
New package: interface, registry, `agentic.conversation.v1` (state, reduce,
annotate, all four `callEventPayload` builders ported from
channel-do.ts:220–360), pure tests (§9.2 #3, builder goldens against the
current payload shapes asserted in channel-do.test.ts). Plus the small
protocol delta: `InvocationTransport.deadlineAt` + schema. Deliverable
compiles and tests green standalone.

**Chunk 2 — `log-store.ts` + GAD registry projection (needs Stage 0 landed).**
Rewrite the store onto `appendLogEvent`/`readLog`/`getLogEvent`/`getLogHead`/
`forkLog`; replay-window math from `getLogHead`; `ChannelEvent.annotations`
plumb (harness type + `buildChannelEvent`); `projectMessageTypeEvent` in
gad-store + its gadStore.test.ts cases; deterministic `ik:{key}` envelopeIds.
No channel-DO behavior change yet beyond the store swap (old DO code can sit
on the new store's compatibility methods during this chunk's PR).

**Chunk 3 — DO split + de-agentification (the big cut; needs 1 + 2).**
`roster.ts`, `calls.ts`, `policy-host.ts`; `appendDurable` pipeline;
`settleCall` ordering fix + `derivePendingCalls` + reconcile; `getPolicyState`;
delete conversation KV, registry cache, transport validation,
`invocation-calls.ts`, `channel-log-store.ts`; new DDL + schemaVersion 105;
all smell fixes (§8); `postClone` rebuild-by-replay; channel-do.test.ts
updates per §9.1 + new tests §9.2 #1–#7.

**Chunk 4 — client plumbing (needs 3; touches other packages).**
`channel-client.ts` `getPolicyState`; vessel read-site updates
(trajectory-vessel-base.ts:4680/4691/4719) to annotations + policy state;
`agent-worker-base.integration.test.ts` touchpoints; README delivery_cursor
row removal; grep-clean: no reference to `getConversationState`,
`conversation:`, `ensureRegistryHydrated`, `stampAgentHops` anywhere outside
this spec.

Chunks 1 and 2 are parallel. Chunk 3 is the gate for the channel joining the
system-wide cache-amnesia suite (P3): its CI job deletes `pending_calls`,
`policy_state:*`, and `dedup_keys` at randomized points during the §9.2
scenarios and asserts identical observable behavior.

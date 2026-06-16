# WS1 Implementation Spec — Event-Sourced Harness (`agent-loop`)

Status: binding implementation spec for workstream WS1 of
`~/.claude/plans/ok-grat-create-a-unified-shore.md`. Companion to the Stage-0
foundation contract `docs/stage0-unified-log-spec.md` (the gad-store API this
harness builds on). Implementation agents must be able to build from this
document **without reading `trajectory-vessel-base.ts`**. Names and signatures
here are exact; do not improvise different ones.

Normative principles (from the plan): P1 log/value/ref/cache taxonomy, P2
journal-before-dispatch, P3 cache amnesia, P4 pure folds, P5 `log_kind` is
metadata, P6 no coexistence machinery.

---

## 0. Foundation surfaces this work builds on (and nothing else)

From Stage 0 (`docs/stage0-unified-log-spec.md`):

- `appendLogEvent({logId, head, logKind, expectedHeadHash?, events[]})` —
  per-batch atomicity, lineage-scoped idempotent replay by deterministic
  `envelopeId`, head-hash CAS, same-txn channel publication via
  `events[].publish.channels`.
- `forkLog({fromLogId, fromHead, toLogId, toHead, atSeq?})` — no-copy fork.
- `readLog({logId, head, afterSeq?, beforeSeq?, limit?, payloadKind?})` —
  lineage-aware ascending reads.
- `getLogHead`, `getLogEvent`, `checkLogIntegrity`, `resolveRef`/`updateRef`
  (CAS) / `listRefs`.
- `LogEnvelope` from `agentic-protocol/src/log-envelope.ts`; agentic
  `EventKind` vocabulary from `agentic-protocol/src/events.ts` (open until the
  agent-loop scenario suite is green — new kinds introduced here are listed in
  §1.9).

**Log identity for an agent's per-channel trajectory** (preserves today's
convention from `gadBranchIdForChannel`, trajectory-vessel-base.ts:199):

```
logId = `branch:channel:${channelId}`   head = `branch:channel:${channelId}`
logKind = "trajectory"
```

(Today trajectoryId == branchId == `branch:channel:{channelId}`; keep both
coordinates equal so existing GAD projections and panel reads stay stable. A
fork to a new channel gets `toLogId = toHead = branch:channel:{newChannelId}`.)

Never call `appendTrajectoryBatch`, `forkTrajectoryBranch`, or any adapter
listed in Stage-0 §2.7 — those die in Stage B.

---

## 1. The pure package: `workspace/packages/agent-loop/`

Zero DO imports, zero I/O, vitest-testable on Node. Layout:

```
workspace/packages/agent-loop/
  src/
    state.ts        // AgentState + types
    fold.ts         // applyEvent(state, envelope) -> state   (pure)
    step.ts         // step(state, incoming, ctx) -> StepOutput (pure)
    effects.ts      // EffectDescriptor union + derivePendingEffects + outcomeEvents
    ids.ts          // deterministic id scheme (all id builders live here)
    commands.ts     // Command union + validation
    context.ts      // buildModelContext(state) -> pi-core message array (pure)
    policies/
      approval-gate.ts
      channel-tools.ts
      ask-user.ts
      fork.ts
      silent.ts
      compaction.ts
    scenario.ts     // scenario-script test harness (see §4)
  src/*.test.ts
```

Dependencies: `@workspace/agentic-protocol`, `@workspace/pi-core` (vendored
types/compaction/session-tree only — no pi-ai at the pure layer).

### 1.1 `AgentState`

Derived by fold, never stored authoritatively (`fold_cache` is a P1 cache,
§2.3). All fields are JSON-serializable; large payloads remain as
`natstack.blob-ref.v1` `StoredValueRef`s inside entries (hydration happens in
executors, never in the fold).

```ts
export interface AgentState {
  logId: string;
  head: string;
  channelId: string;
  lastSeq: number;          // seq of last folded envelope
  lastHash: string;         // hash of last folded envelope (== expectedHeadHash for next append)

  config: AgentLoopConfig;  // see below
  entries: SessionEntry[];  // pi-core session path (replaces materializeSessionTree output)

  openTurn: OpenTurn | null;
  inFlightModelCall: InFlightModelCall | null;   // message.started w/o terminal
  pendingInvocations: Record<string /*invocationId*/, PendingInvocation>;
  pendingApprovals: Record<string /*approvalId*/, PendingApproval>;
  pendingCredentialWaits: Record<string /*credKey*/, PendingCredentialWait>;
  steeringQueue: SteeringEntry[];   // user message.completed appended during an open turn,
                                    // with seq > inFlightModelCall.contextThroughSeq
  pendingPrompt: PendingPrompt | null; // user input awaiting a turn (no open turn yet)
}

export interface AgentLoopConfig {
  model: string;                  // e.g. "openai-codex:gpt-5.5"
  thinkingLevel: "minimal"|"low"|"medium"|"high";
  approvalLevel: 0 | 1 | 2;       // 0=ask-all, 1=safe-tools auto, 2=full-auto (today's semantics)
  respondPolicy: RespondPolicy;
  systemPromptHash: string;       // blob digest of composed system prompt
  skillIndexHash?: string;
  toolSchemasHash?: string;       // digest of active tool JSON schemas
  activeToolNames: string[];
  roster: RosterSnapshot;         // channel participants + their methods (from system.event roster snapshots, §1.5)
  agentHopLimit?: number;
}

export interface OpenTurn {
  turnId: string;
  openedAtSeq: number;
  reason?: string;
  modelCallCount: number;         // count of message.started in this turn (drives messageId derivation)
}

export interface InFlightModelCall {
  messageId: string;
  attemptId: string;
  contextThroughSeq: number;      // log seq the prompt snapshot covered
  request: ModelRequestDescriptor; // verbatim from message.started payload.request (§1.4.1)
}

export interface PendingInvocation {
  invocationId: string;
  turnId: string;
  startedAtSeq: number;
  attemptId: string;              // originating model attempt (causality.attemptId)
  name: string;
  transport: InvocationTransport; // local | channel | http  (events.ts:210)
  request: unknown;               // args (possibly StoredValueRef)
  requiresApproval: boolean;
  approvalId?: string;            // set when gated; dispatchable iff approval resolved granted
  approvalState: "none" | "pending" | "granted";
}

export interface PendingApproval {
  approvalId: string;
  invocationId: string;
  turnId: string;
  question: string;
  details: { toolName: string; input: unknown };
  formCallDispatched: boolean;    // derived: form channel_call is pending iff no approval.resolved
}

export interface PendingCredentialWait {
  credKey: string;                // `cred:{channelId}:{providerId}` — same natural key as old suspension-store
  providerId: string;
  turnId: string;
  startedAtSeq: number;
  connectSpec: Record<string, unknown>; // toAgentCredentialSetup() output, snapshotted into the event
  modelBaseUrl?: string;
  expiresAt: string;              // ISO; from the logged event, not wall clock
}
```

`SessionEntry` is the vendored pi-core session-tree entry type (linear path
only — the fold maintains the materialized path directly; the tree/branching
generality of `materializeSessionTree` collapses because forks are now log
forks).

### 1.2 The fold: `applyEvent(state, envelope) → state`

One pure reducer, exact event-kind → state-transition table. "self" means
`envelope.actor` is this agent's participant ref. Events not listed are
appended for projection/UX only and fold to `state` unchanged (plus
`lastSeq/lastHash` advance, which EVERY event does).

| # | payloadKind (EventKind) | Guard / precondition | State delta |
|---|---|---|---|
| 1 | `turn.opened` | `openTurn == null` (duplicate-guard upheld by gad-store) | `openTurn = {turnId: causality.turnId, openedAtSeq: seq, reason: payload.reason, modelCallCount: 0}`; `pendingPrompt = null` (its content is now in entries) |
| 2 | `turn.closed` | `openTurn?.turnId == turnId` | `openTurn = null`; `inFlightModelCall = null`; `steeringQueue` retained (becomes `pendingPrompt` material for the next step, see C-followup in §1.3) |
| 3 | `message.completed`, role `user` (actor ≠ self) | — | append user entry to `entries`. If `openTurn && inFlightModelCall` → push `steeringQueue`. If `openTurn && !inFlightModelCall` → push `steeringQueue` (consumed by next model call). If `!openTurn` → `pendingPrompt = {…}` |
| 4 | `message.started`, role `assistant` (self) | `openTurn != null`, `inFlightModelCall == null` | `inFlightModelCall = {messageId, attemptId: payload.request.attemptId, contextThroughSeq: payload.request.contextThroughSeq, request: payload.request}`; `openTurn.modelCallCount += 1`; drain `steeringQueue` entries with seq ≤ contextThroughSeq |
| 5 | `message.completed`, role `assistant` (self) | `inFlightModelCall?.messageId == causality.messageId` | `inFlightModelCall = null`; append assistant entry (payload.blocks authoritative) to `entries` |
| 6 | `message.failed` | same messageId | `inFlightModelCall = null` (recoverability is in payload; re-emission is step's job, never the fold's) |
| 7 | `invocation.started` | — | `pendingInvocations[invocationId] = {…from payload: name, transport, request, requiresApproval, attemptId: causality.attemptId}` |
| 8 | `invocation.completed` | invocation pending | delete from `pendingInvocations`; append tool-result entry (payload.result) to `entries` |
| 9 | `invocation.failed` / `invocation.cancelled` | invocation pending | delete; append error tool-result entry (`isError: true`, payload.reason/error) |
| 10 | `invocation.abandoned` | invocation pending | delete; append synthetic tool-result entry "abandoned: {payload.reason}" (so the model context stays well-formed) |
| 11 | `approval.requested` | — | `pendingApprovals[approvalId] = {…}`; mark `pendingInvocations[invocationId].approvalState = "pending"`, `.approvalId = approvalId` |
| 12 | `approval.resolved` | approval pending | delete from `pendingApprovals`; if `payload.granted` → invocation `approvalState = "granted"` (now dispatchable); if denied → invocation stays pending until step appends its `invocation.failed` (D-deny in §1.3) |
| 13 | `turn.waiting` | open turn | no structural change (informational; kept for UX parity on credential waits) |
| 14 | `system.event` `details.kind == "credential.wait_started"` | — | `pendingCredentialWaits[credKey] = {…from details}` |
| 15 | `system.event` `details.kind == "credential.wait_resolved"` (or `_expired`) | wait pending | delete from `pendingCredentialWaits` |
| 16 | `system.event` `details.kind == "roster.snapshot"` | — | `config.roster = details.roster` |
| 17 | `system.event` `details.kind == "interrupt"` | — | no fold change (step reacts; terminals follow as separate events) |
| 18 | `system.compaction_recorded` | — | replace `entries` with `payload.replacement` entries (pi-core compaction output, same semantics as today's exact-session-entry path in materialize-session-tree.ts) |
| 19 | `system.event` `details.kind == "config.changed"` | — | apply `details.patch` to `config` (model / thinkingLevel / approvalLevel / respondPolicy changes are events, P4) |
| 20 | `message.delta` | — | **never folded — deltas are not in the log** (§2.4.1). The fold throwing on `message.delta` is correct behavior. |

Derived predicates (no stored FSM — the old 8-state `agent_turn_runs` machine
maps onto these):

| old `agent_turn_runs.status` | derived as |
|---|---|
| `starting` | `openTurn && modelCallCount == 0 && !inFlightModelCall` |
| `running_model` | `inFlightModelCall != null` |
| `waiting_external` | `openTurn && (pendingInvocations w/ non-local transport ∨ pendingApprovals ∨ pendingCredentialWaits) && !inFlightModelCall` |
| `continuing` | `openTurn && !inFlightModelCall && all invocations terminal && (steeringQueue ∨ fresh tool results since last model call)` |
| `closing`/`closed` | `turn.closed` appended / `openTurn == null` |
| `failed` | `turn.closed {reason: "work_failed"|…}` |
| `interrupted` | `turn.closed {reason: "user_interrupted"}` |

The old 11-state delivery machine (`agent_method_suspensions.delivery_status`)
collapses to: pending ⟺ `invocation.started` (transport `channel`) without a
terminal. `superseded`/`transcript_admitted`/`recovering`/etc. have no
analogue — deterministic terminal ids (`inv:{id}:terminal`) make duplicate
results a replay no-op, and there is exactly one suspension identity per
invocation.

### 1.3 `step(state, incoming, ctx) → StepOutput`

```ts
export type Incoming =
  | { type: "command"; command: Command }
  | { type: "event-appended"; envelope: LogEnvelope }   // fed by driver after every fold advance
  | { type: "effect-failed"; effectId: string; kind: EffectKind; error: SerializedError; attempts: number };

export type Command =
  | { kind: "prompt"; channelId: string; source: { envelopeId: string };   // triggering channel envelope
      content: UserContent; senderRef: ParticipantRef; agentHops?: number }
  | { kind: "steer";  /* same fields as prompt */ }
  | { kind: "interrupt" }                                // user pause — suppress auto-continue
  | { kind: "abort"; reason?: TurnReasonCode }
  | { kind: "setConfig"; patch: Partial<AgentLoopConfig> } // setModel/setThinkingLevel/setApprovalLevel/setRespondPolicy
  | { kind: "compact" }
  | { kind: "wake" };                                    // driver-synthesized on every DO wake / after reconcile

export interface StepContext {                            // injected determinism (P4)
  now: string;            // ISO timestamp chosen by driver, logged via appendedAt
  random: () => string;   // seeded/recorded; only used where ids.ts cannot derive deterministically (turnId salt)
  selfRef: ParticipantRef;
}

export interface StepOutput {
  append: AppendItem[];     // ordered; driver appends with expectedHeadHash = state.lastHash
  effects: EffectDescriptor[]; // NEW intentions only — must each be re-derivable from an item in `append`
}

export interface AppendItem {
  envelopeId: string;       // deterministic, from ids.ts — REQUIRED, never random
  payloadKind: EventKind;
  payload: unknown;
  causality?: LogEventCausality;
  publish?: boolean;        // → publish.channels = [{channelId}] on the durable append
}
```

**Purity contract:** `step` reads nothing but its arguments; wall clock and
randomness arrive only via `ctx` (driver records `ctx.now` into `appendedAt`,
so refolds see the same values). `effects` MUST be a subset of
`derivePendingEffects(fold(state ⊕ append))` — enforced by a property test
(§4.2). The driver is free to discard `effects` and run the reconcile instead;
they are a latency optimization only.

Core transitions (before policy interception, §1.6):

- **C-prompt** (`prompt`, no open turn): append
  `recv` user `message.completed` (id `recv:{channelId}:{source.envelopeId}`,
  causality `{agentHops}` from envelope annotations) + `turn.opened`
  (`turnId = ids.turnId(channelId, source.envelopeId)`) + `message.started`
  with a full request descriptor (§1.4.1). Effects: `[model_call]`.
- **C-prompt** (open turn): degrade to steer (same as today's
  TurnDispatcher.submit steering fallback).
- **C-steer**: append the user `message.completed` only (the event IS the
  durability — `agent_pending_steering` dies). If `!inFlightModelCall` and all
  invocations terminal → also append next `message.started` (+`model_call`).
  If a model call is in flight: nothing else — the steer is consumed by the
  next `message.started`'s context snapshot.
- **C-interrupt**: append `system.event {interrupt}`; for the in-flight model
  call append `message.failed {reason:"aborted"}` is NOT done here — instead
  the driver cancels the model executor, whose outcome produces
  `message.completed {outcome:"interrupted"}` with whatever partials exist;
  step then (E-after-interrupt) appends `invocation.cancelled` for every
  pending invocation (terminal id), `approval.resolved {granted:false,
  reason:"interrupted"}` for pending approvals, and `turn.closed
  {reason:"user_interrupted"}`. An interrupt flag is not stored in state: the
  `system.event {interrupt}` between turn open and close is the gate; step
  must not emit new `model_call`s for that turn afterwards (replaces
  RunController.gateInterrupt / mayResume).
- **C-abort**: like interrupt with the given reason code.
- **C-setConfig**: append `system.event {config.changed, patch}`; no effects.
  (Standard agent methods setModel/setThinkingLevel/etc. become this command.)
- **C-compact**: pure pi-core compaction over `state.entries`; append
  `system.compaction_recorded {replacement}`. (Model-summarized compaction is
  a later extension: a `model_call` effect with `purpose:"compaction"`.)
- **E-model-terminal** (`event-appended` of own assistant
  `message.completed`): for each tool-call block in the completed message,
  append `invocation.started` (id `inv:{invocationId}:start`,
  `invocationId = modelToolCallId` as today, causality
  `{messageId, invocationId, modelToolCallId, attemptId}`) with the
  transport chosen by policy modules; emit the matching effects. If the
  message has no tool calls → append `turn.closed {reason: outcome map}`;
  if `steeringQueue` non-empty → next `message.started` instead of close.
- **E-invocation-terminal**: when the LAST pending invocation of the turn
  reaches terminal and no interrupt gate: append next `message.started`
  (fresh `messageId = ids.messageId(turnId, modelCallCount)`, fresh
  attemptId) + `model_call`.
- **E-approval-resolved granted**: emit the gated invocation's dispatch
  effect (the `invocation.started` already exists; nothing new is appended —
  dispatchability is derived).
- **D-deny** (`approval.resolved {granted:false}`): append
  `invocation.failed {reason:"approval denied", terminalOutcome:"tool_error"}`.
- **C-wake**: recovery rule, the heart of crash convergence:
  1. orphan `message.started` (in-flight but driver knows no executor is
     running — wake implies none): append `message.failed {reason:"interrupted
     by restart", recoverable:true}` (id `msg:{messageId}:terminal`).
  2. **Guard (plan WS1.4):** never emit a new `model_call` while any
     invocation whose `attemptId` belongs to a failed attempt is non-terminal.
     Pending invocations from the failed attempt keep their effects (they were
     journaled; they re-dispatch idempotently).
  3. open turn + (pending input ∨ fresh tool results) + no in-flight call +
     guard satisfied → append next `message.started` + `model_call`.
  4. no open turn + `pendingPrompt` → C-prompt path.
- **F-effect-failed** (`effect-failed`, attempts exhausted): map by kind —
  `model_call` → `message.failed {recoverable:false}` + `turn.closed
  {reason:"work_failed"}` + a published diagnostic `message.completed`
  (replaces `agent_turn_outbox` `emit_diagnostic`); `local_tool`/`channel_call`
  /`http_call` → `invocation.failed {terminalOutcome:"infrastructure_error"}`;
  `credential_wait` expiry → `system.event {credential.wait_expired}` +
  `turn.closed {reason:"work_failed"}` with diagnostic.

### 1.4 Effect taxonomy and descriptor payload requirements

```ts
export type EffectKind = "model_call" | "local_tool" | "channel_call"
                       | "http_call" | "credential_wait" | "publish_envelope";

export interface EffectDescriptorBase {
  effectId: string;        // deterministic (§1.5); == outbox PK
  kind: EffectKind;
  channelId: string;
  idempotencyKey: string;  // == invocationId for invocation effects; messageId+attemptId for model calls
}
```

Reconstructibility invariant (P1/P2, normative): every descriptor is a pure
function of the logged intention event. The payloads below are therefore
REQUIRED fields of the corresponding events — `descriptor_json` in the outbox
is a denormalized copy only.

#### 1.4.1 `model_call` ⇐ `message.started`

`message.started` payload gains a required `request: ModelRequestDescriptor`
(new field; vocabulary is open until scenario suite green):

```ts
export interface ModelRequestDescriptor {
  provider: string; model: string;            // resolved, e.g. "anthropic", "claude-sonnet-4-6"
  modelBaseUrl?: string;
  thinkingLevel: ThinkingLevel;
  systemPromptHash: string;                   // blob-spilled composed prompt (composeSystemPrompt output)
  skillIndexHash?: string;
  toolSchemasHash: string;                    // blob-spilled JSON of active AgentTool schemas
  activeToolNames: string[];
  contextThroughSeq: number;                  // entries snapshot boundary; executor rebuilds context = buildModelContext(fold-through-seq)
  attemptId: string;                          // `att:{messageId}`
  streamOptions?: { deltaBatchMs?: number };
}
```

Effect: `{effectId: "model:"+messageId, idempotencyKey: attemptId}`. The
executor re-derives the full prompt purely from the log (entries through
`contextThroughSeq`) + blobstore (hashes) — nothing closure-bound.

#### 1.4.2 `local_tool` ⇐ `invocation.started` with `transport.kind == "local"`

`invocation.started` payload (events.ts:252) must contain: `name`,
`request` (parsed args; blob-spilled when large), `transport: {kind:"local",
awaiterId: invocationId}`, `requiresApproval`, `userVisible`. Effect
`{effectId: "inv:"+invocationId, idempotencyKey: invocationId, tool: name,
args: request, cwd from config}`. Local tools: read/edit/write/grep/find/ls/
set_title/close_turn_without_response + subclass extras.

**Retry rule replacing `HARNESS_MODEL_REPLAY_TOOL_SAFETY`:** the model is
never re-asked (replay is a pure fold), so the safety map dies. Local-tool
re-dispatch after a crash is at-least-once; mutating tools (edit/write) keep
the existing `state.file_mutation_intended/applied` journaling: the executor,
before running, checks the fold for a `state.file_mutation_applied` with
`causality.invocationId == invocationId` and, if present, synthesizes the
success result instead of re-executing.

#### 1.4.3 `channel_call` ⇐ `invocation.started` with `transport.kind == "channel"`

Covers: roster method tools, ask_user, approval forms, card method calls.
Payload must contain `transport: {kind:"channel", channelId, target:
ParticipantRef, transportCallId}` where `transportCallId =
ids.transportCallId(invocationId)` (deterministic — replaces the old random
`transport_call_id` PK), plus `name` (the method), `request` (args),
`timeoutMs?`. Effect `{effectId: "inv:"+invocationId, idempotencyKey:
transportCallId, target, method: name, args: request, turnId}`. The channel
DO dedupes by transportCallId (WS2 §5b pending_calls-as-cache), so re-dispatch
is a no-op server-side.

Approval forms and ask_user are this kind with synthetic invocations (their
`invocation.started` carries `invocationType:"user"`, `userVisible` as today's
uiPrompt/askUser suspensions; method = `confirm|select|input|ask`).

#### 1.4.4 `http_call` ⇐ `invocation.started` with `transport.kind == "http"`

Subsumes the deferred-RPC layer (`deferred_requests` dies). Payload transport:
`{kind:"http", targetUrl OR target:{service,method}, idempotencyKey}` plus
`request`. Effect carries a **callback address** `{source, className,
objectKey, method:"deliverEffectOutcome"}`; the server (or harnessApi
credentials service) must accept `idempotencyKey` and deliver results by
`postToDO` to that address (replacing `rpc.callDeferred` + `onDeferredResult`).
Re-issue on wake with the same idempotencyKey is the redrive.

#### 1.4.5 `credential_wait` ⇐ `system.event {credential.wait_started}`

Event `details` must contain the full descriptor: `{credKey:
"cred:{channelId}:{providerId}", providerId, modelBaseUrl?, connectSpec
(= providerConnect.toAgentCredentialSetup(providerId) snapshot), expiresAt
(ISO, = ctx.now + 10min, today's CREDENTIAL_SUSPENSION_TIMEOUT_MS),
turnId}`. Triggered when the model executor surfaces
`TurnSuspensionSignal {reason:"credential"}` (today raised from
`getApiKeyAndHeaders`, pi-runner.ts:1336) — the executor reports it as a
structured outcome, step appends `wait_started` + `turn.waiting
{reason:"model_credential_required"}` (UX parity). Effect = (a) publish the
credential-connect card to the channel (the same card the vessel emits today)
and (b) an `http_call` to the credentials service registering interest with
`idempotencyKey = credKey`. Resolution arrives as an effect outcome →
`system.event {credential.wait_resolved}`; expiry via outbox
`next_attempt_at` → `effect-failed` → F-rule. No `suspensions` table, no
`claimResume` CAS — the `wait_resolved` event's deterministic id
(`sys:{credKey}:resolved`) makes double-resume a replay no-op.

#### 1.4.6 `publish_envelope` — best-effort only

Transient notifications whose loss never changes agent behavior: typing
indicators (`setTypingState`), stream-delta signals (§2.4.1), metadata
updates. NOT journaled, NOT in the outbox derivation (rows for this kind are
allowed to be fire-and-forget and are exempt from the ≡ invariant). Anything
durable goes through `publish: true` on an AppendItem instead.

### 1.5 Deterministic event-id scheme (`ids.ts`)

All envelopeIds are deterministic; `crypto.randomUUID()` is banned in
agent-loop. Scoped to log lineage (Stage-0 fork-aware idempotency makes
post-fork divergence on the same id legal).

```
turnId            = `t:${channelId}:${triggerEnvelopeId}`        // salt via ctx.random only if envelope-less (alarm-initiated turns)
messageId         = `m:${turnId}:${modelCallCount}`              // 0-based per turn
attemptId         = `att:${messageId}`
invocationId      = modelToolCallId                              // as today (pi tool-call id)
transportCallId   = `tc:${invocationId}`
approvalId        = `approval:${invocationId}`                   // today's scheme, pi-runner.ts:1684
credKey           = `cred:${channelId}:${providerId}`

envelopeIds:
  recv user message     recv:{channelId}:{channelEnvelopeId}
  turn open / close     turn:{turnId}:opened   /  turn:{turnId}:closed
  turn waiting          turn:{turnId}:waiting:{n}        // n = count of prior waiting events in turn
  message started       msg:{messageId}:started
  message terminal      msg:{messageId}:terminal         // completed OR failed — exactly one wins
  invocation start      inv:{invocationId}:start
  invocation terminal   inv:{invocationId}:terminal      // completed|failed|cancelled|abandoned — one wins per lineage
  invocation output     inv:{invocationId}:output:{n}
  approval requested    appr:{approvalId}:requested
  approval resolved     appr:{approvalId}:resolved
  system events         sys:{turnId|credKey|channelId}:{detailKind}[:{n}]
  compaction            sys:compaction:{turnId}:{n}
  config change         sys:config:{hash-of-patch}:{n}
  card emissions        custom:{messageId}:{seq}                 // CardManager scheme, unchanged
```

Sharing one terminal id per message/invocation is what makes "exactly one
terminal" structural: a second, different terminal for the same id throws
`log envelope id collision with different content` (Stage-0 §2.3 step 2) —
except across a fork, where divergence is the point (fork policy appends
`abandoned` under the child head).

### 1.6 Policy modules — pure step interceptors

```ts
export interface StepPolicy {
  name: string;
  // runs after core step; may rewrite/extend output. MUST stay pure.
  intercept(args: {
    state: AgentState; incoming: Incoming; ctx: StepContext;
    output: StepOutput;            // accumulated so far
  }): StepOutput;
}
export function composeStep(policies: StepPolicy[]): StepFn;
```

Fixed order: `channel-tools` → `approval-gate` → `ask-user` → `fork` →
(consumer extras, e.g. `silent`, gmail card policy) → `compaction`.

- **`channel-tools`** (replaces createChannelToolsExtension): when
  E-model-terminal proposes an `invocation.started` whose `name` matches a
  `config.roster` participant method (and is not a builtin), set
  `transport = {kind:"channel", channelId, target: rosterEntry.ref,
  transportCallId}`. Roster is in state (event 16) — no I/O.
- **`approval-gate`** (replaces createApprovalGateExtension): pure rule per
  today's `toolNeedsApproval` (pi-runner.ts:1670): approvalLevel 2 → never;
  level 1 + name ∈ DEFAULT_SAFE_TOOL_NAMES → no; else gate. Gating rewrites
  the output: keep `invocation.started {requiresApproval:true}`, add
  `approval.requested` (payload `{question:"Allow tool call?", requestedBy:
  selfRef, details:{toolName, input}}`, causality `{approvalId, invocationId,
  modelToolCallId}` — exact shapes from pi-runner.ts:1677–1701) and a
  `channel_call` form effect; REMOVE the tool's dispatch effect (it becomes
  derivable only once `approval.resolved {granted:true}` lands).
- **`ask-user`**: declares the `ask_user` tool schema; rewrites its
  invocations to `channel_call` (method `ask`) targeting the prompting user.
- **`fork`**: on `wake`, if state contains an open turn or pending
  invocations/approvals/waits whose `startedAtSeq ≤ forkSeq` of this head
  (driver passes fork boundary in state via fold of `getLogHead` — see §2.6):
  append `invocation.abandoned {reason:"forked"}` (terminal ids),
  `approval.resolved {granted:false, reason:"forked"}`,
  `system.event {credential.wait_resolved, reason:"forked"}`, and
  `turn.closed {reason:"forked"}`.
- **`silent`** (silent-agent-worker): sets `publish:false` on every
  message/invocation/approval AppendItem except `turn.opened`/`turn.closed`
  (today's publicationPolicy), and injects the `say` tool as a `channel_call`
  publishing a user-visible message.
- **`compaction`**: after E-model-terminal, if pi-core
  `compactionTrigger.shouldCompact(entries, model)` → emit C-compact behavior.

### 1.7 `derivePendingEffects(state) → EffectDescriptor[]` (in `effects.ts`, pure)

```ts
export function derivePendingEffects(state: AgentState): EffectDescriptor[] {
  const out: EffectDescriptor[] = [];
  if (state.inFlightModelCall) out.push(modelCallEffect(state, state.inFlightModelCall));
  for (const inv of values(state.pendingInvocations)) {
    if (inv.requiresApproval && inv.approvalState !== "granted") continue; // gated
    out.push(invocationEffect(state, inv));   // by transport.kind → local_tool|channel_call|http_call
  }
  for (const ap of values(state.pendingApprovals)) out.push(approvalFormEffect(state, ap));
  for (const cw of values(state.pendingCredentialWaits)) out.push(credentialWaitEffect(state, cw));
  return out;       // NOTE: no publish_envelope here — best-effort kind is exempt
}
```

### 1.8 `outcomeEvents(descriptor, outcome) → AppendItem[]` (pure, per kind)

Executors return raw outcomes; this pure function maps them to terminal
events so the append is deterministic and testable:

- `model_call` → `message.completed {role:"assistant", blocks, outcome,
  usage}` (outcome classification per today's rules: aborted→`interrupted`,
  no content→`empty`, only tool calls→`tool_calls_only`, else `completed`),
  id `msg:{messageId}:terminal`. Suspension outcome (credential) → no
  terminal; instead the §1.4.5 events.
- `local_tool` / `channel_call` / `http_call` → `invocation.completed
  {result, summary, terminalOutcome:"success"}` or `invocation.failed
  {reason, error, terminalOutcome:"tool_error"}`, id `inv:{id}:terminal`.
  Approval-form `channel_call` outcome → `approval.resolved {granted,
  resolvedBy, reason}`, id `appr:{approvalId}:resolved`.
- `credential_wait` → `system.event {credential.wait_resolved}`.

The driver appends `outcomeEvents(...)`, deletes the outbox row (in that
order — P2), then feeds the new envelopes to `step` as `event-appended`.

### 1.9 New/changed EventKind vocabulary introduced by WS1

(Frozen only when the scenario suite is green.)

- `message.started`: payload gains required `request: ModelRequestDescriptor`
  for assistant messages (§1.4.1).
- `invocation.started`: `transport` becomes REQUIRED (it is optional today);
  `transport.kind:"channel"` requires `transportCallId`.
- `causality` gains `attemptId?: string` (invocations record their
  originating model attempt — the duplicate-dispatch guard needs it).
- `system.event` detail kinds: `interrupt`, `roster.snapshot`,
  `config.changed`, `credential.wait_started`, `credential.wait_resolved`,
  `credential.wait_expired`.
- `turn.closed` reason codes gain `"forked"`.
- `message.delta` is demoted to signal-only transport (never appended to any
  log; schema unchanged).

---

## 2. The driver: `workspace/packages/agentic-do/src/agent-loop-driver.ts` (+ siblings)

The driver is the only impure layer: it owns the outbox, the fold cache, the
executors, the alarm, and the gad-store HTTP client. One driver per DO; one
**LoopInstance** per subscribed channel (shared outbox + one alarm).

### 2.1 `effect_outbox` DDL (`effect-outbox.ts`)

```sql
CREATE TABLE IF NOT EXISTS effect_outbox (
  effect_id        TEXT PRIMARY KEY,      -- deterministic (§1.5); equality with derivation is the invariant
  branch_id        TEXT NOT NULL,         -- logId of the owning trajectory log
  channel_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,         -- model_call|local_tool|channel_call|http_call|credential_wait|publish_envelope
  idempotency_key  TEXT NOT NULL,
  descriptor_json  TEXT NOT NULL,         -- denormalized copy of the descriptor (cache, never authority)
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,               -- ms epoch; backoff / credential expiry deadline
  lease_expires_at INTEGER,               -- ms epoch; held while an executor is running in-memory
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effect_outbox_due ON effect_outbox(next_attempt_at);
```

**No status column** — row exists ⟺ unresolved (P1). Resolution protocol:
append outcome event via `appendLogEvent` (CAS on head hash), THEN `DELETE
FROM effect_outbox WHERE effect_id = ?`. A crash between the two leaves a row
whose intention now has a logged outcome — the reconcile deletes it as an
orphan. A crash between GAD append of an intention and the outbox insert
leaves a derivable-but-missing row — the reconcile re-inserts it. Safe by
construction in both directions.

Retry: on executor failure, `attempts += 1`, `next_attempt_at = now +
min(30s, 500ms * 2^attempts)`; when `attempts >= maxAttempts(kind)` (model 3,
local_tool 1 for mutating / 3 for reads, channel/http 5, credential —
deadline-only), the driver calls `step` with `effect-failed` (F-rule). Leases:
`lease_expires_at = now + leaseMs(kind)` set when an executor starts; the
alarm sweep treats an expired lease as a crashed attempt (attempts += 1,
redispatch).

This ONE table replaces eight: `agent_turn_runs`,
`agent_turn_resume_attempts`, `agent_pending_steering`, `agent_turn_outbox`,
`agent_method_suspensions`, `agent_method_suspension_updates`, `suspensions`,
`deferred_requests`.

### 2.2 Reconcile (`reconcileOutbox`, ~50 lines, replaces the recovery zoo)

Replaces `recoverFromTurnLedger`, `tryReplayInterruptedModelTurn`,
`sweepStuckDelivery`, `drainTurnOutbox`, `recordResumeAttemptOnce`,
`replayDurablePendingSteering`, `recoverOrphanedPendingSteering`:

```
async function reconcileOutbox(loop: LoopInstance): Promise<void> {
  const state    = loop.state;                              // fresh fold (§2.3 already ran)
  const expected = derivePendingEffects(state);             // pure
  const expectedById = new Map(expected.map(e => [e.effectId, e]));

  const rows = sql`SELECT * FROM effect_outbox
                   WHERE branch_id = ${state.logId} AND kind != 'publish_envelope'`;

  // 1. Orphans: row without a derivable pending intention → outcome already
  //    logged (or never will be) → delete. No event append; the log already settled it.
  for (const row of rows) {
    if (!expectedById.has(row.effect_id)) {
      sql`DELETE FROM effect_outbox WHERE effect_id = ${row.effect_id}`;
    }
  }

  // 2. Missing: derivable intention without a row → crash between append and
  //    insert, or cache wipe (P3) → re-insert with attempts preserved at 0.
  const present = new Set(rows.map(r => r.effect_id));
  for (const eff of expected) {
    if (!present.has(eff.effectId)) {
      sql`INSERT OR IGNORE INTO effect_outbox
          (effect_id, branch_id, channel_id, kind, idempotency_key,
           descriptor_json, attempts, next_attempt_at, created_at)
          VALUES (${eff.effectId}, ${state.logId}, ${eff.channelId}, ${eff.kind},
                  ${eff.idempotencyKey}, ${json(eff)}, 0,
                  ${deadlineFor(eff) /* credential expiry or now */}, ${Date.now()})`;
    }
  }

  // 3. Descriptor drift check (debug assert, not control flow):
  //    stableJson(row.descriptor_json) must equal stableJson(expected descriptor).

  // 4. Dispatch everything due and unleased.
  await loop.dispatchDue();         // for each row: next_attempt_at <= now && lease free
  loop.scheduleAlarmForEarliest();  // min(next_attempt_at, lease_expires_at) across rows
}
```

`reconcileOutbox` runs: on DO wake (after fold validation), after every
`step` application, on alarm, and after fork `postClone`. It is idempotent
and cheap (outbox is small: pending effects only).

### 2.3 Fold cache (`fold-cache.ts`) — validation-on-wake protocol

The gad-store DO is remote (postToDO HTTP); without a cache every wake is an
O(log) cross-DO refold.

```sql
CREATE TABLE IF NOT EXISTS fold_cache (
  log_id      TEXT NOT NULL,
  head        TEXT NOT NULL,
  folded_seq  INTEGER NOT NULL,
  head_hash   TEXT NOT NULL,        -- hash of envelope at folded_seq
  state_blob  TEXT NOT NULL,        -- JSON.stringify(AgentState)
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (log_id, head)
);
```

Wake protocol (`loadState(logId, head)`):

1. `remote = gad.getLogHead({logId, head})`. Absent log → empty initial state.
2. Read `fold_cache` row.
   - No row → **cold refold**: page `readLog({afterSeq})` from 0 (or
     `forkSeq` — lineage reads include the parent prefix), fold all.
   - Row present and `row.head_hash === remote.hash` and
     `row.folded_seq === remote.seq` → deserialize; done (fast path).
   - Row present, `remote.seq > row.folded_seq` → fold the tail:
     `readLog({afterSeq: row.folded_seq})`; verify the first tail envelope's
     `prevHash === row.head_hash` — mismatch (history rewritten / wrong head)
     → discard row, cold refold.
   - Any other mismatch (`remote.seq < folded_seq`, hash differs at same
     seq) → discard row, cold refold.
3. Write back `fold_cache` after every successful append/fold advance
   (same DO txn as the outbox mutation when possible).

Never authority: the cache-amnesia suite (§4.4) deletes this row (and the
outbox) at randomized points and asserts identical behavior. Same shape as
WS2's `policy_state {foldedThroughSeq}`.

Appends from the driver always carry `expectedHeadHash = state.lastHash`; a
`log head conflict` error means another writer advanced the log (e.g. fork
tooling) → reload via the wake protocol and re-run `step` on the original
incoming.

### 2.4 Executor interfaces (`effect-executors/`)

```ts
export interface EffectExecutor<D extends EffectDescriptor = EffectDescriptor> {
  kind: EffectKind;
  execute(args: {
    descriptor: D;
    state: AgentState;                 // read-only; for context building
    signal: AbortSignal;               // interrupt/abort wiring
    deps: ExecutorDeps;                // gad, blobstore, ChannelClient factory, rpc, fetcher, credentials
    onEphemeral(e: EphemeralEmit): void;  // stream deltas / typing — never journaled
  }): Promise<EffectOutcome>;          // fed to outcomeEvents (§1.8)
}
```

#### 2.4.1 `model-call.ts` — on `@earendil-works/pi-ai` `streamText`

- Hydrate: `systemPromptHash`/`toolSchemasHash` from blobstore;
  `buildModelContext(state, contextThroughSeq)` (pure, in agent-loop) converts
  entries → pi-ai message array (replaces `buildSessionContext` +
  TrajectoryBackedSessionStorage — the JsonlSessionRepo/SessionStorage seam is
  gone; the log IS the session).
- Credentials: resolve API key via the model-catalog credential lookup; a
  missing/pending credential returns outcome
  `{kind:"suspended", reason:"credential", providerId, modelBaseUrl}`
  (replaces `TurnSuspensionSignal` propagation through `getApiKeyAndHeaders`).
- Drive `streamText` (provider adapters unchanged). **Streaming deltas**: per
  changed text/thinking block, build the same `message.delta` AgenticEvent
  shape as today (payload `{protocol, blockId, type, text, replace?}`,
  causality `{messageId}`) and hand to `onEphemeral` — the driver batches
  ~100ms and broadcasts via `ChannelClient.sendSignalEvent(participantId,
  AGENTIC_EVENT_PAYLOAD_KIND, event)` (the channel DO's ephemeral `signal`
  mode). Deltas are NEVER appended to any log and never durable envelopes
  (change from today, where pi-runner published them durably; the protocol
  already declares deltas advisory and the chat reducers apply them
  identically regardless of transport).
- Outcome: `{blocks, stopReason, usage, providerMetadata}`.
- Abort: `signal` aborted → outcome `{stopReason:"aborted", partialBlocks}`.

#### 2.4.2 `local-tool.ts`

Registry of `AgentTool`s built once per channel from pi-core tool factories +
consumer `getLoopTools()` (§3.2). Executes with the descriptor's args; honors
the mutation-replay guard of §1.4.2; tool `onUpdate` progress goes to
`onEphemeral` (signal `invocation.progress`).

#### 2.4.3 `channel-call.ts`

`ChannelClient.callMethod(callerPid, target.participantId, transportCallId,
method, args, {invocationId, transportCallId, turnId, timeoutMs})`. The
result returns via the channel DO's terminal delivery (`postToDO` →
`deliverEffectOutcome(effectId, outcome)` on the agent DO — the channel
already POSTs method results back; the handler shrinks to: look up outbox row,
run §1.8 append-then-delete, step). Streaming method updates
(`onStreamUpdate`, the old `agent_method_suspension_updates` sidecar) become
`onEphemeral` signal forwards — never persisted.

#### 2.4.4 `http-call.ts`

`ServerDOClient` POST with `Idempotency-Key: descriptor.idempotencyKey` and
callback address (§1.4.4). Synchronous responses resolve immediately;
deferred ones resolve later via `deliverEffectOutcome`. Replaces
`callDeferred`/`redriveDeferredRequests`/`onDeferredResult`
(durable-base.ts:331–457) — redrive is simply outbox re-dispatch.

#### 2.4.5 `credential-wait.ts`

Dispatch = publish the credential-connect card (ChannelClient publish of the
same card payload the vessel emits today, built from the event's `connectSpec`
snapshot) + register the `http_call` interest. Resolution paths: (a) http
callback from credentials service; (b) the `credentialConnected` agent method
(panel calls it after panel-scoped connect) — both funnel into
`deliverEffectOutcome(effectId, …)`; the deterministic outcome id makes the
race harmless. `next_attempt_at = expiresAt` doubles as the timeout alarm
(replaces the 5-min backstop alarm + `expireOverdue`).

#### 2.4.6 `publish.ts`

Fire-and-forget ChannelClient signal/typing/metadata. Exempt from the
reconcile invariant.

### 2.5 Multi-channel, TurnDispatcher reduction, DO surface

- One DO; `Map<channelId, LoopInstance>` where `LoopInstance = {logId, state,
  stepFn (composed with consumer policies), executors}`. Shared
  `effect_outbox` (rows carry `channel_id`) and ONE alarm: the driver's
  `alarm()` = for each loop: wake-validate fold → reconcile; then reschedule
  to the earliest due row.
- **`turn-dispatcher.ts` shrinks to addressing only** (file renamed in place;
  queue half deleted): `resolveShouldRespond({envelope, respondPolicy,
  selfHandle, mentions, replyTo, agentHops})` where `agentHops` is read from
  **envelope `annotations`** (WS2 channel policy stamps it) — the old payload
  reads at trajectory-vessel-base.ts:4680/4719 die in the same cut. Output:
  `{respond: boolean, mode: "prompt"|"steer"}`. The pending/pendingSteered
  queues, drainLoop, drainGeneration, interrupted flag, keepAlive — all die
  (commands feed `step` directly; ordering is the log's CAS; interruption is
  event 17).
- Channel envelope intake (the old `processChannelEvent`/`onChannelEnvelope`):
  on a delivered channel log envelope → refresh roster if stale (append
  `system.event {roster.snapshot}` when changed — nondeterministic I/O enters
  as a logged event) → `resolveShouldRespond` → if respond:
  `step({type:"command", command:{kind: mode, source:{envelopeId}, …}})`.
  Replay/dedup needs no `delivery_cursor`: the `recv:` deterministic id makes
  re-delivery a replay no-op, and "last observed envelope" is folded from
  `recv:` events.
- Typing indicator: driver emits `publish_envelope` typing-on when the outbox
  has model/tool rows for the channel, typing-off when it drains (replaces
  TurnDispatcher.notifyTyping).

### 2.6 Fork: `postClone` (~15 lines)

Replaces the cursor surgery + `forkPiBranchForClone`
(trajectory-vessel-base.ts:8023–8112). ForkWorker calls `workerd.cloneDO`
first (copies DO SQLite incl. fold_cache/outbox — both are caches and get
wiped), then:

```ts
override async postClone(parentObjectKey: string, newChannelId: string,
                         oldChannelId: string, forkPointPubsubId: string) {
  const from = gadBranchIdForChannel(oldChannelId);   // `branch:channel:{old}`
  const to   = gadBranchIdForChannel(newChannelId);
  const atSeq = await this.resolveTrajectorySeqForChannelSeq(from, forkPointPubsubId);
  await this.gad.call("forkLog", { fromLogId: from, fromHead: from,
                                   toLogId: to, toHead: to, atSeq });   // no-copy, idempotent
  this.sql.exec("DELETE FROM effect_outbox");          // caches: wiped, reconverge (P3)
  this.sql.exec("DELETE FROM fold_cache");
  this.identity.adoptObjectKey(this.objectKey);        // fix identity as today
  this.renameChannelScopedSettings(oldChannelId, newChannelId);
  await this.subscriptions.resubscribe(newChannelId);
  await this.driver.wake(newChannelId);                // fold forked head; fork policy (§1.6)
}                                                      // appends abandoned/closed for pre-cut pendings
```

The fork policy fires on the first wake because the driver passes the head's
`forkSeq` (from `getLogHead`) into the fold; any pending whose
`startedAtSeq ≤ forkSeq` is pre-cut. `forkSessionId` /
`getResumeSessionIdForChannel` / turn_map resolution all die — the forked log
IS the session. `canFork()` semantics unchanged (subscription-count check in
AgentWorkerBase).

### 2.7 The thin vessel: `agentic-do/src/agent-vessel.ts`

`export abstract class AgentVesselBase extends DurableObjectBase` (~1,500
lines target across driver+vessel): composes DOIdentity, SubscriptionManager,
ChannelClient factory, CardManager, FeedbackIngest, the driver, and the
standard agent method surface (`pause`→interrupt command, `resume`→wake,
`setModel`/`setThinkingLevel`/`setApprovalLevel`/`setRespondPolicy`→setConfig
command, `getAgentSettings`/`getDebugState` from folded state,
`credentialConnected`/`connectModelCredential`→credential executor,
`inspectMethodSuspensions`→`SELECT * FROM effect_outbox`). `AgentWorkerBase`
re-bases on it keeping its public override surface (§3.2).

---

## 3. UX-parity map and consumer migration

### 3.1 Behavior → new mechanism (every row is a Stage-B cutover checklist item)

| Today's behavior | Old mechanism | New mechanism |
|---|---|---|
| Streaming assistant text/thinking | `message.delta` events published as durable envelopes via appendTrajectoryBatch (pi-runner.ts:2518–2559) | model executor → `onEphemeral` → batched (~100ms) channel `signal` broadcast of the identical AgenticEvent shape; `message.completed` carries authoritative blocks (§2.4.1) |
| Approvals card | approval-gate extension + uiPrompt method suspension (`agent_method_suspensions` kind `uiPrompt`/`approval`) | `approval-gate` policy: `approval.requested` event + `channel_call` form effect; `approval.resolved` resumes (§1.6); payload shapes unchanged (pi-runner.ts:1677–1729) so the chat panel's approval card renders identically |
| `ask_user` | createAskUserExtension + askUser suspension kind | `ask-user` policy → `channel_call` (method `ask`); result → `invocation.completed` |
| Custom cards / CardManager (gmail) | `this.cards` CardManager (custom_cards table, `custom:{messageId}:{seq}` idempotency) publishing `custom.started/updated` | **kept as-is**: CardManager survives unchanged on the new vessel (its table is consumer state, not harness state); card emissions go through ChannelClient publish; incoming card method calls arrive as channel method calls → if mid-turn tool-driven, they are `channel_call` effects; if externally initiated (user clicks), they are plain `onMethodCall` handler invocations (no suspension machinery needed) |
| `ui.feedback` loop | FeedbackIngest dedupe + prepend-next-turn | kept; the queued note is included in the next `message.started` context (entries injection in `buildModelContext`) |
| Credential connect (panel-scoped, connect presets) | `getModelCredentialConnectSpec` + suspension-store + deferred RPC `credentials.connect` + backstop alarm | `credential_wait` effect (§1.4.5/§2.4.5); `providerConnect.toAgentCredentialSetup()` output is snapshotted INTO the `credential.wait_started` event; `model-catalog/providerConnect.ts` keeps its exports and re-targets `AgentVesselBase.getModelCredentialSetupProps` (same name, same Record shape — providerConnect has no agentic-do import today, so only the doc-comment reference changes) |
| Interrupt (pause button) | RunController.gateInterrupt + dispatcher.interrupt + abort chain | `interrupt` command → `system.event {interrupt}` + executor signal abort + terminal appends (C-interrupt, §1.3) |
| Steering mid-turn | `agent_pending_steering` + steerQueue + steerIntoActiveTurn | `steer` command appends the user `message.completed`; consumed by the next `message.started` snapshot (§1.3) |
| Typing indicator | dispatcher.notifyTyping | driver typing rule from outbox occupancy (§2.5) |
| Respond policy / addressing / hop cap | TurnDispatcher + payload agentHops reads (vessel:4680/4719) | reduced `turn-dispatcher.ts` reading hops from envelope annotations (§2.5) |
| Recovery diagnostics ("turn failed…") | `agent_turn_outbox` `emit_diagnostic` | F-rule appends a published diagnostic `message.completed` directly (P2 — the append IS the delivery intent; publish is same-txn) |
| Set title | `set_title` builtin tool | unchanged local_tool |
| Fork mid-turn | postClone + cursor surgery + forkSessionId | §2.6 |
| Hibernation wake | 4 recovery functions + resume attempts | wake protocol (§2.3) + reconcile (§2.2) + C-wake (§1.3) |

### 3.2 Consumer migration checklist (plan WS1.7b)

Subclass override surface on the new `AgentWorkerBase` (names preserved where
semantics survive):

kept verbatim: `getDefaultModel`, `getDefaultThinkingLevel`,
`getDefaultApprovalLevel`, `getDefaultRespondPolicy`,
`getModelCredentialSetupProps`, `getModelCredentialProviderIds`,
`getModelCredentialTokenClaims`, `getParticipantInfo`,
`getStandardAgentMethods`, `onMethodCall`, `createTables`/`migrate`,
`alarm` (super-call contract), `onPostClone`.
renamed/reshaped: `getRunnerTools` → `getLoopTools(channelId): AgentTool[]`
(registered with the local-tool executor); `getRunnerPromptConfig` →
`getPromptConfig` (feeds the system-prompt compose whose hash lands in the
request descriptor); `createRunner` → `getStepPolicies(channelId):
StepPolicy[]` + `getPublishPolicy` (declarative replacements for runner
wrapping); `getExpectedChannelToolNames` kept (roster warning);
`processChannelEvent` → `onChannelEnvelope` hook before addressing.

Per consumer:

1. **`workspace/workers/agent-worker` (AiChatWorker)** — direct re-base, no
   custom hooks. Migrate: `getExpectedChannelToolNames` (`["eval"]`),
   `getParticipantInfo`. Verify default model `openai-codex:gpt-5.5`,
   approval level 2, system prompt from `meta/AGENTS.md`.
2. **`workspace/workers/test-agent`** — re-base; `getDefaultModel`
   (`anthropic:claude-sonnet-4-6`), `getParticipantInfo`. Its
   `processChannelEvent` deterministic mode (publishes synthetic
   turn/invocation/message events) re-implements as a `deterministic` step
   policy OR direct `appendLogEvent` calls in the `onChannelEnvelope` hook —
   the synthetic event payloads must keep their exact shapes (panel test
   fixtures depend on them). `maybeWriteVaultSwitchMarker` unchanged.
3. **`workspace/workers/gmail-agent`** — re-base; `getRunnerTools` →
   `getLoopTools` mapping `GMAIL_TOOLS` (each tool wraps
   `spec.run(this.handlers, channelId, args)` — now executed inside the
   local-tool executor, NOT a closure over a live runner); CardManager
   (`this.gmailCards` wrapping `this.cards`) unchanged per §3.1;
   `getRespondPolicy` (`"mentioned-or-followup"`), `getRunnerPromptConfig` →
   `getPromptConfig` (GMAIL_SYSTEM_PROMPT); keep `subscribeChannel` additions,
   `alarm()` sync scheduling (must call `super.alarm()` so outbox dispatch
   still runs), wake-queue digest turns become `prompt` commands with
   alarm-origin turnIds (salted via ctx.random, recorded in the event),
   `onMethodCall` Gmail method dispatch, `installChannelUi`, card recovery
   (`ensureRecovered` — now reads the folded log instead of replaying custom
   messages).
4. **`workspace/workers/silent-agent-worker`** — `createRunner` override dies;
   becomes `getStepPolicies` returning the `silent` policy (§1.6: publish
   only turn.opened/closed, allowlist tool filter from config, inject `say`
   tool). `getParticipantInfo` migrates as-is.
5. **`workspace/packages/model-catalog/src/providerConnect.ts`** — no code
   change beyond doc references; `toAgentCredentialSetup()` keeps producing
   the `ModelCredentialSetupProps` Record; verify panel-scoped credential
   matching (audience `[{url: modelBaseUrl, match:"path-prefix"}]`) flows
   into the `credential.wait_started` snapshot. Connect-preset UX is on the
   Stage-B parity checklist (manual smoke: connect each of the 9 presets'
   flows at least for openai-codex OAuth2 + one api-key provider).
6. **`agent-worker-base.integration.test.ts`** — must pass against the new
   base (existing-suite UX guard).

---

## 4. Test plan

### 4.1 Scenario scripts (port of `pi-runner.test.ts` behaviors)

`agent-loop/src/scenario.ts` provides a pure harness:

```ts
runScenario({
  steps: Array<
    | { incoming: Incoming }
    | { outcome: { effectId: string; outcome: EffectOutcome } }   // simulated executor result
    | { expectAppend: PartialEnvelopeMatch[] }
    | { expectEffects: PartialEffectMatch[] }
    | { expectState: (s: AgentState) => void }
  >;
  policies?: StepPolicy[];
})
```

It maintains `state` by folding each step's `append` (no I/O anywhere). Port
these behavior categories from pi-runner.test.ts (3,636 lines):

turn lifecycle (turn.opened/closed durability, agent-start/end matching);
steering (queued before next model call; iteration-boundary aborts); approval
request/resolve event shapes incl. deny → invocation.failed; ask_user gating;
close_turn_without_response; channel method invocations; per-block delta
emission (now: ephemeral emits, assert NOT in append); thinking-block
variants; tool-call name/args parsing; user message provenance (recv: id, no
republish); duplicate terminal invocation filtering (now: deterministic-id
replay no-op); suspension keeps turn open + no failure published (credential
wait scenario); recoverable invocations on restart (wake scenario); durable
open-state repair (wake appends abandoned/closed); oversized payload blob
spill; interrupted/empty/tool_calls_only outcome classification; compaction
failure does not fail turn; multi-attempt: model failure → message.failed →
fresh messageId on retry; the §1.3 C-wake guard (failed attempt with
non-terminal invocation → NO new model_call).

### 4.2 Property tests (pure layer)

- **No effect without logged intention:** ∀ scenario prefixes:
  `step(...).effects ⊆ derivePendingEffects(fold(log ⊕ append))`.
- **Fold determinism:** refold of any scenario's full log ≡ incrementally
  maintained state (golden-state snapshots).
- **Id determinism:** running the same scenario twice yields byte-identical
  envelopeIds and effectIds.
- **Terminal uniqueness:** generated event streams never contain two
  different payloads under one terminal id within a lineage.
- **Steering conservation:** every steered user message appears in exactly
  one subsequent `message.started.contextThroughSeq` window or survives a
  `turn.closed` into the next turn.

### 4.3 Crash-injection harness (driver, workerd-less first)

Simulated driver with injectable kill points BETWEEN every pair of:
{appendLogEvent returns} / {outbox insert} / {executor dispatch} /
{outcome append} / {outbox delete} / {fold_cache write}. After each kill:
restart → wake protocol → reconcile → run to quiescence; assert the final
event log is identical to the uninterrupted run's (modulo `appendedAt` and
benign extra `message.failed{recoverable}`+retry pairs, which must themselves
be deterministic given the kill point). Specifically cover: crash between
intention append and outbox insert; between outcome append and row delete;
mid-model-stream (orphan `message.started` → C-wake rule 1); duplicate
`deliverEffectOutcome` delivery (replay no-op); crashed-attempt retry never
duplicates tool dispatch (plan Verification line). Gate for the Stage-B cut.

### 4.4 Cache-amnesia suite (P3)

During randomized scenario runs, at random points: `DELETE FROM effect_outbox`
and/or `DELETE FROM fold_cache` (and, in the workerd E2E variant, the channel's
`pending_calls`). Assert behavior identical to the uninterrupted run. Any
divergence = a structure mis-classified as authority.

### 4.5 Integration / E2E

`agent-worker-base.integration.test.ts` green on the new base; workerd E2E:
streaming (signal deltas observed, none durable), approval round-trip,
ask_user, gmail card create/update, credential connect (mock provider), fork
mid-turn (pre-cut pendings abandoned in child, parent completes — the
fork-divergent-terminal test from Stage-0 §3.6 exercised end-to-end),
interrupt, hibernation wake mid-tool.

---

## 5. Deletion list (Stage-B cut)

Files deleted outright:
- `workspace/packages/agentic-do/src/trajectory-vessel-base.ts` (8,662)
- `workspace/packages/agentic-do/src/run-controller.ts` (288) + `run-controller.test.ts`
- `workspace/packages/agentic-do/src/suspension-store.ts` (310) + `suspension-store.test.ts`
- `workspace/packages/harness/src/pi-runner.ts` (4,378 — survivors, if any helpers are still referenced, move to `agent-loop`/executors first; the file goes)
- `workspace/packages/harness/src/turn-suspension.ts` (43)
- `workspace/packages/harness/src/turn-snapshot.ts` (50)
- `workspace/packages/harness/src/pi-runner.test.ts` (3,636 — superseded by scenario suite; port before delete)

Surgical deletions:
- `workspace/packages/agentic-do/src/turn-dispatcher.ts` — queue half
  (pending/pendingSteered/drainLoop/keepAlive/interrupted); addressing
  survives (§2.5). Its keepalive test dies with it.
- `workspace/packages/runtime/src/worker/durable-base.ts` — entire deferred-
  RPC layer: `deferred_requests` DDL + `ensureDeferredSchema`, `callDeferred`,
  `onDeferredResult`, `applyDeferredResult`, `redriveDeferredRequests`,
  `onDeferredResolved` (lines ~280–468). Alarm + state-KV APIs stay.
- DO tables (drop in schema bump): `agent_turn_runs`,
  `agent_turn_resume_attempts`, `agent_pending_steering`, `agent_turn_outbox`,
  `agent_method_suspensions`, `agent_method_suspension_updates`,
  `suspensions`, `deferred_requests`, `delivery_cursor`.
- `package.json` dependency `@earendil-works/pi-agent-core` (everywhere) —
  replaced by vendored `workspace/packages/pi-core`. `@earendil-works/pi-ai`
  STAYS.
- In-vessel concepts with no new-world file: `HARNESS_MODEL_REPLAY_TOOL_SAFETY`,
  `RunController` projections, `ChannelPublicationBroadcastState`,
  `recordResumeAttemptOnce`, `persistPendingSteering`,
  `recoverFromTurnLedger`, `tryReplayInterruptedModelTurn`,
  `sweepStuckDelivery`, `drainTurnOutbox`, `forkPiBranchForClone`,
  `inFlightCredentialDeferrals` buffering.

---

## 6. Build order — five independently implementable chunks

Each chunk has a hard file boundary and its own test gate; (1)–(3) have no
infra dependencies and can run in parallel with Stage-0 once the
`LogEnvelope` contract is frozen.

1. **Vendor pi-core.** `workspace/packages/pi-core/` from
   `@earendil-works/pi-agent-core` v0.78.0: types (`AgentMessage`,
   `AgentTool`, content blocks), compaction pure functions, session-tree
   types + `buildSessionContext` helpers, system-prompt/skills/prompt-template
   composition, builtin tool factories (read/edit/write/grep/find/ls). Drop:
   agent-loop.ts await chain, AgentHarness, JsonlSessionRepo, extension
   runtime/hook bus. Gate: typecheck + existing prompt-compose tests pass
   against the vendored copy.
2. **Pure `agent-loop` package.** Everything in §1 (`state/fold/step/effects/
   ids/commands/context/policies/scenario`) + scenario suite (§4.1) + property
   tests (§4.2). No infra. Gate: scenario suite green → **EventKind vocabulary
   freezes** (§1.9 additions land in agentic-protocol `events.ts`/`schemas.ts`).
3. **Executors.** `agentic-do/src/effect-executors/{model-call,local-tool,
   channel-call,http-call,credential-wait,publish}.ts` (§2.4) + the http-call
   server-side callback surface in `src/server/harnessApi.ts`
   (idempotency-keyed accept + postToDO result delivery). Gate: executor unit
   tests with mocked deps; model-call against pi-ai fake provider.
4. **Driver.** `agentic-do/src/{agent-loop-driver,effect-outbox,fold-cache}.ts`
   + reduced `turn-dispatcher.ts` + crash-injection (§4.3) and cache-amnesia
   (§4.4) suites. Gate: both suites green against simulated gad-store
   (`createTestDO(GadWorkspaceDO)` from Stage 0).
5. **Thin vessel + consumer migration + deletion.**
   `agentic-do/src/agent-vessel.ts`, re-based `agent-worker-base.ts`, the four
   workers + providerConnect verification (§3.2), workerd E2E (§4.5), then
   execute §5 in one commit (Stage-B flip). Gate: integration test, E2E smoke,
   UX-parity checklist (§3.1) all green.

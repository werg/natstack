# Agent Heartbeats

## Motivation

Natstack has three related but distinct scheduling needs:

- **Cron jobs**: deterministic calls into a Durable Object, declared in
  `meta/natstack.yml` `recurring:` and approval-gated before they can run.
- **Liveness heartbeats**: cheap "is this process/session/connection alive?"
  pings, already used by shells, pubsub clients, and long-running RPC paths.
- **Agent heartbeats**: scheduled or event-driven agent turns that inspect
  state, decide whether a bounded action is warranted, optionally act, and
  report or stay silent.

The bgkit supervisor is the first concrete agent-heartbeat use case: a training
run emits metrics, the agent should wake on cadence or material events, decide
whether the change matters, tune only when warranted, and leave a durable audit
trail. News and Gmail have adjacent scheduling loops, but they mostly need cron,
polling, and batch wake queues. The goal here is a general system that preserves
those differences.

## External Patterns

The useful OpenClaw distinction is that a heartbeat is a scheduled agent turn in
the main agent context, not a detached background task record. It may be silent
when nothing needs attention, and it has options such as lightweight context,
isolated sessions, active hours, target delivery, and skip-when-busy.

The useful Hermes distinction is that agent heartbeats are not cron reminders
and not "still working" progress pings. A heartbeat wakes an agent with context
and tools, asks it to inspect current state, lets it perform a safe micro-action,
and records run metadata such as last run, status, failures, and next action.

OpenClaw's public bug history also highlights two failure modes Natstack should
avoid:

- Loading full conversation/workspace context on every heartbeat can create
  unbounded token growth.
- Multi-agent heartbeats must have independent schedules; a main agent's run
  must not pull every other agent forward.

## Design Principles

1. **Separate scheduling from agent semantics.**
   `RecurringRegistry` and `RecurringScheduler` decide when a job is due.
   Agent heartbeat code decides whether a model turn is worth spending.

2. **Use Durable Objects as ownership boundaries.**
   A heartbeat belongs to the agent DO that owns the state it inspects and the
   turn queue it will enqueue into. The server should not synthesize agent
   prompts directly.

3. **Use `setAlarmAt` for per-DO cadence.**
   Absolute deadlines match the server-driven alarm driver and avoid
   accumulated delay math. Heartbeats must not call `setAlarmAt` directly from
   `AgentWorkerBase` subclasses, though: agent DOs already use the single DO
   alarm for effect-outbox redrive and scheduled model resumes. A heartbeat
   loop must register its deadline with a shared per-DO alarm multiplexer that
   owns the one physical alarm slot.

4. **Approval-gate unattended declarations.**
   Editing `meta/natstack.yml` to add or change a heartbeat is an unattended
   execution capability and should appear in the same meta-change approval flow
   as `recurring:`.

5. **Default to bounded, cheap, non-spammy runs.**
   Heartbeats should skip when busy, enforce a per-run budget, be silent on
   no-op acknowledgements, and record durable status.

## Single Landing Scope

This should land as one coherent implementation, not as partially usable
phases. The implementation order still has dependencies, but the shipped result
should include all of:

- the `AgentWorkerBase` alarm multiplexer;
- replay-safe turn metadata/context policy;
- `AgentHeartbeatLoop` replacing the ad-hoc bgkit `MonitorLoop` plumbing;
- durable heartbeat failure/backoff/status state;
- a workspace heartbeat registry/index for discovery and global controls;
- `workspace.heartbeats.*` service methods backed by that registry;
- `meta/natstack.yml` `heartbeats:` parsing, validation, and approval entries;
- bgkit migrated onto the general system and registered in the workspace index.

The only "gate" that remains is the existing trust/approval gate for declaring
unattended scheduled agent work in `meta/natstack.yml`. That is a safety
property, not a staged rollout.

## Proposed Surface

### 1. Library: `AgentHeartbeatLoop`

Replace or rename the current `MonitorLoop` as a public agentic-do primitive:

```ts
export class AgentHeartbeatLoop {
  constructor(deps: AgentHeartbeatLoopDeps);

  createTables(): void;
  start(options?: HeartbeatStartOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  signal(event?: unknown): Promise<HeartbeatTickResult>;
  runNow(reason?: string): Promise<HeartbeatTickResult>;
  onAlarm(now?: number): Promise<HeartbeatTickResult>;
  rehydrate(): Promise<void>;
  getDebugState(): HeartbeatState;
}
```

Core deps:

```ts
interface AgentHeartbeatLoopDeps {
  sql: SqlStorage;
  namespace?: string;
  scheduleWakeAt: (sourceId: string, timeMs: number) => void | Promise<void>;
  clearWake?: (sourceId: string) => void | Promise<void>;
  isTurnInFlight?: () => boolean;
  evaluate: (ctx: HeartbeatEvaluationContext) =>
    | HeartbeatDecision
    | Promise<HeartbeatDecision>;
  enqueueTurn: (turn: HeartbeatTurnRequest) => void | Promise<void>;
  now?: () => number;
  log?: Pick<Console, "warn" | "info">;
}
```

Important types:

```ts
type HeartbeatStatus = "running" | "paused" | "stopped";
type HeartbeatTrigger =
  | { kind: "cadence"; scheduledAt?: number }
  | { kind: "signal"; event?: unknown }
  | { kind: "manual"; reason?: string };

interface HeartbeatDecision {
  action: "skip" | "prompt" | "continue";
  reason?: string;
  digest?: string;
  promptText?: string;
  silentOk?: boolean;
  maxModelCalls?: number;
  delivery?: "none" | "channel" | "last-contact";
}
```

This is mostly the current `MonitorLoop`, but with public naming and semantics
that match general agent heartbeats rather than monitoring. The current
`Playbook` can stay as a companion helper for declarative rules.

### 2. Per-DO Alarm Multiplexer

`AgentWorkerBase` needs an internal alarm multiplexer before heartbeats can be
safe. Today the agent loop driver calls `scheduleAlarm(at)` for effect outbox
redrive and scheduled model resumes, and the subclass's `alarm()` forwards the
single physical DO alarm to `driver.alarm()`. A heartbeat loop that also calls
`setAlarmAt` can overwrite that driver alarm, or be overwritten by it.

Add a small scheduler owned by `AgentWorkerBase`:

```ts
interface AgentAlarmSource {
  id: string;
  nextWakeAt(): number | null;
  fire(now: number): Promise<void>;
}
```

The base class registers built-in source `agent-loop-driver`, then heartbeat
loops register sources such as `heartbeat:bgkit`. The multiplexer persists or
queries each source's own durable deadline, computes the earliest, calls the
single `setAlarmAt(earliest)`, and on `alarm()` invokes every due source before
rearming.

This should not be `RecurringScheduler` as-is. `RecurringScheduler` is a useful
multi-job scheduler for application-owned recurring jobs, but agent recovery
deadlines are not recurring jobs and already live in the effect outbox/model
resume state. The shared abstraction is closer to `AlarmMux` /
`DurableAlarmRegistry`: a deadline combiner with named due sources, not a
recurring-job table.

### 3. Agent Base Integration

Add an optional helper method to `AgentWorkerBase` so worker authors do not
repeat the same turn dispatch glue:

```ts
protected createHeartbeatLoop(options: {
  namespace: string;
  defaultPromptText?: string;
  evaluate: AgentHeartbeatLoopDeps["evaluate"];
  channelId: () => string | null;
}): AgentHeartbeatLoop;
```

The helper should:

- register the heartbeat source with the base alarm multiplexer;
- wire `isTurnInFlight` to the agent loop driver/debug state once a stable
  public busy bit exists;
- enqueue heartbeat prompts through `submitAgentInitiatedTurn` with a stable
  `steeringId` prefix;
- tag the turn internally as `origin: "heartbeat"` and attach a context policy
  so diagnostics, cards, prompt assembly, and future policies can distinguish it
  from user messages and cron jobs.

This keeps the policy in the agent DO, where state and permissions already live.

### 4. Turn Metadata And Context Policy

The existing `submitAgentInitiatedTurn(channelId, { content }, { steeringId,
mode })` is not enough for heartbeat context/cost controls. It always uses the
normal prompt artifacts and the normal loop config. Without extending this API,
`context.mode`, `tokenBudget`, `maxModelCalls`, `ackToken`, and
`origin: "heartbeat"` are only documentation.

Add an explicit turn options surface:

```ts
interface AgentInitiatedTurnOptions {
  steeringId?: string;
  mode?: "auto" | "sequential";
  origin?: "agent-initiated" | "heartbeat" | "scheduled";
  contextPolicy?: {
    mode?: "full" | "heartbeat" | "isolated";
    includeWorkspacePrompt?: boolean;
    includeSkillIndex?: boolean;
    promptFile?: string;
    tokenBudget?: number;
  };
  loopConfigPatch?: {
    maxModelCallsPerTurn?: number | null;
    modelStreamIdleTimeoutMs?: number | null;
  };
  delivery?: "none" | "channel" | "last-contact";
  ackToken?: string;
}
```

Implementation should use a normal `prompt` command with durable metadata, not a
new agent-loop command kind at first. The prompt command already represents
external intent, and `AgentLoopConfig` already carries per-turn limits such as
`maxModelCallsPerTurn`.

The metadata cannot be only an ephemeral argument to
`submitAgentInitiatedTurn`. It must be journaled before any model effect is
emitted so recovery/refold sees the same context policy and limits. Two viable
shapes:

- extend `Command.kind === "prompt" | "steer"` with `metadata`, and have
  `recvItem()` persist that metadata into the private trajectory message copy;
- or append a sibling internal event such as `turn.policy` / `turn.metadata`
  adjacent to `message.completed` and `turn.opened`.

The fold then derives the open turn's origin/context policy/config overlay from
durable log state. Prompt-artifact assembly chooses compact heartbeat artifacts
from that durable policy, and model-step execution overlays the per-turn config
patch when deriving the model call. A new command kind should only be introduced
if normal prompt metadata cannot express the lifecycle cleanly.

### 5. `meta/natstack.yml` Declarative Heartbeats

Add a top-level `heartbeats:` section rather than overloading `recurring:`.

```yaml
heartbeats:
  - name: bgkit-monitor
    target:
      source: workers/bgkit-supervisor
      className: BgkitSupervisorWorker
      objectKey: workspace-bgkit-supervisor
    schedule:
      every: 5m
      jitter: 30s
      activeHours:
        start: "08:00"
        end: "23:00"
        timezone: local
    context:
      mode: heartbeat
      includeWorkspacePrompt: false
      includeSkillIndex: false
      promptFile: skills/bgkit-training/HEARTBEAT.md
      tokenBudget: 12000
    behavior:
      skipWhenBusy: true
      delivery: none
      ackToken: HEARTBEAT_OK
      maxModelCalls: 1
      failureBackoff:
        base: 5m
        max: 4h
```

This declaration should not cause the server to call the model. It should call
a target DO method such as:

```ts
configureHeartbeat(config: WorkspaceHeartbeatDecl): Promise<{ ok: true }>;
runHeartbeatNow(name: string, trigger?: unknown): Promise<HeartbeatTickResult>;
```

The target DO persists the config into its heartbeat loop state, owns the
semantic policy, registers the heartbeat in the workspace heartbeat registry,
and combines declarative config with runtime state. This avoids the
OpenClaw-style failure where one central scheduler couples all agents' cadence:
the registry is an index/control plane, not the scheduler that calls models.

Per-channel agents such as bgkit should also register code-owned heartbeat
instances in the same registry. They do not need to be represented by a template
string like `bgkit-${channelId}` in `meta/natstack.yml`; they can register their
concrete `(source, className, objectKey, heartbeatName, channelId)` when the
channel subscription exists. Any declaration that fans out over channels must do
so through this same registry/discovery surface rather than by inventing
unresolved object-key templates.

For pure server-dispatched scheduled agent runs, keep using `recurring:`. The
new `heartbeats:` section is for agent-owned wake loops.

### 6. Workspace Config Types

Add:

```ts
export interface WorkspaceHeartbeatDecl {
  name: string;
  target: { source: string; className: string; objectKey?: string };
  channel?: {
    mode?: "subscribed" | "fixed";
    id?: string;
    handle?: string;
  };
  schedule: {
    every: string;
    jitter?: string;
    at?: string;
    activeHours?: { start: string; end: string; timezone?: "local" | string };
  };
  context?: {
    mode?: "heartbeat" | "full" | "isolated";
    promptFile?: string;
    includeWorkspacePrompt?: boolean;
    includeSkillIndex?: boolean;
    tokenBudget?: number;
  };
  behavior?: {
    skipWhenBusy?: boolean;
    delivery?: "none" | "channel" | "last-contact";
    ackToken?: string;
    maxModelCalls?: number;
    failureBackoff?: { base?: string; max?: string };
  };
}
```

Validation should mirror `recurring:`:

- names are stable and unique;
- target source/class is valid and resolves to a singleton or declared worker;
- duration strings parse;
- `at` only applies to day-multiple intervals;
- `tokenBudget`, `maxModelCalls`, and intervals have safe minimums/maximums.

Meta approval should add a `unitKind: "agent-heartbeat"` entry with capabilities
like:

```text
unattended agent wake every 5m, may invoke tools through BgkitSupervisorWorker,
delivery none, maxModelCalls 1, tokenBudget 12000
```

### 7. Durable State

Each agent DO stores heartbeat state in its own SQLite database:

- `heartbeat_loops`
  - `name`, `status`, `cadence_ms`, `jitter_ms`, `next_run_at`
  - `objective`, `last_digest`, `last_wake_at`, `last_decision`
  - `last_action_summary`, `last_error`, `fail_count`, `backoff_until`
  - `config_json`, `spec_hash`

The current `MonitorLoop` does not have this full state. It records `lastWakeAt`
before enqueue, logs enqueue errors, and returns `enqueued: true` even when the
enqueue failed. Moving to the promised durable failure/backoff semantics is more
than a rename: enqueue failures and repeated model-turn failures need durable
`last_error`, `fail_count`, and `backoff_until` fields, and tick results must
distinguish "decision wanted a turn" from "turn was actually enqueued."

The workspace also keeps a lightweight heartbeat registry in `WorkspaceDO`.
This is not the source of scheduling truth; it is the discovery/status/control
index for workspace APIs and UI:

- `name`
- `source`, `className`, `objectKey`
- `channelId` / `participantHandle` when applicable
- `kind`: `"declarative"` or `"code-owned"`
- `status`, `nextRunAt`, `lastWakeAt`, `lastActionSummary`, `lastError`
- `specHash`, `updatedAt`

Agent DOs update this row when they configure, pause/resume, run, fail, or
remove a heartbeat. Workspace-level controls resolve a registry row and then
dispatch back to the target DO, which remains authoritative.

### 8. Runtime Semantics

On startup or meta-change:

1. The workspace reconciler reads `heartbeats:`.
2. It dispatches each declaration to the target DO's `configureHeartbeat`.
3. The DO validates domain-specific details, persists the spec hash, and arms
   the shared agent alarm multiplexer for `nextRunAt`.
4. Removed declarations dispatch `removeHeartbeat(name)` or are pruned by the
   target during reconcile.

On alarm:

1. The target DO calls `heartbeat.onAlarm(now)`.
2. The loop checks status, active-hours, backoff, and `skipWhenBusy`.
3. The loop calls `evaluate(ctx)` with trigger, state, config, and recent
   failure metadata.
4. If the decision is `skip`, it persists the digest/reason and re-arms.
5. If the decision is `prompt` or `continue`, it records `lastWakeAt`, enqueues
   a normal serialized agent turn, and re-arms.

On signal:

1. Domain code calls `heartbeat.signal(event)`.
2. Signals evaluate immediately but do not disturb the cadence floor unless the
   loop decides to run and wants to advance `nextRunAt`.

On failure:

- `evaluate` failures are no-op skips with warning metadata.
- enqueue failures apply exponential backoff and return a non-enqueued result.
- model/tool failures are tracked by the agent turn machinery and summarized
  into heartbeat state when possible.

### 9. Context and Cost Controls

Heartbeat turns need a dedicated prompt/context policy:

- `context.mode: "heartbeat"` defaults to a compact system prompt plus the
  heartbeat prompt file, not full workspace prompt material.
- `context.mode: "isolated"` uses a fresh turn/session history while still
  writing a summary into heartbeat state.
- `tokenBudget` caps prompt assembly before the model call.
- `ackToken` or structured `silentOk` drops no-op replies.
- `maxModelCalls` defaults to `1` for unattended heartbeats.
- Whole-turn `maxDuration` is out of scope for this atomic heartbeat cut. It is
  a separate agent-loop deadline/abort feature over open turns; this heartbeat
  cut supports `maxModelCalls` and `modelStreamIdleTimeoutMs` as runtime caps.

For bgkit, the heartbeat prompt should be mostly generated from current metrics,
current hyperparameters, firing Playbook rules, and a compact last-action
summary. The model does not need the full conversation every five minutes.

### 10. Public Status and Controls

Expose diagnostics through the existing workspace service surface for all
registered heartbeats:

```ts
workspace.heartbeats.list(): Promise<HeartbeatStatus[]>
workspace.heartbeats.runNow(name: string): Promise<HeartbeatTickResult>
workspace.heartbeats.pause(name: string): Promise<{ ok: true }>
workspace.heartbeats.resume(name: string): Promise<{ ok: true }>
```

These methods resolve `name` through the workspace heartbeat registry, dispatch
to the concrete target DO, and return target-owned status. When names are not
globally unique enough for a command, the service should also accept a stable
registry id or `{ name, source, className, objectKey }` selector.

For worker-local channel UI, keep cards domain-specific. Bgkit's monitor card
can continue to show loop status, cadence, Playbook rules, and last action.

### 11. Atomic Migration From Current Code

1. Add the `AgentWorkerBase` alarm multiplexer and move the agent loop driver's
   outbox/resume alarm scheduling behind it.
2. Extend `submitAgentInitiatedTurn` / driver input with heartbeat origin,
   context policy, and per-turn loop config overrides, and journal that policy
   into the durable agent log before model effects are emitted.
3. Rename `MonitorLoop` to `AgentHeartbeatLoop` with no compatibility export or
   legacy alias.
4. Change bgkit wiring from direct `setAlarm`/`setAlarmAt` calls to the base
   alarm multiplexer.
5. Add durable failure/backoff fields and accurate enqueue result semantics.
6. Add the WorkspaceDO heartbeat registry and `workspace.heartbeats.*` service
   methods.
7. Move bgkit's generic loop docs/comments out of training language.
8. Add `WorkspaceHeartbeatDecl` to shared workspace types and validation.
9. Add meta-change approval provider for `heartbeats:`.
10. Add optional `AgentWorkerBase.createHeartbeatLoop`.
11. Convert bgkit to a code-owned `AgentHeartbeatLoop` instance that registers
    into the workspace heartbeat registry.

### 12. What Not To Do

- Do not merge heartbeats into `recurring:`. Cron and agent heartbeats have
  different semantics, status, prompts, and user expectations.
- Do not let heartbeat loops call the physical DO alarm directly from an agent
  subclass; they must share the base alarm multiplexer with outbox redrive and
  scheduled model resumes.
- Do not centralize all heartbeat firing in one main agent. Each target agent
  DO must own its cadence to avoid coupled multi-agent schedules.
- Do not append every heartbeat to an unbounded main conversation history.
- Do not treat a liveness ping as an agent heartbeat.
- Do not let a heartbeat bypass the normal agent turn queue or tool policy.
- Do not promise whole-turn duration caps until the agent loop has durable
  deadline/abort behavior for open turns.

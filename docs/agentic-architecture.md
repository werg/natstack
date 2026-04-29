# Agentic Architecture: Channels, Workers, and In-Process Pi

## Overview

NatStack's agentic system is a 2-layer server-side architecture. Pi
(`@mariozechner/pi-coding-agent`) runs **in-process** inside each agent
worker DO — there is no harness child process layer.

```
Panel (browser)          Channel DO (workerd)     Worker DO (workerd, embeds Pi)
     │                        │                        │
     │── user message ───────►│── onChannelEvent ──────►│
     │                        │                        │── runner.runTurn(content) ──┐
     │                        │                        │                              │
     │                        │                        │  Pi AgentSession streams     │
     │                        │                        │  events in-process           │
     │                        │                        │                              │
     │                        │◄── sendEphemeralEvent ──◄── snapshot/text-delta ◄────┘
     │◄── ephemeral message ──│   (state snapshots +
     │                        │    typing-indicator
     │                        │    deltas)
     │                        │                        │
     │── method-result ──────►│── onCallResult ───────►│── resolve continuation Promise
     │                        │                        │
```

- **Channel DO** — `workspace/workers/pubsub-channel/channel-do.ts`. Forkable
  history, SQLite-backed message storage, participant roster, ephemeral and
  persisted message routing. Enforces participant handle uniqueness so the
  channel-tools extension can use bare method names without collision.
- **Worker DO** — `workspace/packages/agentic-do/src/agent-worker-base.ts`.
  Owns one `PiRunner` per channel; Pi's `AgentSession` runs in-process.
  Forwards Pi events to the channel as ephemeral state-snapshot + text-delta
  streams.

## Key design principle: Pi is the source of truth

Pi's `AgentSession.state.messages` is authoritative. The chat UI does NOT
maintain its own message reducer or event-replay state machine — it just
renders the latest snapshot the worker pushes. There are no parallel state
machines, no `MessageState`, no `MethodHistoryTracker`, no `StreamWriter`.

### Two ephemeral channel streams

The worker forwards Pi events as two ephemeral channel messages:

| contentType | Payload | When |
|---|---|---|
| `natstack-state-snapshot` | `{ messages: AgentMessage[]; isStreaming: boolean }` | After every meaningful Pi state change: `message_end`, `tool_execution_end`, `auto_compaction_end`, `auto_retry_end`, `turn_end` |
| `natstack-text-delta` | `{ messageId: string; delta: string }` | For every Pi `message_update` text_delta event |

Snapshots are idempotent — the consumer renders the latest one. Text deltas
are purely cosmetic typing-indicator fodder; the next snapshot replaces them
wholesale. The chat UI's `usePiSessionSnapshot` and `usePiTextDeltas` hooks
read these streams via `parseEphemeralEvent` from `@workspace/agentic-core`.

## DO Base Classes

**DurableObjectBase** — generic DO foundation (~150 lines).
Location: `workspace/packages/runtime/src/worker/durable-base.ts`

**AgentWorkerBase** — Pi-native agent base extending DurableObjectBase.
Location: `workspace/packages/agentic-do/src/agent-worker-base.ts`

### Customization hooks (Pi-native)

| Hook | Default | Purpose |
|------|---------|---------|
| `getModel()` | subclass override required; `AiChatWorker` uses `"openai-codex:gpt-5.5"` | Model id in `provider:model` format |
| `getThinkingLevel()` | `"medium"` | Pi thinking level |
| `getApprovalLevel(channelId)` | `2` (full auto) | 0 = ask all, 1 = auto safe tools, 2 = full auto |
| `shouldProcess(event)` | Panel messages only | Filter incoming channel events |
| `buildTurnInput(event)` | Extract content | Transform to TurnInput |
| `getParticipantInfo()` | Generic agent | Channel identity + advertised methods |

The final prompt is composed from the NatStack base prompt,
`workspace/meta/AGENTS.md`, the generated skill index, and optional
subscription prompt config. Workspace skills live under `workspace/skills/`
and are discovered through the `workspace.*` RPC service.

### SQLite tables

| Table | Purpose |
|-------|---------|
| `state` | Key-value store (approval level per channel, fork metadata) |
| `subscriptions` | Channel subscriptions + participant ID |
| `pi_sessions` | Per-channel Pi session JSONL file path (for restart resume) |
| `delivery_cursor` | Last-processed channel event id (dedup + gap detection) |
| `pending_calls` | Promise continuations for tool callMethod and UI feedback_form awaits |

That's it. Pi tracks turn state, message state, and session branching itself
inside `AgentSession`. The previous architecture's `harnesses`, `active_turns`,
`in_flight_turns`, `queued_turns`, `checkpoints`, and `turn_map` tables are
gone.

## Hermetic sandbox

The worker constructs `DefaultResourceLoader` with explicit opt-outs — there
is no auto-discovery, extensions are wired inline by `PiRunner`:

```typescript
new DefaultResourceLoader({
  cwd: contextFolderPath,
  agentDir: piAgentDir,            // NatStack-managed sandbox dir
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  additionalSkillPaths: [/* workspace skill paths resolved via workspace RPC */],
  extensionFactories: [
    natstackApprovalGateFactory(...),
    natstackChannelToolsFactory(...),
    natstackAskUserFactory(...),
  ],
})
```

The workspace prompt (`workspace/meta/AGENTS.md`) and skill index are read via
the `workspace.*` RPC service and composed by `PiRunner` — not via Pi's
skill/extension auto-discovery.

API keys are bridged via `AuthStorage.setRuntimeApiKey(provider, key)` —
priority #1 in Pi's auth resolution chain, ahead of any file-based auth.

## NatStack Pi extensions

Three extension factories supplied inline by the worker (closure-bound, not
Pi-package-portable). Live in `packages/harness/src/extensions/`:

- **`approval-gate.ts`** — `pi.on("tool_call", ...)` reads the approval level
  via a closure-bound getter. The worker can mutate the approval level
  mid-conversation; the extension picks it up on the next tool call.
- **`channel-tools.ts`** — Registers each channel participant's advertised
  methods as a Pi tool with the participant's bare method name. Tool names
  are deduped via the channel's enforced handle uniqueness. Reconciles on
  `session_start` and `turn_start`.
- **`ask-user.ts`** — Single `ask_user` tool that routes to a feedback_form
  on the channel via the worker callback.

The `NatStackExtensionUIContext` class
(`packages/harness/src/natstack-extension-context.ts`) implements Pi's
`ExtensionUIContext`. Each UI primitive (`select`, `confirm`, `input`,
`notify`, `setStatus`, etc.) routes through worker-supplied callbacks that
turn the request into a channel `feedback_form`, ephemeral notify, or
metadata-update event.

## Continuation plumbing

Tool callMethod and UI feedback_form awaits use a `pending_calls` SQL table
plus an in-memory `pendingResolvers` Map. When the worker dispatches a call
via `channel.callMethod(callerId, targetId, callId, method, args)`, it stores
a continuation and awaits a Promise. When the channel routes the result via
`onCallResult(callId, result, isError)`, the worker resolves (or rejects) the
Promise.

This is the bridge between Pi's synchronous-await tool API and the channel's
asynchronous fire-and-forget call/result protocol.

## Workspace layout

Skills and the agent system prompt live under `workspace/` and are
read via the `workspace.*` RPC service:

```
workspace/
├── meta/
│   ├── AGENTS.md        # Workspace system prompt content
│   └── natstack.yml     # Init panels and workspace config
└── skills/              # Workspace skills (sandbox, paneldev, onboarding, etc.)
    └── ...
```

Extensions are NatStack-only and live in `packages/harness/src/extensions/`
as TypeScript modules supplied inline (closure-bound to the worker). There
is no workspace-level extensions directory — chat behavior is intrinsically
NatStack-bound.

## Package map

| Package | Location | Contents |
|---------|----------|----------|
| `@natstack/harness` | `packages/harness/` | `PiRunner`, `NatStackExtensionUIContext`, three extension factories, channel boundary types |
| `@natstack/pubsub` | `workspace/packages/pubsub/` | PubSubClient (panel-side), protocol types |
| `@workspace/runtime` | `workspace/packages/runtime/` | DurableObjectBase, HttpRpcBridge |
| `@workspace/agentic-do` | `workspace/packages/agentic-do/` | AgentWorkerBase, ChannelClient, ContinuationStore, SubscriptionManager |
| `@workspace/agentic-core` | `workspace/packages/agentic-core/` | EphemeralEventEnvelope, derivePiSnapshot, derived UI types, ConnectionManager |
| `@workspace/agentic-chat` | `workspace/packages/agentic-chat/` | usePiSessionSnapshot, usePiTextDeltas, useChatCore (Pi-native) |
| `@workspace/agentic-session` | `workspace/packages/agentic-session/` | HeadlessSession (Pi-native programmatic interface) |
| Workers | `workspace/workers/` | AiChatWorker, TestAgentWorker (both extend AgentWorkerBase) |

## Further reading

- **Pi-architecture deep dive**: `docs/pi-architecture.md`
- **Pi SDK reference**: `node_modules/@mariozechner/pi-coding-agent/README.md`
- **Worker authoring**: `workspace/workers/README.md`
- **Paneldev skill**: `workspace/skills/paneldev/WORKERS.md`

# Pi-Native NatStack: Deep Dive

## Why Pi runs in-process

Before this rearchitecture, NatStack used a 4-layer pipeline:

1. Panel (browser)
2. Channel DO (workerd, message routing)
3. Worker DO (workerd, turn lifecycle SQL state)
4. **Harness child process** (Node.js, AI SDK adapter)

The harness layer existed because the workerd runtime couldn't host the
Anthropic SDK. The DO orchestrated turn lifecycle and forwarded events back
and forth via WebSocket-RPC to the harness child.

After Pi research (`@mariozechner/pi-coding-agent`), it became clear that
Pi's `AgentSession` could run inside the worker DO directly:

- Pi has no workerd-incompatible deps in its core path
- Pi's `AgentSession` owns its own state (messages, sessions, branching,
  compaction, retries) — no DO-side state machine needed
- Pi's extension API is rich enough to handle approval gates, channel-tools
  routing, and ask_user via inline factory functions

The harness child layer became unnecessary substrate. Phase 3 of this
rearchitecture deleted ~9000 lines of harness/transport/adapter/worker-state
code and replaced it with one PiRunner per channel.

## ContextFolder layout

Each panel context gets its own folder under `~/.config/natstack/contexts/`
with a copy of the workspace tree. The `.pi/` subdirectory is the canonical
Pi package:

```
<contextFolder>/
├── .pi/
│   ├── package.json     # Pi package manifest
│   ├── AGENTS.md        # System prompt (Pi loads via cwd-walk)
│   ├── settings.json    # Compaction / retry / thinking-level defaults
│   └── skills/          # Workspace skills (Pi loads via additionalSkillPaths)
│       ├── eval/
│       ├── sandbox/
│       ├── paneldev/
│       └── ...
├── workspace/...        # Other workspace files
└── ...
```

The contextFolderManager copies `workspace/.pi/` into each contextFolder
automatically because `.pi` is not in its `SKIP_DIRS` allowlist.

## The three NatStack extensions

All three live in `packages/harness/src/extensions/` as TypeScript modules
that export factory functions. The worker supplies them inline via
`extensionFactories` on `DefaultResourceLoader` — they are closure-bound to
the worker and not Pi-package-portable.

### 1. approval-gate.ts

```typescript
export function createApprovalGateExtension(deps: ApprovalGateDeps): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const level = deps.getApprovalLevel();
      if (level === 2) return undefined;                              // full auto
      if (level === 1 && deps.safeToolNames.has(event.toolName)) return undefined;
      if (!ctx.hasUI) return { block: true, reason: "no UI for approval" };
      const allowed = await ctx.ui.confirm("Allow tool call?", `Tool: ${event.toolName}`);
      return allowed ? undefined : { block: true, reason: "User denied" };
    });
  };
}
```

The approval level is read **lazily on every tool call** via the
`getApprovalLevel` closure. The worker can mutate the level mid-conversation
just by calling `runner.setApprovalLevel(newLevel)` — no extension reload.

### 2. channel-tools.ts

Registers each channel participant's advertised methods as Pi tools with
**bare method names** (no `pubsub_<id>_<method>` prefix). Tool name
collisions are prevented at the channel level: `channel-do.ts` rejects any
subscribe whose participant handle is already in use by another participant.

The extension reconciles on `session_start` and `turn_start`. Tools are
registered idempotently (Pi's `registerTool` is `Map.set` under the hood);
removed tools stay registered but are hidden from the LLM via
`pi.setActiveTools` excluding them from the active set.

The execute function is **closure-captured** with the worker's `callMethod`
callback:

```typescript
execute: async (_toolCallId, params, signal) => {
  const current = deps.getRoster().find((m) => m.name === captured.name);
  if (!current) return { content: [...], isError: true }; // tool removed mid-turn
  const result = await deps.callMethod(current.participantHandle, captured.name, params, signal);
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }], details: undefined };
}
```

This only works because Pi runs in-process inside the worker — the closure
reaches back into the worker's channel client. Standalone Pi cannot use this
extension and that's by design.

### 3. ask-user.ts

Single `ask_user` tool that routes to a feedback_form on the channel via the
worker's `askUser` callback. Used when the LLM needs free-text input from the
user that's not available via any other tool.

## NatStackExtensionUIContext

Pi's `ExtensionUIContext` interface has primitives like `select`, `confirm`,
`input`, `notify`, `setStatus`, `setWidget` — designed for a TUI. NatStack
implements them all (`packages/harness/src/natstack-extension-context.ts`)
by routing to worker callbacks that send channel events:

| Pi UI primitive | NatStack channel mapping |
|---|---|
| `select(title, options)` | `feedback_form` with segmented field, await result |
| `confirm(title, message)` | `feedback_form` with yes/no buttons, await result |
| `input(title, placeholder)` | `feedback_form` with textarea, await result |
| `editor(title, prefill)` | `feedback_form` with multi-line textarea, await result |
| `notify(message, type)` | Ephemeral message with `contentType: "notify:<type>"` |
| `setStatus(key, text)` | Ephemeral with `contentType: "natstack-ext-status"` |
| `setWidget(key, content)` | Ephemeral with `contentType: "natstack-ext-widget"` |
| `setHeader/Footer/Title` | No-op (TUI-only) |
| `custom(factory)` | Throws (TUI-only) |
| Theme accessors | Stub returns (TUI-only) |

The await primitives (`select`, `confirm`, `input`, `editor`) use the same
continuation Promise plumbing as `callMethod`: send a `channel.callMethod`
to a panel participant with the call id, store a continuation, await the
result via `onCallResult`.

## PiRunner

`packages/harness/src/pi-runner.ts` is the worker's wrapper around Pi's
`createAgentSession`. Lifecycle:

1. **Init**: build `AuthStorage`, push API keys via `setRuntimeApiKey`,
   resolve the model via `resolveModelToPi("provider:model")`, build a
   `SessionManager` (open existing JSONL or create new), build a hermetic
   `DefaultResourceLoader` with the three extension factories, call
   `createAgentSession`, bind the UI context.
2. **Subscribe**: forward Pi `AgentSessionEvent` to listeners.
3. **Run a turn**: `session.prompt(content, { images })`. While streaming,
   subsequent user messages can `steer` the agent.
4. **Fork**: `session.fork(entryId)` calls `sessionManager.createBranchedSession`
   internally and switches to the new file. The cloned worker boots a fresh
   PiRunner with `resumeSessionFile` pointing at the new path.
5. **Dispose**: `session.dispose()` releases listeners.

## How fork works

A panel forks at a specific message. The chat panel calls
`worker.canFork()` then `worker.postClone(parentObjectKey, newChannelId, oldChannelId, forkPointMessageId)`.

The cloned worker:
1. Inherits the parent's SQLite via cloneDO
2. Migrates the parent's `pi_sessions` row from `oldChannelId` to `newChannelId`
3. Resubscribes to the new channel
4. On the next user message, lazily constructs a fresh `PiRunner` with
   `resumeSessionFile = parentSessionFile` (or a forked one if the user
   asked to branch from a specific entry — handled via Pi's `fork()` call)

## How to add a new extension

1. Create a new file in `packages/harness/src/extensions/` exporting a
   factory function: `export function createMyExtension(deps): ExtensionFactory`
2. Add the dependency interface (closure-bound callbacks the worker provides)
3. Inside the factory, use `pi.on(eventType, handler)`, `pi.registerTool(...)`,
   etc. to wire up your behavior
4. Add an entry in `PiRunner.init()` constructing your factory with the
   appropriate worker callbacks
5. If you need new UI primitives, add callbacks to `NatStackUIBridgeCallbacks`
   and wire them in `AgentWorkerBase.buildUICallbacks`

## How to add a new skill

1. Create a directory under `workspace/.pi/skills/<skill-name>/`
2. Add a `SKILL.md` file with frontmatter (`name`, `description`)
3. Add additional markdown docs the agent can load
4. Ship — the skill is part of the workspace, copied into every contextFolder
   automatically, and Pi loads it via `additionalSkillPaths` in the resource
   loader.

## How to debug Pi events at the worker boundary

The `PiRunner.subscribe(listener)` API gives you raw Pi events:

```typescript
runner.subscribe((event) => {
  console.log("[debug]", event.type, event);
});
```

The worker's default behavior forwards a subset to the channel as ephemeral
streams. To inspect the event flow, log inside `forwardPiEvent` in
`agent-worker-base.ts` or attach a second listener via `runner.subscribe()`.

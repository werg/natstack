# @natstack/harness

In-process Pi runtime for the NatStack agent worker DO.

This package wraps `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`
("Pi") for use inside NatStack's agentic Durable Objects. It provides:

- **`PiRunner`** — Worker DO companion class that owns one Pi `Agent`
  per channel. Constructs tools via the workerd-compatible RuntimeFs bridge,
  loads system prompt and skills via workspace.* RPC, registers the
  three NatStack extension factories, bridges API keys via
  `setRuntimeApiKey`, and exposes `runTurn` / `steer` / `interrupt` / `fork`
  / `getStateSnapshot`.
- **NatStack extension factories** (`extensions/{approval-gate,channel-tools,ask-user}.ts`)
  — Pi extensions supplied inline via `extensionFactories`. Closure-bound to
  the worker, NOT Pi-package-portable.
- **`NatStackExtensionUIContext`** — Implements Pi's `ExtensionUIContext`
  interface, routing UI primitives (`select`, `confirm`, `notify`, `setStatus`,
  …) through worker callbacks that send channel feedback_form / ephemeral
  events.
- **Channel boundary types** (`types.ts`) — `ChannelEvent`, `Attachment`,
  `SendMessageOptions`, `TurnInput`, `ParticipantDescriptor`, `TurnUsage`.

## Architecture

Before this package's rewrite, NatStack used a 4-layer pipeline with a Node.js
child process running the Anthropic SDK. That layer is gone. Pi runs
in-process inside the worker DO, the agent worker imports `PiRunner`
directly, and the chat UI consumes Pi state via two ephemeral channel streams
(`natstack-state-snapshot` + `natstack-text-delta`).

See `docs/pi-architecture.md` for the deep dive.

## Public exports

```typescript
import {
  PiRunner,
  type PiRunnerOptions,
  type PiStateSnapshot,
  type ThinkingLevel,

  // Extension factories
  createApprovalGateExtension,
  DEFAULT_SAFE_TOOL_NAMES,
  type ApprovalLevel,
  type ApprovalGateDeps,

  createChannelToolsExtension,
  type ChannelToolMethod,
  type ChannelToolsDeps,

  createAskUserExtension,
  type AskUserParams,
  type AskUserQuestion,
  type AskUserDeps,

  // UI bridge
  NatStackExtensionUIContext,
  type NatStackUIBridgeCallbacks,

  // Channel boundary types
  type Attachment,
  type ChannelEvent,
  type SendMessageOptions,
  type TurnInput,
  type TurnUsage,
  type ParticipantDescriptor,
  type UnsubscribeResult,
} from "@natstack/harness";
```

## Adding a new extension

1. Create `src/extensions/<name>.ts` exporting a factory function:
   ```typescript
   export function createMyExtension(deps: MyDeps): ExtensionFactory {
     return (pi) => {
       pi.on("tool_call", async (event) => { /* ... */ });
     };
   }
   ```
2. Add it to `PiRunner.init()`'s `extensionFactories` list with the
   appropriate worker callbacks.
3. Add unit tests with a mock `ExtensionAPI` (see `extensions/approval-gate.test.ts`).

## Tests

```bash
pnpm vitest run packages/harness/
```

Covers all three extension factories and the UI context bridge.

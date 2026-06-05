# Custom Message Types

Register a custom React renderer with a channel, then publish typed message
instances against it. The channel persists registry and instances as typed
agentic events, so replay, fork, and pagination preserve the same view.

Use this when a built-in message shape doesn't fit — a weather card, a build
status badge, a sensor readout, a domain-specific decision tile. Use
[`inline_ui`](INLINE_UI.md) when you just need a one-shot React component in
the transcript; use a custom message type when many instances of the same
shape will be published and updated over time.

## Concepts

A custom message type has two halves:

1. A **registration** scoped to the channel — a `typeId`, a display mode, and a
   sandbox source (file path or inline code) that compiles to a renderer module.
2. **Instances** — `custom.started` (with an optional initial state) plus zero
   or more `custom.updated` events that fold into the rendered state.

The reducer in the renderer module decides how updates merge. If absent, the
last update wins.

### Module shape

The compiled module may export:

| Export    | Purpose                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `default` | Required. React component receiving `{ typeId, state, expanded, displayMode, chat, scope, scopes }`. Render compact inline content when `expanded` is false and the full view when `expanded` is true. |
| `Pill`    | Optional. A dedicated component for the collapsed inline view (`expanded === false`). When present it renders the bead and `default` only renders the expanded card. Same props as `default`.          |
| `reduce`  | Optional. `(state, update) => nextState`. Folds `custom.updated` payloads. Default: last update replaces state. A throwing reducer is caught — the prior state is kept and folding continues.          |
| `schema`  | Optional. A state validator: either a function `(state) => string[] \| string \| null` (return messages on failure, empty/null when valid) or a Zod-like object with `.safeParse(state)`.              |

### Schema validation

If the module exports `schema`, folded state is validated against it at the
panel before the component renders. On failure the card shows a compact
validation callout instead of handing bad state to the component (it never
crashes the transcript). Validation runs at the render boundary only — never in
the channel reducer — so it stays out of replay/fold determinism.

The registration may instead carry `schemaSourceOrPath` (a `SandboxSource` or a
bare file-path string) when the validator lives in its own module; it is
compiled with the registration's `imports`, and the module's `schema` (or its
default export) becomes the validator. A module-level `schema` export wins when
both are present.

### Display modes

| Mode       | Rendering                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `"inline"` | Bead inside the sender's message group with `expanded: false`. Click to expand the full card with `expanded: true`. |
| `"row"`    | Full chat row, like a normal message. Card renders the component with `expanded: true`.                             |

`displayMode` on the registration is the default. Each instance can override
via `displayMode` on `publishCustomMessage` / `custom.started`.

## From panel or worker code (PubSubClient)

Code holding a `PubSubClient` (panels, workers, headless sessions via
`manager.client`) uses the typed helpers:

```typescript
import type { PubSubClient } from "@workspace/pubsub";

await client.registerMessageType({
  typeId: "weather",
  displayMode: "inline",
  source: { type: "file", path: "panels/chat/examples/weather-message-type.tsx" },
});

const { messageId } = await client.publishCustomMessage({
  typeId: "weather",
  initialState: { city: "San Francisco", tempF: 64, condition: "Cloudy" },
});

await client.updateCustomMessage(messageId, { tempF: 66, condition: "Clearing" });

// Later, retire the type:
await client.clearMessageType("weather");
```

The `source` is either `{ type: "file", path }` or `{ type: "code", code }`
(inline TSX). `imports` accepts the same shape as `eval` / `inline_ui`
(`{ "@pkg": "npm:^1.2.3" }` or workspace refs).

File paths are **workspace-root-relative with no `workspace/` prefix** — the
panel resolves them inside its context, whose root mirrors the workspace root
(`skills/…`, `panels/…`, `packages/…`). Use `panels/chat/examples/foo.tsx`, not
`workspace/panels/chat/examples/foo.tsx` (the latter resolves to a non-existent
`<context>/workspace/…` and fails with ENOENT). This matches the action-bar file
convention. The file must exist in the panel's context: it is copied from the
working tree (uncommitted included) when the context is first created, so a file
added to an already-open context's repo only appears in a freshly created
context (or after the repo is re-synced).

Cleared types are tombstoned at a sequence — re-registering re-activates the
typeId without resurrecting previously cleared instances. Pagination and
out-of-order replay preserve latest-write-wins semantics; registry merges are
seq-aware and idempotent.

Lookup helpers:

```typescript
const all = await client.getMessageTypes();
const weather = await client.getMessageType("weather");
```

See the working example in:

- `workspace/panels/chat/examples/weather-message-type.tsx` — the renderer (default, `reduce`).
- `workspace/panels/chat/examples/weather-message-demo.ts` — registers + publishes + updates.

## From sandbox code (eval / inline_ui / action_bar / feedback_custom)

The `chat` sandbox value exposes the same typed registry + instance helpers as a
`PubSubClient`. Register once, then publish and update instances:

```ts
const typeId = "weather";

// 1. Register the renderer (once per channel; safe to re-register — a fresh
//    registration bumps the seq and reloads the source).
await chat.registerMessageType({
  typeId,
  displayMode: "inline",
  source: { type: "file", path: "panels/chat/examples/weather-message-type.tsx" },
  // imports: { "@radix-ui/themes": "npm:^3.2.1" }, // for file modules outside a radix package
});

// 2. Publish and update instances.
const { messageId } = await chat.publishCustomMessage({
  typeId,
  initialState: { city: "San Francisco", tempF: 64, condition: "Cloudy" },
  displayMode: "inline",
});
await chat.updateCustomMessage(messageId, { tempF: 66, condition: "Clearing" });

// 3. Look up or retire the type.
const all = await chat.getMessageTypes();
const weather = await chat.getMessageType(typeId);
await chat.clearMessageType(typeId);
```

> Advanced: `registerMessageType` / `clearMessageType` are thin wrappers over
> typed `messageType.registered` / `messageType.cleared` agentic events. You can
> still hand-build those via `chat.publish(AGENTIC_EVENT_PAYLOAD_KIND, event)` if
> you need full control, but prefer the helpers above.

## Authoring the renderer module

The module file is loaded into the chat sandbox by the channel — same
compilation pipeline as `inline_ui`. Imports follow the
[sandbox import rules](SKILL.md#available-imports): workspace packages auto-
resolve, npm packages need `imports: { "pkg": "npm:^x.y.z" }` on the
registration, and file-loaded modules infer bare imports from the nearest
`package.json`.

Relative imports work, so you can split a renderer across sibling files:
`import { fmt } from "./helpers.js"` resolves to `helpers.ts`/`.tsx` (the
written `.js` extension maps to the TS source), and `import type { Foo } from
"./types.js"` is erased — the type-only module is never fetched into the
context, so a shared types file needs no runtime presence. Value relative
imports must exist in the panel's context like the renderer itself.

```tsx
// workspace/panels/chat/examples/weather-message-type.tsx
import { Badge, Card, Flex, Text } from "@radix-ui/themes";

interface WeatherState {
  city: string;
  tempF: number;
  condition: string;
}
type WeatherUpdate = Partial<WeatherState>;

export function reduce(state: WeatherState, update: WeatherUpdate): WeatherState {
  return { ...state, ...update };
}

export default function WeatherMessage({
  state,
  expanded,
}: {
  state: WeatherState;
  expanded: boolean;
}) {
  if (!expanded) {
    return (
      <Flex align="center" gap="1">
        <Text size="1" weight="medium">
          {state.city}
        </Text>
        <Text size="1" color="gray">
          {state.tempF}F
        </Text>
      </Flex>
    );
  }

  return (
    <Card>
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="3">
          <Text size="3" weight="bold">
            {state.city}
          </Text>
          <Badge color="blue" variant="soft">
            {state.condition}
          </Badge>
        </Flex>
        <Text size="6" weight="bold">
          {state.tempF}F
        </Text>
      </Flex>
    </Card>
  );
}
```

Rules:

- `export default` is required. Without it the card renders an error.
- Inline messages should render pill-sized content when `expanded` is false.
  The host owns expansion state and swaps the same message into an expanded
  card when selected.
- Collapsed inline messages are a click/keyboard-to-expand surface. Interactive
  controls inside collapsed content may bubble and expand the message; call
  `event.stopPropagation()` in those controls if they need independent behavior.
- The component must be pure with respect to `state` — updates re-render via
  the reducer fold. Don't keep authoritative state in component-local refs;
  publish a `custom.updated` event instead.
- Treat `chat`, `scope`, and `scopes` like any other sandbox handle — call
  `chat.publish` / `chat.callMethod` from event handlers when you need to send
  events back to the channel.
- The module is recompiled when `updatedAtSeq` advances (re-registration).
  Keep the module pure so identical re-registrations produce stable output.

### `scope` / `scopes` semantics

Each render receives the live panel REPL `scope` (shared mutable object) and the
`scopes` persistence handle — the same ones `eval` and `inline_ui` see. Two
rules follow:

- **Authoritative, replayable data must live in the message `state`, not in
  `scope`.** `scope` is panel-local and ephemeral: it is empty after reload and
  on observer panels / replay, so a card that reads its data from `scope` will
  render blank there. Embed what the card needs in `initialState` / updates
  (bounded — the channel persists every byte). Use `scope` only for live,
  best-effort enrichment that may be absent.
- To persist interaction state across reloads, call `scopes.push()` (or publish
  a `custom.updated`); do not keep authoritative state in component refs.

## Reducer semantics

- Updates are applied in channel sequence order. The reducer must be
  deterministic and commutative-safe across replay.
- If `reduce` is not exported, the latest `custom.updated` payload replaces
  the prior state wholesale.
- `initialState` is used as the fold seed (or as the displayed state when
  there are no updates and no reducer).

## Caveats

- Workspace source is built from published git refs, not the working tree. If
  the module lives in a workspace repo, call `git.publishWorkspaceRepo` or the
  workspace-dev `commitAndPush` wrapper before the channel can load it. (Same
  constraint as eval imports — see SKILL.md.)
- Custom messages are panel-rendered. Headless sessions receive the events
  but won't materialize React output.
- Don't reuse a `typeId` for unrelated shapes — registry updates are
  latest-write-wins on `typeId`, and old instances will re-render through the
  new module.

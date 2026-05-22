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

| Export | Purpose |
|--------|---------|
| `default` | Required. React component receiving `{ typeId, state, expanded, displayMode, chat, scope, scopes }`. Render compact inline content when `expanded` is false and the full view when `expanded` is true. |
| `reduce` | Optional. `(state, update) => nextState`. Folds `custom.updated` payloads. Default: last update replaces state. |
| `schema` | Optional. Reserved for validation metadata. |

### Display modes

| Mode | Rendering |
|------|-----------|
| `"inline"` | Bead inside the sender's message group with `expanded: false`. Click to expand the full card with `expanded: true`. |
| `"row"` | Full chat row, like a normal message. Card renders the component with `expanded: true`. |

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
  source: { type: "file", path: "workspace/panels/chat/examples/weather-message-type.tsx" },
});

const { messageId } = await client.publishCustomMessage({
  typeId: "weather",
  initialState: { city: "San Francisco", tempF: 64, condition: "Cloudy" },
});

await client.updateCustomMessage(messageId, { tempF: 66, condition: "Clearing" });

// Later, retire the type:
await client.clearMessageType("weather");
```

The `source` is either `{ type: "file", path }` (context-relative) or
`{ type: "code", code }` (inline TSX). `imports` accepts the same shape as
`eval` / `inline_ui` (`{ "@pkg": "npm:^1.2.3" }` or workspace refs).

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

## From sandbox code (eval / inline_ui / feedback_custom)

The `chat` sandbox value exposes `publish` but not the typed registry helpers.
Publish the raw agentic events through `chat.publish("agentic.trajectory.v1/event", event)`:

```ts
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";

const typeId = "weather";

// 1. Register the renderer (once per channel; safe to re-register).
await chat.publish(AGENTIC_EVENT_PAYLOAD_KIND, {
  kind: "messageType.registered",
  actor: { kind: "agent", id: "agent" },
  payload: {
    protocol: "agentic.trajectory.v1",
    typeId,
    displayMode: "inline",
    source: { type: "file", path: "workspace/panels/chat/examples/weather-message-type.tsx" },
  },
  createdAt: new Date().toISOString(),
});

// 2. Publish an instance. Generate the messageId so updates can target it.
const messageId = crypto.randomUUID();
await chat.publish(AGENTIC_EVENT_PAYLOAD_KIND, {
  kind: "custom.started",
  actor: { kind: "agent", id: "agent" },
  causality: { messageId },
  payload: {
    protocol: "agentic.trajectory.v1",
    messageId,
    typeId,
    initialState: { city: "San Francisco", tempF: 64, condition: "Cloudy" },
  },
  createdAt: new Date().toISOString(),
});

// 3. Stream updates against the same messageId.
await chat.publish(AGENTIC_EVENT_PAYLOAD_KIND, {
  kind: "custom.updated",
  actor: { kind: "agent", id: "agent" },
  causality: { messageId },
  payload: {
    protocol: "agentic.trajectory.v1",
    messageId,
    update: { tempF: 66, condition: "Clearing" },
  },
  createdAt: new Date().toISOString(),
});
```

Clearing a type:

```ts
await chat.publish(AGENTIC_EVENT_PAYLOAD_KIND, {
  kind: "messageType.cleared",
  actor: { kind: "agent", id: "agent" },
  payload: { protocol: "agentic.trajectory.v1", typeId: "weather" },
  createdAt: new Date().toISOString(),
});
```

## Authoring the renderer module

The module file is loaded into the chat sandbox by the channel — same
compilation pipeline as `inline_ui`. Imports follow the
[sandbox import rules](SKILL.md#available-imports): workspace packages auto-
resolve, npm packages need `imports: { "pkg": "npm:^x.y.z" }` on the
registration, and file-loaded modules infer bare imports from the nearest
`package.json`.

```tsx
// workspace/panels/chat/examples/weather-message-type.tsx
import { Badge, Card, Flex, Text } from "@radix-ui/themes";

interface WeatherState { city: string; tempF: number; condition: string }
type WeatherUpdate = Partial<WeatherState>;

export function reduce(state: WeatherState, update: WeatherUpdate): WeatherState {
  return { ...state, ...update };
}

export default function WeatherMessage({ state, expanded }: { state: WeatherState; expanded: boolean }) {
  if (!expanded) {
    return (
      <Flex align="center" gap="1">
        <Text size="1" weight="medium">{state.city}</Text>
        <Text size="1" color="gray">{state.tempF}F</Text>
      </Flex>
    );
  }

  return (
    <Card>
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="3">
          <Text size="3" weight="bold">{state.city}</Text>
          <Badge color="blue" variant="soft">{state.condition}</Badge>
        </Flex>
        <Text size="6" weight="bold">{state.tempF}F</Text>
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

## Reducer semantics

- Updates are applied in channel sequence order. The reducer must be
  deterministic and commutative-safe across replay.
- If `reduce` is not exported, the latest `custom.updated` payload replaces
  the prior state wholesale.
- `initialState` is used as the fold seed (or as the displayed state when
  there are no updates and no reducer).

## Caveats

- Workspace source is built from git, not the working tree. If the module
  lives under `workspace/`, **commit and push** before the channel can load
  it. (Same constraint as eval imports — see SKILL.md.)
- Custom messages are panel-rendered. Headless sessions receive the events
  but won't materialize React output.
- Don't reuse a `typeId` for unrelated shapes — registry updates are
  latest-write-wins on `typeId`, and old instances will re-render through the
  new module.

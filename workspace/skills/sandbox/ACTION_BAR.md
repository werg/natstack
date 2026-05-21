# Action Bar

Use `load_action_bar` for compact UI that should stay visible at the top of
the current chat panel, above chat history and below the chat header. It is
best for small workflow controls, current status, pinned next actions, and
short-lived command palettes.

`load_action_bar` is panel-local. It does not write a visible chat message, but
it does publish a typed durable UI event so the transcript system and agent can
observe that an action bar was loaded or cleared. Other panels may have
different filesystem contexts, so always treat the rendered action bar as
belonging only to the panel that exposes the tool.

## File Format

Create a context-relative TSX file that default-exports a React component. The
component receives the same bindings as `inline_ui`:

```tsx
export default function ActionBar({ props = {}, chat, scope, scopes }) {
  // ...
}
```

Available imports are the same as `inline_ui`: `react`, `@radix-ui/themes`,
`@radix-ui/react-icons`, and preloaded workspace/runtime modules already
available in the panel. Static relative imports from the action-bar file are
supported for local helpers/components. Bare package imports are inferred from
the nearest `package.json` when possible; use `imports` for explicit package
versions. Package-local aliases from `package.json` `imports` and simple
`tsconfig.json` paths are supported.

Keep the component compact. The chat panel defaults to a 180px maximum height,
keeps overflow scrollable, and shows a resize handle when content reaches the
height cap. User resizing updates the panel's `actionBarMaxHeight` state arg for
file-backed action bars.

## Load Or Replace

```ts
load_action_bar({
  path: ".natstack/action-bars/review.tsx",
  props: { mode: "review" },
  maxHeight: 220
})
```

The panel reads the file from its current filesystem context, compiles it, and
renders it at the top of the chat. Calling `load_action_bar` again replaces the
previous action bar for that panel.

## Clear

```ts
load_action_bar({ clear: true })
```

## Initial Panel State

Chat panels can be opened with an initial action bar via state args:

```ts
{
  actionBarFile: ".natstack/action-bars/review.tsx",
  actionBarProps: { mode: "review" }
}
```

When a panel loads or clears an action bar, the host records a typed
`ui.action_bar.updated` event in the PubSub channel log. The event is not a chat
bubble, but it is part of the canonical transcript data used by the panel and
agent. Do not create separate hidden context notes for action bars.

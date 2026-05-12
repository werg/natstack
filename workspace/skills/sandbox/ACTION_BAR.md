# Action Bar

Use `load_action_bar` for compact UI that should stay visible at the top of
the current chat panel, above chat history and below the chat header. It is
best for small workflow controls, current status, pinned next actions, and
short-lived command palettes.

`load_action_bar` is panel-local. It does not write a visible chat message and
does not affect other chat panels connected to the same channel. Other panels
may have different filesystem contexts, so always treat the loaded action bar
as belonging only to the panel that exposes the tool.

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
available in the panel. Relative imports from the action-bar file are not
supported yet.

Keep the component compact. The chat panel clamps the action bar to a small
scrollable area.

## Load Or Replace

```ts
load_action_bar({
  path: ".natstack/action-bars/review.tsx",
  props: { mode: "review" },
  maxHeight: 160
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
  actionBarProps: { mode: "review" },
  actionBarMaxHeight: 160
}
```

When a panel loads or clears an action bar, it records a hidden panel-local
context note so the agent knows the action bar exists and can naturally replace
or clear it later. This note is not rendered in chat history.

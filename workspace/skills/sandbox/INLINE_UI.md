# Inline UI

Use inline UI for persistent, rich components in the chat transcript. Use
`feedback_custom` instead when the agent must block until the user submits a
decision.

## When To Use It

Use a UI instead of plain text when the task has:

- Multiple steps the user can complete independently.
- Links or resources the user may open inside NatStack or externally.
- Progress, status, or retry states.
- Choices where a card, table, segmented control, or checklist is clearer than
  prose.

For one-shot approval/setup workflows, prefer `feedback_custom`; it returns a
structured result to the agent. For dashboards, previews, logs, or long-lived
assistants in the transcript, prefer `inline_ui`. For compact controls or
status that should remain pinned above chat history in the current panel, use
`load_action_bar` with a TSX file instead.

You can send raw TSX with `code`, or put the component in a context-relative
file and call `inline_ui({ path: ".natstack/ui/review.tsx", props: {...} })`.
File-loaded components support static relative imports from that file and infer
bare package imports from the nearest `package.json` when possible. Use
`imports` for explicit package versions. Package-local aliases from
`package.json` `imports` and simple `tsconfig.json` paths are supported.

Inline UI is persisted as a typed `ui.inline_rendered` event in the PubSub
channel log. Do not emulate it with `chat.publish("message", { contentType:
"inline_ui" })`; use the `inline_ui` tool so the transcript, replay, and agent
state all see the same canonical event.

## Component Rules

- Components must `export default`.
- Root with unframed layout such as `<Flex direction="column" gap="3" p="2">`.
- Do not wrap the entire component in a top-level card; the host already frames
  feedback components.
- Use Radix primitives from `@radix-ui/themes` and icons from
  `@radix-ui/react-icons`.
- Use `createBrowserPanel(url, { focus: true })` for internal browser-panel
  deep links.
- Use `openExternal(url)` for system-browser links. This is approval-gated.
- OAuth authorize URLs should use `openExternal(url, { expectedRedirectUri })`.

## Workflow Link Pattern

```tsx
import { Button, Flex, Text } from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { createBrowserPanel, openExternal } from "@workspace/runtime";

export default function LinkActions({ props = {} }) {
  const url = props.url ?? "https://console.cloud.google.com/apis/credentials";

  return (
    <Flex align="center" justify="between" gap="3" p="2" wrap="wrap">
      <Text size="2" weight="medium">{props.label ?? "Open setup page"}</Text>
      <Flex gap="2">
        <Button size="1" variant="soft" onClick={() => createBrowserPanel(url, { focus: true })}>
          <GlobeIcon /> Internal
        </Button>
        <Button size="1" variant="soft" onClick={() => openExternal(url)}>
          <OpenInNewWindowIcon /> External
        </Button>
      </Flex>
    </Flex>
  );
}
```

## Checklist Pattern

Use a checklist when the user must complete steps in another website or app.
Keep each item short and put links/buttons next to the item, not in a paragraph
below it.

```tsx
import { useState } from "react";
import { Badge, Box, Button, Checkbox, Flex, Text } from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { createBrowserPanel, openExternal } from "@workspace/runtime";

const steps = [
  ["project", "Create project", "https://console.cloud.google.com/projectcreate"],
  ["credentials", "Open credentials", "https://console.cloud.google.com/apis/credentials"],
];

export default function SetupChecklist() {
  const [done, setDone] = useState({});
  const count = steps.filter(([id]) => done[id]).length;

  return (
    <Flex direction="column" gap="3" p="2">
      <Flex justify="between" align="center">
        <Text size="2" weight="bold">Setup checklist</Text>
        <Badge variant="soft">{count}/{steps.length}</Badge>
      </Flex>
      {steps.map(([id, label, url]) => (
        <Box key={id} style={{ border: "1px solid var(--gray-6)", borderRadius: 8, padding: 10 }}>
          <Flex align="center" justify="between" gap="3" wrap="wrap">
            <Flex align="center" gap="2">
              <Checkbox checked={Boolean(done[id])} onCheckedChange={(checked) => setDone((prev) => ({ ...prev, [id]: checked === true }))} />
              <Text size="2">{label}</Text>
            </Flex>
            <Flex gap="2">
              <Button size="1" variant="soft" onClick={() => createBrowserPanel(url, { focus: true })}>
                <GlobeIcon /> Internal
              </Button>
              <Button size="1" variant="soft" onClick={() => openExternal(url)}>
                <OpenInNewWindowIcon /> External
              </Button>
            </Flex>
          </Flex>
        </Box>
      ))}
    </Flex>
  );
}
```

# Interaction Patterns

Choose the smallest interaction that gives the user real control.

## Use `eval`

Use `eval` for deterministic runtime work where no user choice is needed:

- Read workspace state.
- Run a typecheck or test.
- Create a project after the user has already approved the shape.
- Verify a credential or API response.

## Use `feedback_form`

Use `feedback_form` for small typed inputs:

- Pick one option from a list.
- Confirm a safe command.
- Enter a short label or numeric setting.

## Use `feedback_custom`

Use `feedback_custom` for setup and workflow UI when the agent must wait for
the result:

- Provider setup checklists.
- OAuth app creation walkthroughs.
- Browser/profile/data import choices.
- Any flow with deep links, progress, retry, or multiple completion states.

Use direct link buttons in the UI:

```tsx
import { Button, Flex, Text } from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { createBrowserPanel, openExternal } from "@workspace/runtime";

export default function SetupStep({ onSubmit }) {
  const url = "https://console.cloud.google.com/apis/credentials";
  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">Open the credentials page</Text>
      <Flex gap="2">
        <Button size="1" variant="soft" onClick={() => createBrowserPanel(url, { focus: true })}>
          <GlobeIcon /> Internal
        </Button>
        <Button size="1" variant="soft" onClick={() => openExternal(url)}>
          <OpenInNewWindowIcon /> External
        </Button>
      </Flex>
      <Button onClick={() => onSubmit({ opened: true })}>Continue</Button>
    </Flex>
  );
}
```

## Use `inline_ui`

Use `inline_ui` for persistent display, not blocking handoff:

- Status dashboards.
- Rendered reports.
- Long-running workflow progress.
- Inspectable search or browser-import results.

## Browser Opens

- Internal browser panels: `createBrowserPanel(url, { focus: true })`
- System browser: `openExternal(url)`
- OAuth authorize URLs: `openExternal(url, { expectedRedirectUri })`

`openExternal` is approval-gated. Do not invent provider-specific browser-open
bridges.

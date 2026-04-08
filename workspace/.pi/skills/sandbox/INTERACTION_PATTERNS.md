# Interaction Patterns

Cross-skill guidance for how the agent should interact with users. All skills should follow these patterns.

## Side-Effect Actions: Inline UI with Feedback

When an action involves **side-effects** (imports, launches, deletions, syncs, deployments, workspace switches) AND involves **complexity or choice** (multiple options, configuration, multi-step flows), the agent should render an **inline UI** that lets the user navigate the choices and trigger the action themselves — rather than the agent executing it directly via `eval`.

### When to use this pattern

Use inline UI for side-effect actions when **any** of these apply:
- There are multiple options to choose from (which browser, which profile, which data types)
- The action is destructive or hard to reverse (delete, overwrite, switch workspace)
- The user might want to adjust parameters before executing
- The action could fail and the user should see the error in context
- The user may want to repeat or retry the action with different inputs

**Don't use this pattern** when:
- There's a single, obvious action with no choices (just use `eval`)
- The agent has already confirmed the exact action with the user via conversation
- The action is purely read-only (just use `eval` and show results)

### How it works

1. **Agent gathers data** via `eval` (e.g., detect browsers, list workspaces, scan files)
2. **Agent renders inline UI** with the data as `props`, presenting choices and action buttons
3. **User interacts** — selects options, clicks action buttons
4. **Component executes** the side-effect via `chat.rpc` or runtime APIs
5. **Component reports back** to the agent via `chat.publish("message", ...)` with results or errors

### The feedback loop

The critical part of this pattern is **step 5**: the inline UI must message results back to the conversation so the agent can react. This closes the loop — the agent knows what happened and can continue appropriately.

```tsx
// After a side-effect succeeds:
chat.publish("message", {
  content: "Imported 247 cookies from Chrome (Default profile). Auto-synced to browser session."
});

// After a side-effect fails:
chat.publish("message", {
  content: "Cookie import failed: TCC permission denied for Chrome. Grant Full Disk Access in System Settings > Privacy & Security."
});
```

### Template

```
inline_ui({
  code: `
import { useState } from "react";
import { Button, Flex, Text, Badge, Spinner } from "@radix-ui/themes";

export default function ActionWidget({ props, chat }) {
  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const handleAction = async (selectedOption) => {
    setStatus("running");
    setError(null);
    try {
      // Execute the side-effect
      const res = await chat.rpc.call("main", "service.method", ...args);
      setResult(res);
      setStatus("done");
      // Report success back to agent
      chat.publish("message", {
        content: "Action completed: " + JSON.stringify(res)
      });
    } catch (e) {
      setError(e.message);
      setStatus("error");
      // Report failure back to agent
      chat.publish("message", {
        content: "Action failed: " + e.message
      });
    }
  };

  return (
    <Flex direction="column" gap="2">
      {/* Choice UI — buttons, selects, etc. */}
      {props.options.map(opt => (
        <Button key={opt.id} disabled={status === "running"}
          onClick={() => handleAction(opt)}>
          {opt.label}
        </Button>
      ))}
      {/* Status indicators */}
      {status === "running" && <Flex align="center" gap="2"><Spinner size="1" /><Text size="1">Running...</Text></Flex>}
      {status === "done" && <Badge color="green" size="1">Done</Badge>}
      {error && <Text size="1" color="red">{error}</Text>}
    </Flex>
  );
}`,
  props: { options: gatheredData }
})
```

### Examples by skill

| Skill | Direct eval (no choice) | Inline UI (choice/complexity) |
|-------|------------------------|------------------------------|
| **browser-import** | Import cookies from the only available browser | Choose browser, profile, and data types to import |
| **paneldev** | Launch a panel the user just asked for by name | Pick which panel to launch from a list, or choose project type |
| **onboarding** | Show workspace contents | Choose which setup steps to run, pick a workspace to switch to |
| **sandbox** | Run a single eval snippet | Interactive file browser, SQL runner, cookie manager |

### Key principles

- **The user controls when side-effects happen** — the agent presents, the user triggers
- **Errors stay visible** — shown in the component AND messaged back to the agent
- **Success is reported** — the agent always knows what happened so it can continue the conversation
- **Components are persistent** — they stay in chat history for re-use (retry, adjust, repeat)
- **Keep it simple** — don't over-build the UI. A few buttons and a status indicator is usually enough

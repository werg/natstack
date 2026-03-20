# Feedback Forms

Block the agent until the user responds. Two variants: schema-based (simple forms) and custom (full React component).

## feedback_form (Schema-Based)

For standard forms with typed fields. No code needed.

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `title` | string | Form title |
| `fields` | FieldDefinition[] | Field definitions |
| `values` | Record | Pre-populated values |
| `submitLabel` | string | Submit button text (default: "Submit") |
| `cancelLabel` | string | Cancel button text (default: "Cancel") |
| `timeout` | number (ms) | Auto-action after timeout |
| `timeoutAction` | `"cancel" \| "submit"` | What happens on timeout |
| `severity` | `"info" \| "warning" \| "danger"` | Visual severity |
| `hideSubmit` | boolean | Hide submit button |
| `hideCancel` | boolean | Hide cancel button |

### Field Types

| Type | Extra Props | Description |
|------|------------|-------------|
| `string` | — | Text input |
| `number` | — | Number input |
| `boolean` | — | Checkbox |
| `select` | `options: { value, label }[]` | Dropdown |
| `slider` | `min`, `max` | Range slider |
| `segmented` | `options: { value, label }[]` | Segmented control |

### Field Definition

```typescript
{
  key: string;       // required — field identifier
  label: string;     // required — display label
  type: string;      // required — field type
  default?: unknown; // default value
  required?: boolean;
  description?: string;
}
```

### Result

```typescript
{ type: "submit", value: { fieldKey: userValue, ... } }
// or
{ type: "cancel" }
```

### Example

```
feedback_form({
  title: "Deployment Config",
  fields: [
    { key: "env", label: "Environment", type: "select", options: [
      { value: "staging", label: "Staging" },
      { value: "production", label: "Production" },
    ], required: true },
    { key: "replicas", label: "Replicas", type: "slider", min: 1, max: 10, default: 3 },
    { key: "dryRun", label: "Dry run", type: "boolean", default: true },
  ],
  severity: "warning",
  submitLabel: "Deploy",
})
```

## feedback_custom (React Component)

For complex interactions that schema-based forms can't express.

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `code` | string | TSX source code |
| `title` | string | Container header title |

### Component Contract

The component receives `{ onSubmit, onCancel, onError, chat }`:

```tsx
export default function MyForm({ onSubmit, onCancel, onError, chat }) {
  // onSubmit(value) — return data to the agent and close the form
  // onCancel() — signal cancellation
  // onError(message) — signal error
  // chat — ChatSandboxValue (publish, callMethod, rpc)
}
```

**Must use `export default`.**

### Rendering Context

The component renders inside a container Card with a header, scroll area, and resize handle. Do NOT wrap your component in a top-level Card. Use `<Flex direction="column" gap="3" p="2">` or similar as root.

### Result

```typescript
{ type: "submit", value: { ... } }  // whatever was passed to onSubmit()
// or
{ type: "cancel" }
// or
{ type: "error", message: "..." }
```

### Example — Simple Form

```
feedback_custom({
  code: `
import { useState } from "react";
import { Button, Flex, Text, TextField } from "@radix-ui/themes";

export default function NameForm({ onSubmit, onCancel }) {
  const [name, setName] = useState("");
  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">What is your name?</Text>
      <TextField.Root value={name} onChange={e => setName(e.target.value)} />
      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit({ name })} disabled={!name}>Submit</Button>
      </Flex>
    </Flex>
  );
}`,
  title: "Name Input"
})
```

### Example — Form with Runtime Access

```
feedback_custom({
  code: `
import { useState, useEffect } from "react";
import { Button, Flex, Text, Select } from "@radix-ui/themes";
import { createBrowserDataApi } from "@workspace/panel-browser";

export default function BrowserPicker({ onSubmit, onCancel, chat }) {
  const [browsers, setBrowsers] = useState([]);
  const [selected, setSelected] = useState("");
  const browserData = createBrowserDataApi(chat.rpc);

  useEffect(() => {
    browserData.detectBrowsers().then(setBrowsers);
  }, []);

  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">Select browser to import from</Text>
      <Select.Root value={selected} onValueChange={setSelected}>
        <Select.Trigger placeholder="Choose browser..." />
        <Select.Content>
          {browsers.map(b => (
            <Select.Item key={b.name} value={b.name}>{b.displayName} ({b.profiles.length} profiles)</Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit({ browser: selected, profiles: browsers.find(b => b.name === selected)?.profiles })} disabled={!selected}>
          Import
        </Button>
      </Flex>
    </Flex>
  );
}`,
  title: "Browser Import"
})
```

# Inline UI

Render persistent interactive React components inline in the chat. Components stay in the message history — users can interact with them at any time.

## When to Use

- **Rich data presentation** — tables, charts, formatted output that plain text can't capture
- **User-triggered actions** — buttons/controls that let the user trigger side-effects (copy, open files, run scripts, apply changes) on demand
- **Persistent widgets** — components that remain useful across the conversation

**Contrast with other tools:**
- `eval`: Agent runs code now, gets result back. Use when the agent should act.
- `inline_ui`: Agent renders controls, user clicks when ready. Non-blocking.
- `feedback_form`/`feedback_custom`: Agent blocks until user responds. Use when the agent needs data back.

## Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | string | required | TSX source code for the component |
| `props` | `Record<string, unknown>` | `{}` | Data passed to the component as `{ props }` |

## Component Contract

The component receives `{ props, chat }`:

```tsx
export default function MyWidget({ props, chat }) {
  // props — the data you passed via the props parameter
  // chat — ChatSandboxValue for interacting with the conversation
}
```

**Must use `export default`** — named exports alone won't work.

## The `chat` Prop

Every inline UI component receives a `chat` object:

```typescript
interface ChatSandboxValue {
  publish(eventType: string, payload: unknown, options?: { persist?: boolean }): Promise<unknown>;
  callMethod(participantId: string, method: string, args: unknown): Promise<unknown>;
  contextId: string;
  channelId: string | null;
  rpc: { call: (target: string, method: string, ...args: unknown[]) => Promise<unknown> };
}
```

### Send a message to the conversation

```tsx
<Button onClick={() => chat.publish("message", { content: "User clicked deploy" })}>
  Deploy
</Button>
```

This appears as a chat message and can trigger agent responses.

### Call runtime services

```tsx
const handleReadFile = async () => {
  const content = await chat.rpc.call("main", "fs.readFile", "/src/config.ts", "utf-8");
  setFileContent(content);
};
```

### Import browser cookies

```tsx
import { browserData } from "@workspace/panel-browser";

export default function CookieImporter({ props, chat }) {
  const [browsers, setBrowsers] = useState([]);

  useEffect(() => {
    browserData.detectBrowsers().then(setBrowsers);
  }, []);

  const handleImport = async (browser) => {
    const result = await browserData.startImport({
      browser: browser.name,
      profile: browser.profiles[0] ?? browser.dataDir,
      dataTypes: ["cookies", "passwords"],
    });
    chat.publish("message", { content: `Imported: ${JSON.stringify(result)}` });
  };

  return (
    <Flex direction="column" gap="2">
      {browsers.map(b => (
        <Button key={b.name} onClick={() => handleImport(b)}>{b.displayName}</Button>
      ))}
    </Flex>
  );
}
```

## Available Imports

```tsx
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Button, Flex, Card, Text, Table, TextField, Select, Badge, Box, Spinner } from "@radix-ui/themes";
import { CopyIcon, CheckIcon, GearIcon, TrashIcon } from "@radix-ui/react-icons";
import { rpc, fs, db, workers, ai, openPanel, focusPanel, buildPanelLink, createBrowserPanel } from "@workspace/runtime";
import { browserData } from "@workspace/panel-browser";
```

## Lifecycle

- Component starts **expanded**
- Auto-collapses if rendered content exceeds 400px height
- Users can expand/collapse at any time
- **Persists in chat history** — survives page reloads (recompiled from source on display)

## Examples

### Data Table with Copy

```
inline_ui({
  code: `
import { useState } from "react";
import { Button, Flex, Table } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";

export default function DataTable({ props }) {
  const [copied, setCopied] = useState(false);
  return (
    <Flex direction="column" gap="2">
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            {props.columns.map(c => <Table.ColumnHeaderCell key={c}>{c}</Table.ColumnHeaderCell>)}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {props.data.map((row, i) => (
            <Table.Row key={i}>
              {props.columns.map(c => <Table.Cell key={c}>{row[c]}</Table.Cell>)}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <Button size="1" variant="soft" onClick={() => {
        navigator.clipboard.writeText(JSON.stringify(props.data, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}>
        {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy JSON</>}
      </Button>
    </Flex>
  );
}`,
  props: {
    columns: ["name", "status", "count"],
    data: [
      { name: "alpha", status: "active", count: 42 },
      { name: "beta", status: "pending", count: 7 },
    ]
  }
})
```

### File Browser with Chat Integration

```
inline_ui({
  code: `
import { useState, useEffect } from "react";
import { Button, Flex, Text, Box } from "@radix-ui/themes";
import { fs } from "@workspace/runtime";

export default function FileBrowser({ props, chat }) {
  const [files, setFiles] = useState([]);
  const [cwd, setCwd] = useState(props.startPath || "/");

  useEffect(() => {
    fs.readdir(cwd, { withFileTypes: true }).then(setFiles).catch(() => setFiles([]));
  }, [cwd]);

  return (
    <Flex direction="column" gap="1">
      <Text size="1" color="gray">{cwd}</Text>
      {cwd !== "/" && (
        <Text size="1" style={{ cursor: "pointer" }} onClick={() => setCwd(cwd.split("/").slice(0, -1).join("/") || "/")}>
          ..
        </Text>
      )}
      {files.map(f => (
        <Text key={f.name} size="1" style={{ cursor: "pointer" }}
          onClick={() => f.isDirectory?.() ? setCwd(cwd + "/" + f.name) : chat.publish("message", { content: "Please read: " + cwd + "/" + f.name })}>
          {f.isDirectory?.() ? "📁 " : "📄 "}{f.name}
        </Text>
      ))}
    </Flex>
  );
}`,
  props: { startPath: "/src" }
})
```

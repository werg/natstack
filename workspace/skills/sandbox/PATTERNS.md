# Common Patterns

Recipes for common tasks using the sandbox.

## Read a File and Display It

`fs` is injected into eval (context-scoped) — do not import it.

```
eval({ code: `
  const content = await fs.readFile("src/index.ts", "utf-8");
  console.log(content);
  return content;
` })
```

## List Directory Contents

```
eval({ code: `
  const entries = await fs.readdir("src", { withFileTypes: true });
  for (const e of entries) {
    console.log(e.isDirectory() ? "dir:  " + e.name : "file: " + e.name);
  }
` })
```

## Search Files for a Pattern

```
eval({ code: `
  async function grep(dir, pattern, results = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = dir + "/" + entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
          await grep(path, pattern, results);
        }
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        const content = await fs.readFile(path, "utf-8");
        const lines = content.split("\\n");
        lines.forEach((line, i) => {
          if (line.includes(pattern)) results.push({ path, line: i + 1, text: line.trim() });
        });
      }
    }
    return results;
  }

  const matches = await grep("src", "TODO");
  console.log(matches);
  return matches;
`
})
```

## Use an npm Package (lodash)

```
eval({
  code: `
    import _ from "lodash";
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
      { name: "Charlie", age: 35 },
    ];
    console.log("Grouped by age > 28:", _.groupBy(data, d => d.age > 28 ? "senior" : "junior"));
    console.log("Sorted by age:", _.sortBy(data, "age").map(d => d.name));
  `,
  imports: { "lodash": "npm:^4.17.21" }
})
```

## Use an npm Package (date-fns)

```
eval({
  code: `
    import { format, addDays, differenceInDays } from "date-fns";
    const today = new Date();
    const nextWeek = addDays(today, 7);
    console.log("Today:", format(today, "yyyy-MM-dd"));
    console.log("Next week:", format(nextWeek, "yyyy-MM-dd"));
    console.log("Days between:", differenceInDays(nextWeek, today));
  `,
  imports: { "date-fns": "npm:^3.6.0" }
})
```

## Use a Scoped npm Package (@faker-js/faker)

```
eval({
  code: `
    import { faker } from "@faker-js/faker";
    for (let i = 0; i < 5; i++) {
      console.log(faker.person.fullName(), "-", faker.internet.email());
    }
  `,
  imports: { "@faker-js/faker": "npm:^9.0.0" }
})
```

## npm Packages in Inline UI

> **Defensive coding:** When using `props` in inline UI components, always default the parameter (`{ props = {}, chat }`) and guard property access (`props?.items ?? []`). For small datasets, embedding constants directly in the component source is simpler and more portable than passing `props`.

`eval` runs server-side (in the `EvalDO`) and `inline_ui` compiles in the chat
panel — they have **separate module registries**, so preloading a package in
`eval` does NOT make it available to `inline_ui`. To use a non-default npm
package in a component, put the component in a context-relative file and declare
the dependency in the nearest `package.json` (the panel infers file-loaded
imports), or avoid the dependency by embedding the small bit of logic directly.

```ts
// Component lives in a file whose nearest package.json lists "lodash";
// the panel resolves the import when it compiles the file.
inline_ui({ path: ".natstack/ui/shuffler.tsx", props: { items: ["Apple", "Banana", "Cherry"] } })
```

```tsx
// .natstack/ui/shuffler.tsx
import { useState } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import _ from "lodash";

export default function Shuffler({ props = {} }) {
  const [items, setItems] = useState(props.items ?? []);
  return (
    <Flex direction="column" gap="2">
      <Button size="1" onClick={() => setItems(_.shuffle([...items]))}>Shuffle</Button>
      {items.map((item, i) => <Text key={i} size="2">{item}</Text>)}
    </Flex>
  );
}
```

For larger eval/UI code, prefer writing a context-relative file and using the
tool's `path` parameter. Static relative imports from that file are resolved,
and bare package imports are inferred from the nearest `package.json` when
possible:

```ts
eval({ path: ".natstack/eval/audit.ts" })
inline_ui({ path: ".natstack/ui/audit-panel.tsx", props: { runId } })
feedback_custom({ path: ".natstack/ui/confirm-audit.tsx", title: "Confirm audit" })
```

## Call an API with a URL-bound credential

The general pattern: store a URL-bound credential once, then fetch through the
runtime credential proxy.

The `credentials.fetch(url, init, { credentialId })` wrapper (which returns a
`Response`) is part of the portable runtime surface from `@workspace/runtime`;
it works from server-side eval, panels, workers, and DOs. In eval, import
`credentials` from `@workspace/runtime` and use `credentials.fetch` for external
requests that need stored credentials:

```tsx
import { credentials } from "@workspace/runtime";

const credential = await credentials.store({
  label: "Notion",
  audience: [{ url: "https://api.notion.com", match: "origin" }],
  injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
  material: { type: "bearer-token", token },
});

const response = await credentials.fetch("https://api.notion.com/v1/search", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  },
  body: JSON.stringify({ query: "meeting notes" }),
}, { credentialId: credential.id });
const results = await response.json();
```

See [RUNTIME_API.md](RUNTIME_API.md) for the full credentials surface (`store`,
`connect`, `fetch`, `listStoredCredentials`, …). Works with any configured
provider; check `await credentials.listStoredCredentials()` to see what's
available.

## Request Access to a Custom Userland Resource

Use `approvals.request()` only when custom userland code owns a shared resource
and needs to grant another panel, worker, DO, or extension access to it. NatStack
verifies the issuer, shows the user a shell consent prompt, and manages any
remembered decision for the same issuer and stable `subject.id`.

Do not use this for normal agent work such as creating, editing, appending, or
removing files in the caller's context. The outer runtime/host permission model
already protects sensitive filesystem, browser, credential, git, and panel
operations where approval is required.

`approvals.request`/`approvals.revoke` come from the portable runtime surface
(`@workspace/runtime`) and bind to the live caller's verified issuer identity.
They work from server-side eval, panels, workers, and DOs:

```tsx
import { approvals } from "@workspace/runtime";

const decision = await approvals.request({
  subject: { id: "demo-report-service:send", label: "Report sending service" },
  title: "Allow report service access?",
  summary: "A custom report service wants to let this caller send reports through its shared backend.",
});

console.log(decision);
```

The default prompt lets the user allow once, allow for the current session,
trust the current code version, or deny. If you need a custom choice set, opt
into `promptOptions: "choices"`:

```tsx
import { approvals } from "@workspace/runtime";

const decision = await approvals.request({
  subject: { id: "demo-report-service:send", label: "Report sending service" },
  title: "Allow report service access?",
  summary: "A custom report service wants to let this caller send reports through its shared backend.",
  promptOptions: "choices",
  options: [
    { value: "allow", label: "Send", tone: "primary" },
    { value: "deny", label: "Cancel", tone: "danger" },
  ],
});

console.log(decision);
```

If the user dismisses the prompt, the result is `{ kind: "dismissed" }` and no
grant is stored. To forget a stored decision:

```tsx
import { approvals } from "@workspace/runtime";
await approvals.revoke("demo-report-service:send");
```

Do not use this for credentials, external browser opens, git writes, or project
imports; those built-in APIs have their own trust scopes. See
[RUNTIME_API.md](RUNTIME_API.md#userland-approval-prompts) for the full contract.

## Browser data (cookies/passwords/bookmarks/history/tabs)

`browserData` from `@workspace/panel-browser` is a **panel/component runtime**
capability: it goes through the `@workspace-extensions/browser-data` extension,
which only accepts **shell** callers. Server-side eval (caller kind `server`)
cannot use it — run browser-data work from panel code or an
`inline_ui`/`feedback_custom` component:

```tsx
import { browserData } from "@workspace/panel-browser";

const browsers = await browserData.detectBrowsers();
const chrome = browsers.find((b) => b.name === "chrome");
if (chrome) {
  const defaultProfile = chrome.profiles.find((p) => p.isDefault) || chrome.profiles[0];
  const result = await browserData.startImport({
    browser: "chrome",
    profile: defaultProfile,
    dataTypes: ["cookies", "bookmarks", "history"],
  });
  console.log("Import result:", result);

  // Optional: recreate current source-browser HTTP(S) tabs as NatStack panels.
  const opened = await browserData.openTabsAsPanels({
    browser: "chrome",
    profile: defaultProfile,
  });
  console.log("Opened tabs:", opened);
}

// Export everything:
const dump = await browserData.exportAll();
```

`startImport` is incremental for the same browser/profile: reruns update changed
source records and add newly discovered records without duplicating bookmarks,
history visits, cookies, passwords, autofill values, search engines,
permissions, or favicons. `openTabsAsPanels()` is intentionally not idempotent;
it creates panels each time it is called.

## Interactive Cookie Manager (Inline UI)

```
inline_ui({
  code: `
import { useState, useEffect } from "react";
import { Button, Flex, Text, Table, Badge, TextField } from "@radix-ui/themes";
import { TrashIcon } from "@radix-ui/react-icons";
import { browserData } from "@workspace/panel-browser";

export default function CookieManager({ props, chat }) {
  const [cookies, setCookies] = useState([]);
  const [filter, setFilter] = useState("");

  const load = () => browserData.getCookies(filter || undefined).then(setCookies);
  useEffect(() => { load(); }, [filter]);

  const handleDelete = async (id) => {
    await browserData.deleteCookie(id);
    load();
  };

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2" align="center">
        <TextField.Root placeholder="Filter by domain..." value={filter} onChange={e => setFilter(e.target.value)} style={{ flex: 1 }} />
      </Flex>
      <Text size="1" color="gray">{cookies.length} cookies</Text>
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Domain</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Expires</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {cookies.slice(0, 50).map(c => (
            <Table.Row key={c.id}>
              <Table.Cell><Text size="1">{c.domain}</Text></Table.Cell>
              <Table.Cell><Text size="1">{c.name}</Text></Table.Cell>
              <Table.Cell><Text size="1" color="gray">{c.expiration_date ? new Date(c.expiration_date * 1000).toLocaleDateString() : "session"}</Text></Table.Cell>
              <Table.Cell>
                <Button size="1" variant="ghost" color="red" onClick={() => handleDelete(c.id)}>
                  <TrashIcon />
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}`,
  props: {}
})
```

## Query a Database and Show Results

```
inline_ui({
  code: `
import { useState, useCallback } from "react";
import { Button, Flex, Text, Table, Code } from "@radix-ui/themes";

export default function SqlRunner({ props, chat }) {
  const [sql, setSql] = useState(props.defaultQuery || "SELECT 1");
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const run = useCallback(async () => {
    setError(null);
    try {
      // "main" must expose a db.query method backed by a Durable Object's this.sql.
      const result = await chat.rpc.call("main", "db.query", [sql]);
      setRows(result);
    } catch (e) { setError(e.message); }
  }, [sql]);

  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];

  return (
    <Flex direction="column" gap="2">
      <textarea value={sql} onChange={e => setSql(e.target.value)}
        style={{ fontFamily: "monospace", fontSize: 12, padding: 8, borderRadius: 4, border: "1px solid var(--gray-6)", minHeight: 60 }} />
      <Button size="1" onClick={run}>Run Query</Button>
      {error && <Text size="1" color="red">{error}</Text>}
      {rows.length > 0 && (
        <Table.Root size="1">
          <Table.Header>
            <Table.Row>{cols.map(c => <Table.ColumnHeaderCell key={c}>{c}</Table.ColumnHeaderCell>)}</Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.slice(0, 100).map((row, i) => (
              <Table.Row key={i}>{cols.map(c => <Table.Cell key={c}><Text size="1">{String(row[c])}</Text></Table.Cell>)}</Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
    </Flex>
  );
}`,
  props: { dbName: "default", defaultQuery: "SELECT name FROM sqlite_master WHERE type='table'" }
})
```

## Open a Website and Import Its Cookies

`openPanel` works from server-side eval, panels, workers, and DOs. `browserData`
goes through the browser-data extension, so this combined cookie-import recipe
still runs from panel code or an `inline_ui`/`feedback_custom` component:

```tsx
import { openPanel } from "@workspace/runtime";
import { browserData } from "@workspace/panel-browser";

// Open the site in a browser panel
const handle = await openPanel("https://github.com");

// Import cookies from Chrome for that domain
const browsers = await browserData.detectBrowsers();
const chrome = browsers.find((b) => b.name === "chrome");
if (chrome) {
  await browserData.startImport({
    browser: "chrome",
    profile: chrome.profiles[0] ?? chrome.dataDir,
    dataTypes: ["cookies"],
  });
  // Electron syncs imported cookies to browser panels automatically.
  // Repeat imports are safe; unchanged cookies are not duplicated.
}
```

# Common Patterns

Recipes for common tasks using the sandbox.

## Read a File and Display It

```
eval({ code: `
  import { fs } from "@workspace/runtime";
  const content = await fs.readFile("/src/index.ts", "utf-8");
  console.log(content);
  return content;
` })
```

## List Directory Contents

```
eval({ code: `
  import { fs } from "@workspace/runtime";
  const entries = await fs.readdir("/src", { withFileTypes: true });
  for (const e of entries) {
    console.log(e.isDirectory() ? "dir:  " + e.name : "file: " + e.name);
  }
` })
```

## Search Files for a Pattern

```
eval({ code: `
  import { fs } from "@workspace/runtime";

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

  const matches = await grep("/src", "TODO");
  console.log(matches);
  return matches;
`, timeout: 30000 })
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
  imports: { "lodash": "npm:^4.17.21" },
  timeout: 30000
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
  imports: { "date-fns": "npm:^3.6.0" },
  timeout: 30000
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
  imports: { "@faker-js/faker": "npm:^9.0.0" },
  timeout: 30000
})
```

## Preload npm Package for Inline UI

> **Defensive coding:** When using `props` in inline UI components, always default the parameter (`{ props = {}, chat }`) and guard property access (`props?.items ?? []`). For small datasets, embedding constants directly in the component source is simpler and more portable than passing `props`.

npm packages aren't directly available in `inline_ui`. Preload via `eval` first — the module stays in the module map:

```
// Step 1: preload
eval({
  code: `import _ from "lodash"; console.log("lodash loaded");`,
  imports: { "lodash": "npm:^4.17.21" },
  timeout: 30000
})

// Step 2: use in inline_ui (lodash is now in the module map)
inline_ui({
  code: `
import { useState } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import _ from "lodash";

export default function Shuffler({ props }) {
  const [items, setItems] = useState(props.items);
  return (
    <Flex direction="column" gap="2">
      <Button size="1" onClick={() => setItems(_.shuffle([...items]))}>Shuffle</Button>
      {items.map((item, i) => <Text key={i} size="2">{item}</Text>)}
    </Flex>
  );
}`,
  props: { items: ["Apple", "Banana", "Cherry", "Date", "Elderberry"] }
})
```

## Call an API with a URL-bound credential

The general pattern: store a URL-bound credential once, then fetch through the runtime credential proxy.

```
eval({
  code: `
    import { credentials } from "@workspace/runtime";

    const credential = await credentials.store({
      label: "Notion",
      audience: [{ url: "https://api.notion.com", match: "origin" }],
      injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
      material: { type: "bearer-token", token: process.env.NOTION_TOKEN! },
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
    for (const page of results.results ?? []) {
      if (page.object === "page") {
        console.log("-", page.properties?.Name?.title?.[0]?.text?.content ?? page.id);
      }
    }
  `,
  timeout: 60000
})
```

Works with any configured provider. Check `await credentials.listConnections()` to see what's available.

## Import Cookies from Chrome

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const browsers = await browserData.detectBrowsers();
  const chrome = browsers.find(b => b.name === "chrome");
  if (!chrome) { console.log("Chrome not found"); return; }
  console.log("Profiles:", chrome.profiles.map(p => p.displayName));
  const defaultProfile = chrome.profiles.find(p => p.isDefault) || chrome.profiles[0];
  const result = await browserData.startImport({
    browser: "chrome",
    profile: defaultProfile,
    dataTypes: ["cookies"],
  });
  console.log("Import result:", result);
  return result;
`, timeout: 60000 })
```

## Export All Browser Data

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const dump = await browserData.exportAll();
  console.log("Exported " + dump.length + " bytes");
  return JSON.parse(dump);
`, timeout: 30000 })
```

## Sync Cookies to Browser Session

Cookies are auto-synced after `startImport`. Use this to re-sync after manual changes, or to sync only a specific domain:

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const result = await browserData.syncCookiesToSession("github.com");
  console.log("Synced:", result.synced, "Failed:", result.failed);
` })
```

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

  const handleSync = async () => {
    const result = await browserData.syncCookiesToSession(filter || undefined);
    chat.publish("message", { content: "Synced " + result.synced + " cookies to session" });
  };

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2" align="center">
        <TextField.Root placeholder="Filter by domain..." value={filter} onChange={e => setFilter(e.target.value)} style={{ flex: 1 }} />
        <Button size="1" onClick={handleSync}>Sync to Session</Button>
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
  const [handle, setHandle] = useState(null);

  const run = useCallback(async () => {
    setError(null);
    try {
      const h = handle || await chat.rpc.call("main", "db.open", props.dbName || "default");
      if (!handle) setHandle(h);
      const result = await chat.rpc.call("main", "db.query", h, sql);
      setRows(result);
    } catch (e) { setError(e.message); }
  }, [sql, handle]);

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

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";
  import { browserData } from "@workspace/panel-browser";

  // Open the site in a browser panel
  const handle = await createBrowserPanel("https://github.com");
  console.log("Opened browser panel");

  // Import cookies from Chrome for that domain
  const browsers = await browserData.detectBrowsers();
  const chrome = browsers.find(b => b.name === "chrome");
  if (chrome) {
    await browserData.startImport({
      browser: "chrome",
      profile: chrome.profiles[0] ?? chrome.dataDir,
      dataTypes: ["cookies"],
    });
    // Sync to the browser session
    await browserData.syncCookiesToSession("github.com");
    console.log("Cookies synced — reload the browser panel to use them");
  }
`, timeout: 60000 })
```

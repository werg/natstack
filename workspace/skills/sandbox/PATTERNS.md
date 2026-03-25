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
  console.log(JSON.stringify(matches, null, 2));
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

## Import Cookies from Chrome

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const browserData = createBrowserDataApi(rpc);
  const browsers = await browserData.detectBrowsers();
  const chrome = browsers.find(b => b.name === "chrome");
  if (!chrome) { console.log("Chrome not found"); return; }
  console.log("Profiles:", chrome.profiles.map(p => p.displayName));
  const defaultProfile = chrome.profiles.find(p => p.isDefault) || chrome.profiles[0];
  const result = await browserData.startImport({
    browser: "chrome",
    profilePath: defaultProfile.path,
    dataTypes: ["cookies"],
  });
  console.log("Import result:", JSON.stringify(result, null, 2));
  return result;
`, timeout: 60000 })
```

## Export All Browser Data

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const browserData = createBrowserDataApi(rpc);
  const dump = await browserData.exportAll();
  console.log("Exported " + dump.length + " bytes");
  return JSON.parse(dump);
`, timeout: 30000 })
```

## Sync Cookies to Browser Session

After importing cookies, sync them to the active browser session so they're used by browser panels:

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const browserData = createBrowserDataApi(rpc);
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
import { createBrowserDataApi } from "@workspace/panel-browser";

export default function CookieManager({ props, chat }) {
  const [cookies, setCookies] = useState([]);
  const [filter, setFilter] = useState("");
  const browserData = createBrowserDataApi(chat.rpc);

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
              <Table.Cell><Text size="1">{c.host}</Text></Table.Cell>
              <Table.Cell><Text size="1">{c.name}</Text></Table.Cell>
              <Table.Cell><Text size="1" color="gray">{c.expiry ? new Date(c.expiry * 1000).toLocaleDateString() : "session"}</Text></Table.Cell>
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

## Ask User to Pick a Model, Then Generate Text

```
// Step 1: feedback_form to pick model
feedback_form({
  title: "AI Generation",
  fields: [
    { key: "model", label: "Model", type: "select", options: [
      { value: "fast", label: "Fast (Haiku)" },
      { value: "balanced", label: "Balanced (Sonnet)" },
      { value: "powerful", label: "Powerful (Opus)" },
    ] },
    { key: "prompt", label: "Prompt", type: "string", required: true },
  ]
})

// Step 2: eval to generate (using the result from step 1)
eval({ code: `
  import { ai } from "@workspace/runtime";
  const result = await ai.generateText({
    model: "fast",
    messages: [{ role: "user", content: "Tell me a joke" }],
  });
  console.log(result);
  return result;
`, timeout: 30000 })
```

## Open a Website and Import Its Cookies

```
eval({ code: `
  import { createBrowserPanel, rpc } from "@workspace/runtime";
  import { createBrowserDataApi } from "@workspace/panel-browser";

  // Open the site in a browser panel
  const handle = await createBrowserPanel("https://github.com");
  console.log("Opened browser panel");

  // Import cookies from Chrome for that domain
  const browserData = createBrowserDataApi(rpc);
  const browsers = await browserData.detectBrowsers();
  const chrome = browsers.find(b => b.name === "chrome");
  if (chrome) {
    await browserData.startImport({
      browser: "chrome",
      profilePath: chrome.profiles[0]?.path ?? chrome.dataDir,
      dataTypes: ["cookies"],
    });
    // Sync to the browser session
    await browserData.syncCookiesToSession("github.com");
    console.log("Cookies synced — reload the browser panel to use them");
  }
`, timeout: 60000 })
```

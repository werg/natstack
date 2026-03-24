# End-to-End Workflows

Composable recipes. The agent should adapt these dynamically based on what the user asks — combining discovery, import, management, and verification steps as needed. These are building blocks, not rigid scripts.

## Guiding Principles

- **Ask before acting** — use `feedback_form` or `feedback_custom` to confirm browser/profile/data type choices
- **Show progress** — stream console output during imports, publish status messages
- **Verify results** — after importing cookies, open a browser panel to confirm authentication works
- **Leave management UIs** — render persistent `inline_ui` widgets so the user can continue managing data after the agent finishes
- **Handle errors gracefully** — TCC blocks, missing profiles, master passwords, empty results

## Workflow: Full Import → Verify

The most common flow: import cookies from a browser and verify authentication. Cookies are automatically synced to the browser session after import — browser panels get them immediately.

### Step 1: Discover and ask

```
feedback_custom({
  title: "Import Browser Data",
  code: `... import wizard from DISCOVERY.md ...`
})
// → returns { browser, profilePath, dataTypes }
```

### Step 2: Import

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const api = createBrowserDataApi(rpc);

  const results = await api.startImport({
    browser: "${selection.browser}",
    profilePath: "${selection.profilePath}",
    dataTypes: ${JSON.stringify(selection.dataTypes)},
  });

  for (const r of results) {
    console.log((r.success ? "✅" : "❌") + " " + r.dataType + ": " + r.itemCount + " items");
  }
  return results;
`, timeout: 60000 })
```

### Step 3: Verify in browser panel

Cookies were auto-synced during import — just open a browser panel and check.

```
eval({ code: `
  import { createBrowserPanel } from "@workspace/runtime";
  import { connect } from "@workspace/playwright-client";

  // Open target site — imported cookies are already in the browser session
  const handle = await createBrowserPanel("https://github.com");
  const browser = await connect(await handle.getCdpEndpoint(), "chromium", {});
  const page = browser.contexts()[0]?.pages()[0];

  if (page) {
    await page.waitForLoadState("networkidle");
    const avatar = await page.locator("img.avatar").count();
    console.log(avatar > 0 ? "✅ Logged in to GitHub!" : "❌ Not logged in");
  }
`, timeout: 30000 })
```

### Step 4: Leave management UI

```
inline_ui({
  code: `... cookie manager from COOKIES.md ...`,
  props: { domain: "github.com" }
})
```

## Workflow: Import for a Specific Site

User asks "import my GitHub cookies" — targeted flow.

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const api = createBrowserDataApi(rpc);

  // Find a browser with cookies for this domain
  const browsers = await api.detectBrowsers();
  const available = browsers.filter(b => !b.tccBlocked && b.profiles.length > 0);

  if (available.length === 0) {
    console.log("No accessible browsers found");
    return null;
  }

  // Import from the first available browser's default profile
  const browser = available[0];
  const profile = browser.profiles.find(p => p.isDefault) || browser.profiles[0];
  console.log("Importing cookies from", browser.displayName, "—", profile.displayName);

  await api.startImport({
    browser: browser.name,
    profilePath: profile.path,
    dataTypes: ["cookies"],
  });

  // Check if we got GitHub cookies (auto-synced to browser session during import)
  const cookies = await api.getCookies("github.com");
  console.log("Found", cookies.length, "GitHub cookies (auto-synced to browser session)");

  return { browser: browser.displayName, profile: profile.displayName, cookieCount: cookies.length };
`, timeout: 60000 })
```

## Workflow: Cross-Browser Comparison

Compare what data exists across multiple browsers.

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const api = createBrowserDataApi(rpc);

  const browsers = await api.detectBrowsers();
  const comparison = [];

  for (const browser of browsers) {
    if (browser.tccBlocked) {
      comparison.push({ browser: browser.displayName, status: "blocked" });
      continue;
    }
    for (const profile of browser.profiles) {
      // Import everything to count items
      const results = await api.startImport({
        browser: browser.name,
        profilePath: profile.path,
        dataTypes: ["cookies", "passwords", "bookmarks", "history"],
      });
      comparison.push({
        browser: browser.displayName,
        profile: profile.displayName,
        data: Object.fromEntries(results.map(r => [r.dataType, r.itemCount])),
      });
    }
  }

  console.table(comparison.map(c => ({
    Browser: c.browser,
    Profile: c.profile || "—",
    Cookies: c.data?.cookies ?? "—",
    Passwords: c.data?.passwords ?? "—",
    Bookmarks: c.data?.bookmarks ?? "—",
    History: c.data?.history ?? "—",
  })));

  return comparison;
`, timeout: 120000 })
```

Then show as inline UI:

```
inline_ui({
  code: `
import { Table, Text, Badge } from "@radix-ui/themes";

export default function ComparisonTable({ props }) {
  return (
    <Table.Root size="1">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeaderCell>Browser</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Profile</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Cookies</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Passwords</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Bookmarks</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>History</Table.ColumnHeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {props.data.map((row, i) => (
          <Table.Row key={i}>
            <Table.Cell><Text size="1" weight="medium">{row.browser}</Text></Table.Cell>
            <Table.Cell><Text size="1">{row.profile || "—"}</Text></Table.Cell>
            <Table.Cell>{row.data?.cookies != null ? <Badge size="1">{row.data.cookies}</Badge> : <Text size="1" color="gray">—</Text>}</Table.Cell>
            <Table.Cell>{row.data?.passwords != null ? <Badge size="1">{row.data.passwords}</Badge> : <Text size="1" color="gray">—</Text>}</Table.Cell>
            <Table.Cell>{row.data?.bookmarks != null ? <Badge size="1">{row.data.bookmarks}</Badge> : <Text size="1" color="gray">—</Text>}</Table.Cell>
            <Table.Cell>{row.data?.history != null ? <Badge size="1">{row.data.history}</Badge> : <Text size="1" color="gray">—</Text>}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}`,
  props: { data: comparisonResult }
})
```

## Workflow: Export Everything

Dump all imported data for backup or migration.

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc, fs } from "@workspace/runtime";
  const api = createBrowserDataApi(rpc);

  const dump = await api.exportAll();
  const path = "/exports/browser-data-" + new Date().toISOString().slice(0, 10) + ".json";
  await fs.mkdir("/exports", { recursive: true });
  await fs.writeFile(path, dump);
  console.log("Exported to", path, "(" + dump.length + " bytes)");
  return { path, size: dump.length };
`, timeout: 30000 })
```

## Adapting Dynamically

The agent should compose these building blocks based on what the user actually asks:

- **"Import my Chrome cookies"** → skip wizard, auto-detect Chrome, import cookies only, show cookie manager
- **"Set up GitHub authentication"** → import cookies (auto-synced) → open browser panel → verify login → leave cookie manager filtered to github.com
- **"What browsers do I have?"** → discovery only, show rich browser cards
- **"Show me my saved passwords"** → import passwords if not already imported → show password vault
- **"Import everything from Firefox"** → detect Firefox → import all types → show summary → leave managers for each type
- **"Compare my browsers"** → cross-browser comparison workflow → show table
- **"Export my bookmarks as HTML"** → targeted export, return the file

Monitor progress at each step. If an import fails (TCC block, missing profile, master password needed), explain the issue and offer alternatives. If the user asks to change course mid-flow, adapt — the tools are independent and composable.

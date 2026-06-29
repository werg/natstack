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
// → returns { browser, profile, dataTypes }
```

### Step 2: Import

```
eval({
  code: `
  import { browserData } from "@workspace/panel-browser";

  const results = await browserData.startImport({
    browser: "${selection.browser}",
    profile: "${selection.profile}",
    dataTypes: ${JSON.stringify(selection.dataTypes)},
  });

  for (const r of results) {
    console.log((r.success ? "✅" : "❌") + " " + r.dataType + ": " + r.itemCount + " items");
  }
  return results;
`
})
```

### Step 3: Verify in browser panel

Cookies were auto-synced during import — just open a browser panel and check.

`openPanel`/`panelTree` are part of the portable runtime surface from
`@workspace/runtime`; they work from server-side eval, panels, workers, and DOs.
The `handle.cdp.lightweightPage()` automation is workerd-native and runs over a
WebSocket to the panel's CDP endpoint, so a browser panel opened from eval can be
driven there directly:

```tsx
import { openPanel } from "@workspace/runtime";

// Open target site — imported cookies are already in the browser session
const handle = await openPanel("https://github.com");
const page = await handle.cdp.lightweightPage();

const title = await page.title();
console.log("Page title:", title);
const isLoggedIn = await page.evaluate(() =>
  document.querySelector("img.avatar") !== null
);
console.log(isLoggedIn ? "Logged in to GitHub!" : "Not logged in");
```

### Step 4: Leave management UI

```
inline_ui({
  code: `... cookie manager from COOKIES.md ...`,
  props: { domain: "github.com" }
})
```

## Workflow: Migrate Browser Life

Use this when the user wants NatStack to become their primary browser surface.
This pulls persistent browser data first, then recreates the source browser's
current open HTTP(S) tabs as NatStack child panels.

### Step 1: Discover and choose profile

Use `detectBrowsers()` or the discovery UI from [DISCOVERY.md](DISCOVERY.md).
Prefer passing the full `DetectedProfile` object returned by detection.

### Step 2: Import persistent data

```typescript
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const results = await browserData.startImport({
    browser: "${selection.browser}",
    profile: ${JSON.stringify(selection.profile)},
    dataTypes: [
      "cookies",
      "passwords",
      "bookmarks",
      "history",
      "autofill",
      "searchEngines",
      "permissions",
      "favicons",
    ],
  });

  return results;
` })
```

`startImport` is incremental for the same browser/profile. It is safe to run
again later; changed source rows update in place and new browser data is added.

### Step 3: Open current tabs as panels

```typescript
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const result = await browserData.openTabsAsPanels({
    browser: "${selection.browser}",
    profile: ${JSON.stringify(selection.profile)},
  });

  console.log("Opened " + result.panelsOpened + " of " + result.tabsFound + " tabs");
  if (result.skipped.length) {
    console.log("Skipped:\\n" + result.skipped.map(s => s.url + " - " + s.reason).join("\\n"));
  }
  return result;
` })
```

`openTabsAsPanels()` is an action, not a data import. Running it again opens
another set of panels.

### Step 4: Use unified address suggestions

No extra wiring is required. The address bar suggests from:

- currently open browser panels
- imported browser history
- NatStack-local browser-panel history
- bookmarks
- search engines

Imported history and NatStack-local panel visits share the same `BrowserDataDO`
history system.

## Workflow: Repeat Import Later

Use this when the user says "sync again", "pull in new data", or "rerun import".

```typescript
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const results = await browserData.startImport({
    browser: "${selection.browser}",
    profile: ${JSON.stringify(selection.profile)},
    dataTypes: ${JSON.stringify(selection.dataTypes)},
  });

  const summary = results.map(r =>
    r.dataType + ": " + r.itemCount + " scanned, " + r.skippedCount + " skipped"
  ).join("\\n");
  console.log(summary);
  return results;
` })
```

Do not clear stored browser data before a repeat import unless the user
explicitly asks. Repeat import is source-keyed and updates in place.

## Workflow: Import for a Specific Site

User asks "import my GitHub cookies" — targeted flow.

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  // Find a browser with cookies for this domain
  const browsers = await browserData.detectBrowsers();
  const available = browsers.filter(b => !b.tccBlocked && b.profiles.length > 0);

  if (available.length === 0) {
    console.log("No accessible browsers found");
    return null;
  }

  // Import from the first available browser's default profile
  const browser = available[0];
  const profile = browser.profiles.find(p => p.isDefault) || browser.profiles[0];
  console.log("Importing cookies from", browser.displayName, "—", profile.displayName);

  await browserData.startImport({
    browser: browser.name,
    profile,
    dataTypes: ["cookies"],
  });

  // Check if we got GitHub cookies (auto-synced to browser session during import)
  const cookies = await browserData.getCookies("github.com");
  console.log("Found", cookies.length, "GitHub cookies (auto-synced to browser session)");

  return { browser: browser.displayName, profile: profile.displayName, cookieCount: cookies.length };
`
})
```

## Workflow: Cross-Browser Comparison

Compare what data exists across multiple browsers.

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const browsers = await browserData.detectBrowsers();
  const comparison = [];

  for (const browser of browsers) {
    if (browser.tccBlocked) {
      comparison.push({ browser: browser.displayName, status: "blocked" });
      continue;
    }
    for (const profile of browser.profiles) {
      // Import everything to count items
      const results = await browserData.startImport({
        browser: browser.name,
        profile,
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
`
})
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

`exportAll()` reveals plaintext credentials, so it is **approval-gated**: the
first call from a panel/worker/eval prompts the user (and is remembered per the
scope they pick). It is no longer shell-only — any userland caller may invoke it
once approved. `fs` here is the injected eval/runtime filesystem — do not import it.

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const dump = await browserData.exportAll();
  const path = "/exports/browser-data-" + new Date().toISOString().slice(0, 10) + ".json";
  await fs.mkdir("/exports", { recursive: true });
  await fs.writeFile(path, dump);
  console.log("Exported to", path, "(" + dump.length + " bytes)");
  return { path, size: dump.length };
`
})
```

## Adapting Dynamically

The agent should compose these building blocks based on what the user actually asks:

- **"Import my Chrome cookies"** → skip wizard, auto-detect Chrome, import cookies only, show cookie manager
- **"Set up GitHub authentication"** → use the API provider/OAuth setup path directly (see `api-integrations` skill); import cookies only if the user also wants GitHub browser-session state
- **"What browsers do I have?"** → discovery only, show rich browser cards
- **"Show me my saved passwords"** → import passwords if not already imported → show password vault
- **"Import everything from Firefox"** → detect Firefox → import all types → show summary → leave managers for each type
- **"Move my browser life to NatStack"** → full persistent import → open current tabs as panels → explain unified address-bar suggestions
- **"Sync again" / "pull latest browser data"** → repeat `startImport` for the same profile; do not clear first
- **"Compare my browsers"** → cross-browser comparison workflow → show table
- **"Export my bookmarks as HTML"** → targeted export, return the file

Monitor progress at each step. If an import fails (TCC block, missing profile, master password needed), explain the issue and offer alternatives. If the user asks to change course mid-flow, adapt — the tools are independent and composable.

# Import

Run browser data imports and handle results.

## Basic Import (Eval)

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const results = await browserData.startImport({
    browser: "chrome",
    profile: "/home/user/.config/google-chrome/Default",
    dataTypes: ["cookies", "passwords", "bookmarks", "history"],
  });

  for (const r of results) {
    const status = r.success ? "✅" : "❌";
    console.log(status + " " + r.dataType + ": " + r.itemCount + " imported, " + r.skippedCount + " skipped");
    if (r.warnings.length > 0) console.log("  Warnings:", r.warnings.join("; "));
    if (r.error) console.log("  Error:", r.error);
  }
  return results;
`
})
```

## Import with Auto-Detection

Finds the default Chrome profile and imports from it:

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const browsers = await browserData.detectBrowsers();
  const chrome = browsers.find(b => b.name === "chrome");
  if (!chrome) { console.log("Chrome not found"); return null; }
  if (chrome.tccBlocked) { console.log("Chrome data blocked by macOS TCC — grant Full Disk Access"); return null; }

  const profile = chrome.profiles.find(p => p.isDefault) || chrome.profiles[0];
  if (!profile) { console.log("No profiles found"); return null; }

  console.log("Importing from", chrome.displayName, "—", profile.displayName);
  const results = await browserData.startImport({
    browser: "chrome",
    profile,  // pass the whole DetectedProfile object
    dataTypes: ["cookies", "passwords"],
  });

  return results;
`
})
```

## Firefox with Master Password

Firefox may encrypt passwords with a master password. Pass it via the `masterPassword` field:

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const results = await browserData.startImport({
    browser: "firefox",
    profile: "/home/user/.mozilla/firefox/abc123.default-release",
    dataTypes: ["passwords"],
    masterPassword: "user-provided-password",
  });

  return results;
`
})
```

To prompt the user for the master password first:

```
feedback_form({
  title: "Firefox Master Password",
  fields: [
    { key: "masterPassword", label: "Master Password", type: "string", required: true,
      description: "Firefox encrypts saved passwords with a master password" }
  ]
})
```

## Import from CSV (Chrome Password Export)

Chrome can export passwords to CSV. Import them:

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const results = await browserData.startImport({
    browser: "chrome",
    profile: "/path/to/chrome/profile",
    dataTypes: ["passwords"],
    csvPasswordFile: "/path/to/Chrome Passwords.csv",
  });

  return results;
`
})
```

## Two-Step Import: Ask Then Run

The agent first shows the import wizard (from DISCOVERY.md), receives the user's selection, then runs the import:

```
// Step 1: feedback_custom import wizard → returns { browser, profile, dataTypes }
// Step 2: eval with the result
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const results = await browserData.startImport({
    browser: "${selection.browser}",
    profile: "${selection.profile}",
    dataTypes: ${JSON.stringify(selection.dataTypes)},
  });

  // Report results back to chat
  const summary = results.map(r =>
    (r.success ? "✅" : "❌") + " " + r.dataType + ": " + r.itemCount + " items"
  ).join("\\n");
  await chat.publish("message", { content: "Import complete:\\n" + summary });

  return results;
`
})
```

## Import Audit Log

Check what's been imported before:

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const history = await browserData.getImportHistory();
  console.log(history);
  return history;
` })
```

## Browser History and Incremental Imports

Imported history and NatStack browser-panel navigations are stored in the same
history system. Imported browser visits keep per-visit timestamps when Chrome,
Firefox, or Safari expose them, and address-bar autocomplete ranks that unified
history with open browser panels, bookmarks, typed counts, visit counts, and
recency.

Imports are incremental. Re-running `startImport` for the same browser/profile
updates changed source records and adds newly discovered records without
duplicating bookmarks, history visits, cookies, passwords, autofill values,
search engines, permissions, or favicons. `getImportHistory()` still records
each import attempt as an audit log.

### Incremental Semantics

| Data | Re-run behavior |
|------|-----------------|
| `bookmarks` | Upserts by browser/profile source id when available; falls back to URL + folder. Renames and moves update in place. |
| `history` | Adds only new visit events for the same browser/profile; recomputes summary counts for autocomplete. |
| `cookies` | Upserts by name + domain + path; identical cookies do not refresh timestamps. |
| `passwords` | Upserts by origin + username + action URL + realm; identical plaintext secrets are not re-encrypted. |
| `autofill` | Upserts by field + value; `times_used` is the max source aggregate, not an additive delta. |
| `searchEngines` | Upserts by browser/profile source id when available; falls back to keyword + search URL. |
| `permissions` | Upserts by origin + permission; unchanged settings are left alone. |
| `favicons` | Upserts by URL; unchanged blobs are left alone. |

Actions that intentionally append/create:

- `getImportHistory()` returns the audit log, so every import attempt adds a row.
- `openTabsAsPanels()` creates panels and is not idempotent.

## Open Current Tabs as NatStack Panels

After choosing a browser/profile from `detectBrowsers()`, migrate the current
Firefox/Chrome-family HTTP(S) tabs into NatStack:

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const result = await browserData.openTabsAsPanels({
    browser: "chrome",
    profile: "/home/user/.config/google-chrome/Default",
  });

  console.log("Opened", result.panelsOpened, "of", result.tabsFound, "tabs");
  if (result.skipped.length) {
    console.log("Skipped:", result.skipped.map(s => s.url + " (" + s.reason + ")").join("\\n"));
  }
  return result;
` })
```

## Types

```typescript
interface ImportRequest {
  browser: string;           // "chrome" | "firefox" | "safari" | "edge" | "brave"
  profile: DetectedProfile | string;  // pass the profile object from detectBrowsers, or a path string
  dataTypes: string[];       // which data types to import
  masterPassword?: string;   // Firefox master password (if set)
  csvPasswordFile?: string;  // path to Chrome password CSV export
}

// startImport returns an ARRAY — one entry per requested dataType
interface ImportResult {
  dataType: string;          // "cookies" | "passwords" | "bookmarks" | "history" | ...
  success: boolean;
  itemCount: number;         // items successfully imported
  skippedCount: number;      // items skipped (duplicates, decryption failures, etc.)
  error?: string;
  warnings: string[];
}
```

### Handling results

```typescript
// ✅ Correct — iterate the array
const results = await browserData.startImport({ browser: "chrome", profile, dataTypes });
const summary = results.map(r =>
  `${r.success ? "✅" : "❌"} ${r.dataType}: ${r.itemCount} imported`
).join("\n");

// ❌ Wrong — results is NOT an object keyed by type
// importResult.cookies.imported  ← does not exist
```

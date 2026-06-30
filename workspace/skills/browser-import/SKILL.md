---
name: browser-import
description: Import browser data into the workspace — discover installed browsers, import cookies/passwords/bookmarks/history, manage and sync imported data.
---

# Browser Data Import Skill

Import and manage browser data (cookies, passwords, bookmarks, history) from installed browsers into the workspace. Includes rich interactive UIs for every step.

## Files

| Document | Content |
|----------|---------|
| [DISCOVERY.md](DISCOVERY.md) | Detect browsers, enumerate profiles, preview available data |
| [IMPORT.md](IMPORT.md) | Run imports, handle edge cases, review results |
| [COOKIES.md](COOKIES.md) | Cookie management — browse, search, delete, sync to session |
| [PASSWORDS.md](PASSWORDS.md) | Password vault — browse, search, reveal, copy |
| [BOOKMARKS.md](BOOKMARKS.md) | Bookmark browser — folder tree, search, open, export |
| [HISTORY.md](HISTORY.md) | Unified imported/local browser history, address-bar autocomplete, open tabs |
| [WORKFLOWS.md](WORKFLOWS.md) | End-to-end recipes — import-sync-verify, cross-browser merge |

## Interaction Patterns

See the sandbox skill's [INTERACTION_PATTERNS.md](../sandbox/INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. Browser import is a prime example: discovery can be eval, but the actual import (choosing browser, profile, data types) should be an inline UI that reports results back via `chat.publish`.

## Architecture

All browser data operations go through `@workspace/panel-browser`, which wraps RPC calls to `@workspace-extensions/browser-data` through `extensions.invoke`. The extension reads browser profile databases directly (SQLite for Chrome/Firefox, plist for Safari) and stores imported data in `BrowserDataDO`.

History is unified: imported Chrome/Firefox/Safari visits and NatStack browser-panel navigations both write visit events into `BrowserDataDO`. The address bar autocomplete reads the materialized `history` summary alongside open panels, bookmarks, and search engines. See [HISTORY.md](HISTORY.md).

Data imports are incremental for a given browser/profile: source-keyed records
upsert, aggregate source counts such as autofill do not inflate on repeat runs,
and only the import audit log appends every run.

```
Sandbox code (eval / inline_ui / feedback_custom)
  → import { browserData } from "@workspace/panel-browser"
    → rpc.call("main", "extensions.invoke", ["@workspace-extensions/browser-data", method, args])
      → browser-data extension
        → reads Chrome/Firefox/Safari profile databases
```

## Quick Reference

```typescript
// In eval, inline_ui, and feedback_custom:
import { browserData } from "@workspace/panel-browser";
```

| Method | What it does |
|--------|-------------|
| `browserData.detectBrowsers()` | Find installed browsers + profiles → `DetectedBrowser[]` |
| `browserData.startImport({ browser, profile, dataTypes })` | Incrementally import data from a browser profile → `ImportResult[]` (use `profile: detectedProfile` from detectBrowsers) |
| `browserData.previewImport({ browser, profile, dataTypes })` | **Dry run** — read + diff against the store without writing → per-type `{ scanned, added, changed, unchanged, skipped, samples }` |
| `browserData.getProfileImportState({ browser, profilePath })` | Last run + run history (scorecard inputs) for a profile |
| `browserData.getOpenTabs({ browser, profile })` | Preview currently open Firefox/Chrome-family tabs |
| `browserData.openTabsAsPanels({ browser, profile, selection? })` | Open current HTTP(S) tabs as child panels (`selection`: subset by `{windowIndex,tabIndex}`) |
| `browserData.getImportHistory()` | Past import runs (with per-type summaries) |
| `browserData.getCookieDomains()` / `getHistoryDomains()` / `getPasswordOrigins()` / `getAutofillFieldNames()` | **Ungated** secret-free aggregates (domains/origins/counts, no values) |
| `browserData.getDomainReadiness(domain)` | Booleans/counts: cookies + password + permissions + recent history present? (no values) |
| `browserData.getCookies(domain?)` / `getPasswords()` / `getHistory(query)` / `exportAll()` | **Approval-gated** — reveal raw values; prompts the caller once, then remembered |
| `browserData.getAutocompleteDebug(query)` | Ranked address-bar suggestions with reasons (approval-gated; returns URLs) |
| `browserData.getBookmarks(folder?)` / `searchBookmarks(query)` / `getSearchEngines()` / `getPermissions()` | Ungated reads |

**UI:** the `browser-import-inspector` panel (title "Browser Migration & State") is
the human-facing dashboard over these APIs — Migrate / Inspect / Debug tabs. This
skill remains the agent/headless path.

**Access model:** sensitive value reads, exports, and all modifying effects
(imports, writes, deletes, opening panels) are approval-gated for userland callers
(panel/worker/eval) — the first call prompts and the grant is remembered. The
desktop shell (history recorder, address bar) is trusted and never prompts.

## Data Types

| Type | Description | Sources |
|------|-------------|---------|
| `cookies` | HTTP cookies (session + persistent) | Chrome, Firefox, Safari, Edge, Brave |
| `passwords` | Saved login credentials | Chrome, Firefox (may need master password) |
| `bookmarks` | Bookmark folders + URLs | Chrome, Firefox, Safari |
| `history` | Browsing history with timestamps | Chrome, Firefox, Safari |
| `autofill` | Form autofill data | Chrome |
| `searchEngines` | Custom search engine configs | Chrome, Firefox |
| `permissions` | Site permission grants | Chrome |
| `settings` | Browser preferences | Chrome |
| `favicons` | Site icons | Chrome |

## Record Types

These are the actual field names returned by the API. **Use these exact fields** in UI code.

### Cookie (StoredCookie)

These are the actual columns returned by `getCookies()`. SQLite stores booleans as `0|1` integers.

```typescript
interface StoredCookie {
  id: number;
  name: string;
  value: string;
  domain: string;              // e.g. ".github.com" — the domain/host field
  host_only: number;           // 0 or 1
  path: string;
  expiration_date: number | null;  // Unix timestamp, null for session cookies
  secure: number;              // 0 or 1
  http_only: number;           // 0 or 1
  same_site: string;
}
```

### Password (StoredPassword)

```typescript
interface StoredPassword {
  id: number;
  origin_url: string;       // ⚠️ NOT "domain", "origin", or "url"
  username: string;          // decrypted
  password: string;          // decrypted
  action_url: string;
  realm: string;
  date_created: number | null;
  date_last_used: number | null;
  times_used: number;
}
```

### Detected Browser

```typescript
interface DetectedBrowser {
  name: string;          // "chrome" | "firefox" | "safari" | etc.
  family: string;        // "chromium" | "firefox" | "safari"
  displayName: string;   // "Google Chrome"
  version?: string;
  dataDir: string;       // path to browser data directory
  profiles: DetectedProfile[];
  tccBlocked?: boolean;  // macOS: needs Full Disk Access permission
}

interface DetectedProfile {
  id: string;            // short identifier (e.g. "Default", "Profile 1")
  displayName: string;
  path: string;          // full path to profile directory
  isDefault: boolean;
  avatarUrl?: string;    // Chrome profile avatar
}
```

### startImport Request & Response

```typescript
// Request — pass `profile` as a DetectedProfile object or path string
interface ImportRequest {
  browser: string;
  profile: DetectedProfile | string;  // pass the profile object or its .path
  dataTypes: string[];
  masterPassword?: string;            // Firefox only
  csvPasswordFile?: string;           // Chrome/Safari CSV export
}

// Response — array, one entry per requested dataType
interface ImportResult {
  dataType: string;      // "cookies" | "passwords" | "bookmarks" | etc.
  success: boolean;
  itemCount: number;     // items successfully imported
  skippedCount: number;  // items skipped (decryption failures, duplicates)
  error?: string;
  warnings: string[];
}
```

**Common mistake**: `startImport` returns `ImportResult[]` (an array), not an object keyed by data type. Iterate the array to build summaries:
```typescript
const results = await browserData.startImport({ browser: "chrome", profile, dataTypes: ["cookies"] });
for (const r of results) {
  console.log(`${r.dataType}: ${r.itemCount} imported, ${r.skippedCount} skipped`);
}
```

## Cookie Session Sync

Imported cookies are **automatically synced** to the shared browser session (`persist:browser`) after `startImport` completes. Browser panels use this session, so they get imported cookies immediately — no manual sync needed.

Manual cookie session sync is host-owned and is not exposed through the server
`@workspace-extensions/browser-data`. In Electron, imported cookies are synced automatically by
the main-process host adapter after a successful cookie import.

## Incremental Re-Import Contract

Re-running `startImport` for the same browser/profile is expected to be safe:

- Bookmarks, search engines, history visits, cookies, passwords, autofill values, permissions, and favicons update existing source records and add newly discovered records.
- Autofill `times_used` is treated as a source aggregate, not a delta, so repeat imports do not inflate counts.
- Password rows avoid rewriting encrypted secrets when the imported plaintext is unchanged.
- `getImportHistory()` is an audit log and appends one row per import attempt.
- `openTabsAsPanels()` is an action, not an import. Running it again opens another set of panels.

## Typical Agent Workflow

1. **Discover**: `eval` → `detectBrowsers()` → get `DetectedBrowser[]` with profiles
2. **Ask user**: `feedback_form` or `inline_ui` → which browser/profile/data types
3. **Import**: `eval` → `startImport({ browser, profile, dataTypes })` → returns `ImportResult[]` (cookies auto-synced to browser session)
4. **Open tabs**: optional `openTabsAsPanels({ browser, profile })` → current HTTP(S) tabs become child browser panels of the caller
5. **Show results**: `inline_ui` → interactive data managers (cookie table, password vault, etc.)
6. **Verify**: `eval` → open browser panel, check authentication state
7. **Offer API provider setup when relevant**: After a successful import, ask whether the user also wants direct API access for Gmail, GitHub, Slack, etc. Make clear this is optional and independent of browser import. Load the `api-integrations` skill for the provider setup guide.

**Step 6 is optional.** Browser import is useful for local browser state, while API provider integrations use OAuth/credentials and can be set up with or without imported browser data. If the user seems to want automation against provider APIs, offer the next step:

> "Your browser data is imported. If you want direct Gmail, GitHub, Slack, or other API access too, I can set up provider credentials next."

If they say yes, load the `api-integrations` skill and follow its provider setup UI guidance. If credentials are already configured, use the relevant provider skill or credential flow directly.

## Environment Compatibility

- Browser import is **panel-only** -- it requires a browser context (`@workspace/panel-browser`) and inline UI for interactive flows.
- Headless sessions cannot use this skill.

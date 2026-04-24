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
| [WORKFLOWS.md](WORKFLOWS.md) | End-to-end recipes — import-sync-verify, cross-browser merge |

## Interaction Patterns

See the sandbox skill's [INTERACTION_PATTERNS.md](../sandbox/INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. Browser import is a prime example: discovery can be eval, but the actual import (choosing browser, profile, data types) should be an inline UI that reports results back via `chat.publish`.

## Architecture

All browser data operations go through `@workspace/panel-browser`, which wraps RPC calls to the `browser-data` service. The service reads browser profile databases directly (SQLite for Chrome/Firefox, plist for Safari).

```
Sandbox code (eval / inline_ui / feedback_custom)
  → import { browserData } from "@workspace/panel-browser"
    → rpc.call("main", "browser-data.*")
      → BrowserDataService (Electron main process)
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
| `browserData.startImport({ browser, profile, dataTypes })` | Import data from a browser profile → `ImportResult[]` (use `profile: detectedProfile` from detectBrowsers) |
| `browserData.getImportHistory()` | Past import results |
| `browserData.getCookies(domain?)` | Browse stored cookies |
| `browserData.syncCookiesToSession(domain?)` | Push cookies to active browser session |
| `browserData.syncCookiesFromSession(domain?)` | Pull cookies from active session |
| `browserData.getPasswords()` | Get all stored passwords |
| `browserData.getPasswordForSite(url)` | Find password for a URL |
| `browserData.getBookmarks(folder?)` | Browse bookmarks by folder |
| `browserData.searchBookmarks(query)` | Full-text bookmark search |
| `browserData.getHistory(query)` | Browse/search history |
| `browserData.exportAll()` | Export everything as JSON |

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
  family: string;        // "chromium" | "firefox" | "webkit"
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

`syncCookiesToSession` / `syncCookiesFromSession` exist for:
- **User-defined panels** that run in a different session and need cookies pushed explicitly
- **Re-syncing** after manually adding/deleting cookies in the store
- **Domain-scoped sync** when you only want to push cookies for a specific domain

## Typical Agent Workflow

1. **Discover**: `eval` → `detectBrowsers()` → get `DetectedBrowser[]` with profiles
2. **Ask user**: `feedback_form` or `inline_ui` → which browser/profile/data types
3. **Import**: `eval` → `startImport({ browser, profile, dataTypes })` → returns `ImportResult[]` (cookies auto-synced to browser session)
4. **Show results**: `inline_ui` → interactive data managers (cookie table, password vault, etc.)
5. **Verify**: `eval` → open browser panel, check authentication state
6. **Suggest OAuth**: After a successful import, always ask the user if they'd like to set up OAuth for API access (Gmail, GitHub, Slack, etc.). Imported cookies make sign-in seamless. Load the `api-integrations` skill for the setup guide.

**Step 6 is important.** The whole point of importing cookies is often to enable authenticated API access. Don't just import and stop — proactively offer the next step:

> "Your cookies are imported! Would you like to set up OAuth so I can access Gmail, GitHub, or other APIs on your behalf? Your imported cookies will make the sign-in process seamless."

If they say yes, load the `api-integrations` skill and follow its Prerequisites section. If OAuth is already configured, offer to connect to a provider right away using `openIn: "panel"` (their imported cookies will pre-authenticate the browser panel).

## Environment Compatibility

- Browser import is **panel-only** -- it requires a browser context (`@workspace/panel-browser`) and inline UI for interactive flows.
- Headless sessions cannot use this skill.

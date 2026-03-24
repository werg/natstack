---
name: browser-import
description: Browser data import — discover browsers, import cookies/passwords/bookmarks/history, manage and sync imported data. Read SKILL.md to start.
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
Sandbox code / Inline UI
  → createBrowserDataApi(rpc)  or  createBrowserDataApi(chat.rpc)
    → rpc.call("main", "browser-data.*")
      → BrowserDataService (Electron main process)
        → reads Chrome/Firefox/Safari profile databases
```

## Quick Reference

```typescript
import { createBrowserDataApi } from "@workspace/panel-browser";
import { rpc } from "@workspace/runtime";  // or use chat.rpc in components
const api = createBrowserDataApi(rpc);
```

| Method | What it does |
|--------|-------------|
| `api.detectBrowsers()` | Find installed browsers + profiles |
| `api.startImport(request)` | Import data types from a browser profile |
| `api.getImportHistory()` | Past import results |
| `api.getCookies(domain?)` | Browse stored cookies |
| `api.syncCookiesToSession(domain?)` | Push cookies to active browser session |
| `api.syncCookiesFromSession(domain?)` | Pull cookies from active session |
| `api.getPasswords(domain?)` | Browse stored passwords |
| `api.getPasswordForSite(url)` | Find password for a URL |
| `api.getBookmarks(folder?)` | Browse bookmarks by folder |
| `api.searchBookmarks(query)` | Full-text bookmark search |
| `api.getHistory(query)` | Browse/search history |
| `api.exportAll()` | Export everything as JSON |

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
  expiration_date: number | null;  // Unix timestamp (ms), null for session cookies
  secure: number;              // 0 or 1
  http_only: number;           // 0 or 1
  same_site: string;
  source_scheme: string | null;
  source_port: number;
  source_browser: string | null;
  created_at: number;
  last_accessed: number | null;
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
  date_password_changed: number | null;
  times_used: number;
}
```

### Detected Browser

```typescript
interface DetectedBrowser {
  name: string;          // "chrome" | "firefox" | "safari" | etc.
  family: string;        // "chromium" | "firefox" | "webkit"
  displayName: string;   // "Google Chrome"
  dataDir: string;       // path to browser data directory
  profiles: DetectedProfile[];
}

interface DetectedProfile {
  id: string;
  displayName: string;
  path: string;          // full path to profile directory
  isDefault: boolean;
}
```

## Cookie Session Sync

Imported cookies are **automatically synced** to the shared browser session (`persist:browser`) after `startImport` completes. Browser panels use this session, so they get imported cookies immediately — no manual sync needed.

`syncCookiesToSession` / `syncCookiesFromSession` exist for:
- **User-defined panels** that run in a different session and need cookies pushed explicitly
- **Re-syncing** after manually adding/deleting cookies in the store
- **Domain-scoped sync** when you only want to push cookies for a specific domain

## Typical Agent Workflow

1. **Discover**: `eval` → `detectBrowsers()` → log what's available
2. **Ask user**: `feedback_form` or `inline_ui` → which browser/profile/data types
3. **Import**: `eval` → `startImport(request)` → log results (cookies auto-synced to browser session)
4. **Show results**: `inline_ui` → interactive data managers (cookie table, password vault, etc.)
5. **Verify**: `eval` → open browser panel, check authentication state

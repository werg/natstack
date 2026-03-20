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

## Typical Agent Workflow

1. **Discover**: `eval` → `detectBrowsers()` → log what's available
2. **Ask user**: `feedback_form` or `inline_ui` → which browser/profile/data types
3. **Import**: `eval` → `startImport(request)` → log results
4. **Show results**: `inline_ui` → interactive data managers (cookie table, password vault, etc.)
5. **Sync**: `eval` or button in `inline_ui` → `syncCookiesToSession(domain)`
6. **Verify**: `eval` → open browser panel, check authentication state

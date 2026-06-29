# Unified History and Open Tabs

Imported browser history, NatStack browser-panel history, and address-bar
suggestions share one storage path.

## Model

- Imported Chrome/Firefox/Safari history is normalized into URL summaries plus
  per-visit events when the source browser exposes individual visits.
- NatStack browser panels record their own HTTP(S) main-frame navigations into
  the same visit table.
- The `history` table is a materialized summary over visits: URL, title,
  visit count, typed count, first visit, and last visit.
- Address-bar autocomplete reads that summary together with open browser panels,
  bookmarks, and search engines.

## Address-Bar Suggestions

The shell calls `getBrowserAddressOptions(query)`, which combines:

- currently open browser panels
- history rows from `BrowserDataDO.searchHistoryForAutocomplete`
- bookmarks from `BrowserDataDO.searchBookmarks`
- search engines from `BrowserDataDO.getSearchEngines`

Ranking favors exact/prefix/substring matches first, then open sessions,
bookmarks/history, typed count, visit count, and recency. Imported history and
NatStack-local panel history therefore affect autocomplete the same way.

## Recording NatStack Browser History

Browser-panel navigations are recorded automatically by the Electron host. Agents
do not need to call a history API when opening panels. The recorder stores:

- URL and page title
- visit time
- transition type such as `typed`, `link`, `reload`, or `back_forward`
- whether the navigation came from typed address-bar input
- originating panel id

Only HTTP(S) browser-panel navigations are recorded.

## Importing Browser History

Use `startImport` with `dataTypes: ["history"]` or include `history` in a larger
import:

```typescript
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const results = await browserData.startImport({
    browser: "chrome",
    profile: "/home/user/.config/google-chrome/Default",
    dataTypes: ["history"],
  });

  return results;
` })
```

Chrome, Firefox, and Safari readers preserve individual visit timestamps when
available. If a source only exposes aggregate data for a URL, NatStack stores the
best available first/last visit events.

## Incremental History Imports

History imports are idempotent for the same browser/profile. Visit events are
keyed by URL, visit time, source browser, source profile path, source type, panel
id, and transition. Re-importing the same browser profile does not inflate
`visit_count` or `typed_count`; new browser visits are added, and changed titles
are reflected in the summary.

## Open Current Browser Tabs

Open tabs are not a `startImport` data type. They are a separate action because
they create NatStack panels.

Preview tabs:

```typescript
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const tabs = await browserData.getOpenTabs({
    browser: "chrome",
    profile: "/home/user/.config/google-chrome/Default",
  });

  return tabs;
` })
```

Open current HTTP(S) tabs as child browser panels of the invoking caller:

```typescript
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  const result = await browserData.openTabsAsPanels({
    browser: "chrome",
    profile: "/home/user/.config/google-chrome/Default",
  });

  return result;
` })
```

`openTabsAsPanels()` skips non-HTTP(S) URLs such as `chrome://settings`.
Running it again opens another set of panels; it is intentionally not
idempotent.

## Browser Life Migration

For a full migration into NatStack:

1. Detect browsers and choose a profile.
2. Run `startImport` for persistent data:
   `["cookies", "passwords", "bookmarks", "history", "autofill", "searchEngines", "permissions", "favicons"]`.
3. Run `openTabsAsPanels({ browser, profile })` to recreate current open tabs.
4. Use the address bar normally. Imported history, NatStack-local history,
   bookmarks, search engines, and open sessions all feed suggestions.
5. Re-run `startImport` later for the same profile to pull new/changed source
   data without duplicating previous imports.

## API Shapes

```typescript
interface ImportedOpenTab {
  url: string;
  title?: string;
  browser: string;
  profilePath: string;
  windowIndex: number;
  tabIndex: number;
  active: boolean;
  pinned?: boolean;
  lastAccessed?: number;
}

interface OpenTabsAsPanelsResult {
  tabsFound: number;
  panelsOpened: number;
  panels: Array<{ id: string; title: string; url: string }>;
  skipped: Array<{ url: string; reason: string }>;
}

interface StoredHistory {
  id: number;
  url: string;
  title: string | null;
  visit_count: number;
  typed_count: number;
  first_visit: number | null;
  last_visit: number;
}
```

# Runtime API Reference

All APIs available to sandbox code via `import` or `chat.rpc.call()`.

## Filesystem (`fs`)

```typescript
import { fs } from "@workspace/runtime";
```

Scoped to the panel's context folder. All methods are async.

| Method | Signature |
|--------|-----------|
| `readFile` | `(path, encoding?) => Promise<string \| Uint8Array>` |
| `writeFile` | `(path, data) => Promise<void>` |
| `readdir` | `(path, options?) => Promise<string[] \| Dirent[]>` |
| `stat` | `(path) => Promise<FileStats>` |
| `mkdir` | `(path, opts?) => Promise<string \| undefined>` |
| `rm` | `(path, opts?) => Promise<void>` |
| `exists` | `(path) => Promise<boolean>` |
| `rename` | `(old, new) => Promise<void>` |
| `copyFile` | `(src, dest) => Promise<void>` |
| `appendFile` | `(path, data) => Promise<void>` |
| `unlink` | `(path) => Promise<void>` |
| `symlink` | `(target, path) => Promise<void>` |
| `readlink` | `(path) => Promise<string>` |
| `realpath` | `(path) => Promise<string>` |
| `chmod` | `(path, mode) => Promise<void>` |
| `truncate` | `(path, len?) => Promise<void>` |
| `open` | `(path, flags?, mode?) => Promise<FileHandle>` |

`FileHandle` has: `fd`, `read()`, `write()`, `close()`, `stat()`.

Pass `{ withFileTypes: true }` to `readdir` to get `Dirent` objects with `isDirectory()`, `isFile()`.

## Database (`db`)

```typescript
import { db } from "@workspace/runtime";
```

SQLite databases, scoped to the workspace.

```typescript
const conn = await db.open("my-data");        // or db.open("my-data", true) for read-only
await conn.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)");
await conn.run("INSERT INTO items (name) VALUES (?)", ["test"]);
const row = await conn.get("SELECT * FROM items WHERE id = ?", [1]);
const rows = await conn.query("SELECT * FROM items");
await conn.close();
```

| Method | Returns |
|--------|---------|
| `exec(sql)` | `void` — DDL, multi-statement |
| `run(sql, params?)` | `{ changes, lastInsertRowid }` |
| `get<T>(sql, params?)` | `T \| null` — single row |
| `query<T>(sql, params?)` | `T[]` — all rows |
| `close()` | `void` |

## Workers (`workers`)

```typescript
import { workers } from "@workspace/runtime";
```

Manage workerd (Cloudflare V8 isolate) instances.

| Method | Description |
|--------|-------------|
| `create(options)` | Create a worker instance (requires `cpuMs` resource limit) |
| `destroy(name)` | Destroy an instance |
| `update(name, updates)` | Update instance config |
| `list()` | List all running instances |
| `status(name)` | Get instance status |
| `listSources()` | List available worker source packages |
| `getPort()` | Get the workerd HTTP port |
| `restartAll()` | Restart all instances |

## AI Client (`ai`)

```typescript
import { ai } from "@workspace/runtime";
```

| Method | Description |
|--------|-------------|
| `listRoles()` | List available model roles and their configs |
| `generateText(options)` | Generate text (returns full response) |
| `streamText(options)` | Stream text (returns async iterable of events) |

### generateText

```typescript
const result = await ai.generateText({
  model: "fast",  // role name from listRoles()
  messages: [{ role: "user", content: "Hello" }],
  system: "You are helpful.",
  maxOutputTokens: 500,
  temperature: 0.7,
});
```

### streamText

```typescript
for await (const event of ai.streamText({ model: "fast", messages })) {
  if (event.type === "text-delta") process.stdout.write(event.text);
  if (event.type === "finish") console.log("\nDone:", event.usage);
}
```

Event types: `text-delta`, `reasoning-start`, `reasoning-delta`, `reasoning-end`, `tool-call`, `tool-result`, `step-finish`, `finish`, `error`.

## Workspace (`workspace`)

```typescript
import { workspace } from "@workspace/runtime";
```

| Method | Description |
|--------|-------------|
| `list()` | List all workspaces |
| `getActive()` | Get active workspace name |
| `getActiveEntry()` | Get active workspace details |
| `getConfig()` | Get workspace config |
| `create(name, opts?)` | Create a new workspace |
| `setRootPanel(source)` | Set workspace root panel |
| `setInitPanels(sources)` | Set panels launched on workspace open |
| `switchTo(name)` | Switch workspace (triggers app relaunch) |

## Git

```typescript
import { rpc } from "@workspace/runtime";
```

| RPC Call | Description |
|----------|-------------|
| `rpc.call("main", "git.getWorkspaceTree")` | Discover repos and panels |
| `rpc.call("main", "git.listBranches", repoPath)` | List branches |
| `rpc.call("main", "git.listCommits", repoPath, ref?, limit?)` | Commit log |
| `rpc.call("main", "git.resolveRef", repoPath, ref)` | Resolve ref to SHA |
| `rpc.call("main", "git.getBaseUrl")` | Git server base URL |

For full git operations, use `isomorphic-git` with the runtime `fs`:

```typescript
import git from "isomorphic-git";
import { fs } from "@workspace/runtime";
const log = await git.log({ fs, dir: "/", depth: 5 });
```

## Browser Data (`@workspace/panel-browser`)

```typescript
import { createBrowserDataApi } from "@workspace/panel-browser";
import { rpc } from "@workspace/runtime";
// or in components: createBrowserDataApi(chat.rpc)
const browserData = createBrowserDataApi(rpc);
```

### Detection

| Method | Description |
|--------|-------------|
| `detectBrowsers()` | Returns `DetectedBrowser[]` with profiles |

`DetectedBrowser`: `{ name, family, displayName, version?, dataDir, profiles: DetectedProfile[], tccBlocked? }`
`DetectedProfile`: `{ id, displayName, path, isDefault, avatarUrl? }`

### Import

| Method | Description |
|--------|-------------|
| `startImport(request)` | Import data from a browser profile |
| `getImportHistory()` | Past import results |

`ImportRequest`: `{ browser: BrowserName, profilePath: string, dataTypes: ImportDataType[], masterPassword?, csvPasswordFile? }`
`ImportDataType`: `"bookmarks" \| "history" \| "cookies" \| "passwords" \| "autofill" \| "searchEngines" \| "extensions" \| "permissions" \| "settings" \| "favicons"`

### Bookmarks

`getBookmarks(folderPath?)`, `addBookmark(bookmark)`, `updateBookmark(id, partial)`, `deleteBookmark(id)`, `moveBookmark(id, folder, pos)`, `searchBookmarks(query)`

### History

`getHistory(query)`, `deleteHistoryEntry(id)`, `deleteHistoryRange(start, end)`, `clearAllHistory()`, `searchHistory(query, limit?)`

### Passwords

`getPasswords(domain?)`, `getPasswordForSite(url)`, `addPassword(entry)`, `updatePassword(id, partial)`, `deletePassword(id)`

### Cookies

`getCookies(domain?)`, `deleteCookie(id)`, `clearCookies(domain?)`, `syncCookiesToSession(domain?)`, `syncCookiesFromSession(domain?)`

### Autofill & Search Engines

`getAutofillSuggestions(fieldName, prefix?)`, `getSearchEngines()`, `setDefaultEngine(id)`

### Permissions

`getPermissions(origin?)`, `setPermission(origin, permission, setting)`

### Export

`exportBookmarks(format)`, `exportPasswords(format)`, `exportCookies(format)`, `exportAll()`

Formats — bookmarks: `"html" \| "json" \| "chrome-json"`, passwords: `"csv-chrome" \| "csv-firefox" \| "json"`, cookies: `"json" \| "netscape-txt"`.

## Panel Navigation

```typescript
import { focusPanel, buildPanelLink, createBrowserPanel, openExternal, closeSelf } from "@workspace/runtime";
```

| Function | Description |
|----------|-------------|
| `focusPanel(panelId)` | Focus another panel |
| `buildPanelLink(source, opts?)` | Build URL for panel navigation |
| `createBrowserPanel(url, opts?)` | Open URL in browser panel, returns `BrowserHandle` |
| `openExternal(url)` | Open in OS default browser |
| `closeSelf()` | Close this panel |

`BrowserHandle`: `getCdpEndpoint()`, `navigate(url)`, `goBack()`, `goForward()`, `reload()`, `stop()`, `close()`.

## Browser Automation (`@workspace/playwright-client`)

```typescript
import { connect } from "@workspace/playwright-client";
```

Full Playwright API via CDP. Connect to a browser panel to automate pages.

```typescript
const handle = await createBrowserPanel("https://example.com");
const browser = await connect(await handle.getCdpEndpoint(), "chromium", {});
const page = browser.contexts()[0]?.pages()[0];
```

Key `Page` methods: `goto(url)`, `title()`, `content()`, `click(selector)`, `fill(selector, value)`, `screenshot(opts?)`, `evaluate(fn)`, `locator(selector)`, `waitForSelector(selector)`, `waitForURL(url)`, `waitForLoadState(state)`.

Key `Locator` methods: `click()`, `fill(value)`, `textContent()`, `innerText()`, `getAttribute(name)`, `isVisible()`, `count()`, `first()`, `nth(i)`, `filter(opts)`, `screenshot()`.

See [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md) for full API reference and examples.

## Build & Typecheck

```typescript
import { rpc } from "@workspace/runtime";
```

| RPC Call | Description |
|----------|-------------|
| `rpc.call("main", "build.getBuild", source, ref?, opts?)` | Build a panel/worker/agent |
| `rpc.call("main", "build.getEffectiveVersion", name)` | Get effective version |
| `rpc.call("main", "build.hasUnit", name)` | Check if build unit exists |
| `rpc.call("main", "typecheck.check", source)` | Type-check a panel |

## Tests

```typescript
import { rpc } from "@workspace/runtime";
const result = await rpc.call("main", "test.run", "panels/my-app");
```

## Ad Block

```typescript
import { adblock } from "@workspace/runtime";
const stats = await adblock.getStats();
const active = await adblock.isActive();
```

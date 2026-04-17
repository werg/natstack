# Runtime API Reference

All APIs available to sandbox code via `import`, `chat.rpc.call()`, or pre-injected variables.

## Pre-injected globals

`chat`, `scope`, `scopes` only. Every other API on this page must be imported.

| Property/Method | Description |
|----------------|-------------|
| `scope.x = val` | Store a value that persists across eval calls |
| `scopes.currentId` | Current scope's durable UUID |
| `scopes.push()` | Archive current scope, start new one → returns new ID |
| `scopes.get(id)` | Retrieve archived scope by ID → read-only plain object |
| `scopes.list()` | List all scopes for this channel |
| `scopes.save()` | Force-persist scope to DB now (use after non-eval writes) |

Scope is automatically persisted after every eval call. Primitives, plain objects, arrays, Date, Map, Set, RegExp survive serialization. Functions and class instances are dropped but their serializable properties are kept (e.g., `scope.browser.id` survives even though `scope.browser.page` is lost).

## Generated Panel Runtime Surface

<!-- BEGIN GENERATED: panel-runtime-surface -->
Generated from `runtimeSurface.panel.ts`. Use `await help()` at runtime for the live surface.

| Export | Kind | Members | Description |
|--------|------|---------|-------------|
| `Rpc` | value |  | RPC helpers namespace export. |
| `z` | value |  | Zod export. |
| `defineContract` | value |  |  |
| `noopParent` | value |  |  |
| `buildPanelLink` | value |  |  |
| `contextIdToSubdomain` | value |  |  |
| `parseContextId` | value |  |  |
| `isValidContextId` | value |  |  |
| `getInstanceId` | value |  |  |
| `id` | value |  |  |
| `rpc` | value |  |  |
| `db` | value |  |  |
| `parent` | value |  |  |
| `getParent` | value |  |  |
| `getParentWithContract` | value |  |  |
| `onConnectionError` | value |  |  |
| `getInfo` | value |  |  |
| `closeSelf` | value |  |  |
| `focusPanel` | value |  |  |
| `getWorkspaceTree` | value |  |  |
| `listBranches` | value |  |  |
| `listCommits` | value |  |  |
| `getTheme` | value |  |  |
| `onThemeChange` | value |  |  |
| `onFocus` | value |  |  |
| `exposeMethod` | value |  |  |
| `contextId` | value |  |  |
| `parentId` | value |  |  |
| `fs` | value |  |  |
| `gitConfig` | value |  |  |
| `pubsubConfig` | value |  |  |
| `env` | value |  |  |
| `workers` | namespace | `create`, `destroy`, `update`, `list`, `status`, `listInstanceSources`, `getPort`, `restartAll`, `cloneDO`, `destroyDO` |  |
| `normalizePath` | value |  |  |
| `getFileName` | value |  |  |
| `resolvePath` | value |  |  |
| `getStateArgs` | value |  |  |
| `useStateArgs` | value |  |  |
| `setStateArgs` | value |  |  |
| `createBrowserPanel` | value |  |  |
| `openExternal` | value |  |  |
| `onChildCreated` | value |  |  |
| `getBrowserHandle` | value |  |  |
| `openPanel` | value |  |  |
| `adblock` | namespace | `getStats`, `isActive`, `getStatsForPanel`, `isEnabledForPanel`, `setEnabledForPanel`, `resetStatsForPanel`, `getPanelUrl`, `addToWhitelist`, `removeFromWhitelist` |  |
| `workspace` | namespace | `list`, `getActive`, `getActiveEntry`, `getConfig`, `create`, `setInitPanels`, `switchTo`, `openPanel` |  |
| `oauth` | namespace | `getToken`, `getConnection`, `listConnections`, `listProviders`, `connect`, `requestConsent`, `startAuth`, `waitForConnection`, `disconnect`, `listConsents` |  |
| `notifications` | namespace | `show`, `dismiss` |  |
<!-- END GENERATED: panel-runtime-surface -->

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

| Method | Use for | Returns |
|--------|---------|---------|
| `exec(sql)` | DDL, multi-statement (`CREATE TABLE`, schema) | `void` |
| `run(sql, params?)` | Writes (`INSERT`, `UPDATE`, `DELETE`) | `{ changes, lastInsertRowid }` |
| `get<T>(sql, params?)` | Read single row (`SELECT ... LIMIT 1`) | `T \| null` |
| `query<T>(sql, params?)` | Read multiple rows (`SELECT`) | `T[]` |
| `close()` | Release connection | `void` |

**Important:** `query()` is for SELECT only. Use `run()` for INSERT/UPDATE/DELETE, `exec()` for CREATE/DROP.

## Workers (`workers`)

```typescript
import { workers } from "@workspace/runtime";
```

Manage workerd (Cloudflare V8 isolate) instances.

| Method | Description |
|--------|-------------|
| `create(options)` | Create a worker instance |
| `destroy(name)` | Destroy an instance |
| `update(name, updates)` | Update instance config |
| `list()` | List all running instances |
| `status(name)` | Get instance status |
| `listInstanceSources()` | List available worker source packages |
| `getPort()` | Get the workerd HTTP port |
| `restartAll()` | Restart all instances |

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
| `create(name, opts?)` | Create a new workspace (only available when the host owns the workspace catalog — throws "Unknown workspace method: create" otherwise) |
| `setInitPanels(entries)` | Set panels launched on workspace open |
| `switchTo(name)` | Switch workspace (triggers app relaunch) |
| `openPanel(source, opts?)` | Open a panel (alias for the top-level `openPanel` — see [Panel Navigation](#panel-navigation)) |

`workspace.create("name")` requires a string `name` as its first argument. Passing `null` or no name fails with a Zod validation error. Workspace creation is only available in the host process that owns the workspace catalog (Electron main / standalone bridge); in remote-server / mobile-client modes the method is not registered at all and the call returns "Unknown workspace method: create".

## Git (`GitClient`)

**Do NOT use `node:child_process` or shell commands for git.** Use `GitClient` from `@natstack/git`:

```typescript
import { fs, gitConfig } from "@workspace/runtime";
import { GitClient } from "@natstack/git";

const git = new GitClient(fs, {
  serverUrl: gitConfig.serverUrl,
  token: gitConfig.token,
});
```

| Method | Description |
|--------|-------------|
| `git.init(dir, branch?)` | Initialize a new repo |
| `git.isRepo(dir)` | Check if directory is a repo |
| `git.status(dir)` | Array of file statuses |
| `git.add(dir, filepath)` | Stage a file |
| `git.addAll(dir)` | Stage all changes |
| `git.commit({ dir, message })` | Commit staged changes → SHA |
| `git.log(dir, opts?)` | Commit history |
| `git.createBranch(dir, name)` | Create a branch |
| `git.checkout(dir, name)` | Switch branch |
| `git.listBranches(dir)` | List branches |
| `git.stash(dir, opts?)` | Stash changes |
| `git.stashPop(dir, index?)` | Pop stash |
| `git.addRemote(dir, name, url)` | Add a remote |
| `git.listRemotes(dir)` | List remotes |
| `git.push({ dir, ref })` | Push to remote |
| `git.pull({ dir })` | Pull from remote |

### Read-only RPC shortcuts

For quick queries without constructing a `GitClient`:

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

### Cloning Remote GitHub Repos

The git server transparently proxies GitHub repositories. Use the path format `github.com/owner/repo` — the server auto-clones on first access.

```typescript
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { fs, gitConfig } from "@workspace/runtime";

// Clone a public GitHub repo into the context folder
await git.clone({
  fs, http,
  dir: "/my-lib",
  url: `${gitConfig.serverUrl}/github.com/owner/repo`,
  headers: { Authorization: `Bearer ${gitConfig.token}` },
  depth: 1,
});
```

Once cloned via the git server, the repo appears in the workspace tree and can be referenced by other workspace operations. Private repos require a GitHub token configured in the workspace's `meta/natstack.yml` or `.secrets.yml`.

### Pushing to GitHub

Pushes to `main`/`master` are **rejected** on GitHub repos — always create a branch. The git server automatically pushes branches to the upstream GitHub remote when a GitHub token is configured.

```
eval({
  code: `
    import { GitClient } from "@natstack/git";
    import { fs, gitConfig } from "@workspace/runtime";

    const git = new GitClient(fs, { serverUrl: gitConfig.serverUrl, token: gitConfig.token });
    await git.createBranch("/my-lib", "fix/my-change");
    await git.checkout("/my-lib", "fix/my-change");
    // ... make changes ...
    await git.addAll("/my-lib");
    await git.commit("/my-lib", "fix: describe the change");
    await git.push("/my-lib", { remote: "origin", ref: "fix/my-change" });
    // Branch is auto-pushed to GitHub
  `,
})
```

## Browser Data (`@workspace/panel-browser`)

```typescript
import { browserData } from "@workspace/panel-browser";
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

`ImportRequest`: `{ browser: BrowserName, profile: DetectedProfile | string, dataTypes: ImportDataType[], masterPassword?, csvPasswordFile? }`
`ImportDataType`: `"bookmarks" \| "history" \| "cookies" \| "passwords" \| "autofill" \| "searchEngines" \| "extensions" \| "permissions" \| "settings" \| "favicons"`

### Bookmarks

`getBookmarks(folderPath?)`, `addBookmark(bookmark)`, `updateBookmark(id, partial)`, `deleteBookmark(id)`, `moveBookmark(id, folder, pos)`, `searchBookmarks(query)`

### History

`getHistory(query)`, `deleteHistoryEntry(id)`, `deleteHistoryRange(start, end)`, `clearAllHistory()`, `searchHistory(query, limit?)`

### Passwords

`getPasswords()`, `getPasswordForSite(url)`, `addPassword(entry)`, `updatePassword(id, partial)`, `deletePassword(id)`

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
import { openPanel, createBrowserPanel, getBrowserHandle, focusPanel, buildPanelLink, openExternal, closeSelf } from "@workspace/runtime";
```

| Function | Description |
|----------|-------------|
| `openPanel(source, opts?)` | Open any panel — URLs become browser panels, source paths open workspace panels. Returns `{ id }` for browser panels |
| `createBrowserPanel(url, opts?)` | Open URL in browser panel, returns `BrowserHandle` (use when you need CDP/automation) |
| `getBrowserHandle(id)` | Reconnect to an existing browser panel by ID (use after reload when `scope.browser.id` survived but methods were lost) |
| `focusPanel(panelId)` | Focus an existing panel by its ID (does NOT open new panels) |
| `buildPanelLink(source, opts?)` | Build URL for panel navigation (low-level — prefer `openPanel`) |
| `openExternal(url)` | Open in OS default browser |
| `closeSelf()` | Close this panel |

**Choosing the right function:**
- To open a URL in a browser panel: `openPanel("https://...")` or `createBrowserPanel(url)` if you need the `BrowserHandle` for automation
- To open a workspace panel: `openPanel("panels/my-app", { stateArgs: {...} })`
- To focus a panel you already have the ID for: `focusPanel(panelId)`
- `buildPanelLink` just builds a URL string — you still need `window.open(link)` to open it

`BrowserHandle`: `page()`, `navigate(url)`, `goBack()`, `goForward()`, `reload()`, `stop()`, `close()`.

## Browser Automation

```typescript
const handle = await createBrowserPanel("https://example.com");
const page = await handle.page();
```

`handle.page()` connects Playwright via CDP and returns a page object. No manual CDP endpoints or imports needed.

Key `Page` methods: `goto(url, opts?)`, `title()`, `content()`, `url()`, `click(selector)`, `fill(selector, value)`, `type(selector, text)`, `waitForSelector(selector)`, `querySelector(selector)`, `evaluate(fn, ...args)`, `screenshot(opts?)`, `close()`.

Use `page.evaluate()` for complex DOM queries — gives you full DOM API access in the page context.

See [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md) for full API reference and examples.

## Build & Typecheck

```typescript
import { rpc } from "@workspace/runtime";
```

### Build

| RPC Call | Description |
|----------|-------------|
| `rpc.call("main", "build.getBuild", source, ref?, opts?)` | Build a panel/worker/agent |
| `rpc.call("main", "build.getBuildNpm", specifier, version, externals?)` | Install + bundle an npm package as CJS for sandbox use |
| `rpc.call("main", "build.getEffectiveVersion", name)` | Get effective version |
| `rpc.call("main", "build.hasUnit", name)` | Check if build unit exists |

### Typecheck

**Recommended: `typecheck.checkPanel`** — simple, agent-friendly type checking.

```typescript
// Type-check a specific panel
const result = await rpc.call("main", "typecheck.checkPanel", "panels/my-app");

// Type-check the current panel (auto-detected from caller context)
const result = await rpc.call("main", "typecheck.checkPanel");
```

Returns `{ diagnostics: Array<{ file, line, column, message, severity, code }>, errorCount, warningCount }`.

**Advanced methods** (positional args, for editor integrations):

| RPC Call | Description |
|----------|-------------|
| `rpc.call("main", "typecheck.check", panelPath, filePath?, fileContent?, contextId?)` | Type-check a panel or specific file |
| `rpc.call("main", "typecheck.getTypeInfo", panelPath, filePath, line, column, fileContent?, contextId?)` | Get type info at a position |
| `rpc.call("main", "typecheck.getCompletions", panelPath, filePath, line, column, fileContent?, contextId?)` | Get completions at a position |

## Tests

```typescript
import { rpc } from "@workspace/runtime";
const result = await rpc.call("main", "test.run", contextId, "panels/my-app");
```

## OAuth (`oauth`)

```typescript
import { oauth } from "@workspace/runtime";
```

Manage OAuth connections. Handles token refresh, consent prompts, and browser sign-in automatically.

**Setup:** Requires a Nango secret key in `~/.config/natstack/.secrets.yml` under `nango:` (a UUID from the Nango dashboard's Settings → Secret Key). Sign up free at https://app.nango.dev, then configure providers in the Nango dashboard. Use the `api-integrations` skill for full setup guidance.

| Method | Description |
|--------|-------------|
| `listProviders()` | List configured providers → `[{ key, provider }]` |
| `listConnections()` | List active connections → `OAuthConnection[]` |
| `getConnection(providerKey, connectionId?)` | Check connection status → `OAuthConnection` |
| `getToken(providerKey, connectionId?)` | Get access token (auto-refreshes) → `{ accessToken, expiresAt, scopes }` |
| `requestConsent(providerKey, { scopes? })` | Request user consent (shows notification in shell) → `{ consented }` |
| `startAuth(providerKey, connectionId?, { openIn? })` | Sync cookies + open sign-in (`openIn`: `"panel"` (default) or `"external"`) → `{ authUrl }` |
| `waitForConnection(providerKey, connectionId?, timeoutMs?)` | Poll until connected → `OAuthConnection` |
| `connect(providerKey, connectionId?, { scopes?, openIn? })` | All-in-one: consent + auth + wait → `OAuthConnection` |
| `disconnect(providerKey, connectionId?)` | Revoke connection |
| `listConsents()` | List consent records for this caller → `ConsentRecord[]` |

`OAuthConnection`: `{ id, provider, email?, connected, lastRefreshed? }`.
`ConsentRecord`: `{ callerId, provider, scopes, grantedAt }`.

**Quick connect pattern:**
```typescript
const conn = await oauth.getConnection("notion");
if (!conn.connected) {
  await oauth.requestConsent("notion", { scopes: ["database:read"] });
  await oauth.startAuth("notion");
  await oauth.waitForConnection("notion");
}
const token = await oauth.getToken("notion");
```

## Integrations (`@workspace/integrations`)

Pre-built API clients that wrap OAuth + fetch. See `api-integrations` skill for the full spectrum from quick experiments to custom libraries.

For APIs without a pre-built integration, use `oauth.getToken()` + the official npm SDK directly:

```typescript
import { oauth } from "@workspace/runtime";
import { Client } from "@notionhq/client";  // npm SDK, installed via imports param

const token = await oauth.getToken("notion");
const notion = new Client({ auth: token.accessToken });
const results = await notion.search({ query: "my tasks" });
```

Pre-built wrappers for Gmail and Calendar:

```typescript
import { gmail, calendar } from "@workspace/integrations";

const messages = await gmail.search("from:alice");
await gmail.send({ to: ["bob@example.com"], subject: "Hi", body: "Hello!" });
const events = await calendar.listEvents();

// Bootstrap OAuth if needed
await gmail.ensureConnected();
```

## Notifications (`notifications`)

```typescript
import { notifications } from "@workspace/runtime";
```

Push notifications to the shell chrome area (toasts, errors).

| Method | Description |
|--------|-------------|
| `show({ type, title, message?, ttl?, actions? })` | Show notification → returns ID |
| `dismiss(id)` | Dismiss a notification |

Types: `"info"` (5s auto-dismiss), `"success"` (3s), `"warning"` (8s), `"error"` (manual dismiss).

## Ad Block

```typescript
import { adblock } from "@workspace/runtime";
const stats = await adblock.getStats();
const active = await adblock.isActive();
```

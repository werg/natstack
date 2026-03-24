# Agent Tools Reference

Your working directory is the **context folder** — an isolated copy of the workspace.

**CRITICAL RULES:**
- All file paths are **relative to your working directory** (e.g., `panels/my-app/index.tsx`)
- **NEVER** use absolute paths (e.g., `/home/.../workspace/panels/...`)
- **NEVER** use `Bash` for git operations, file listing, or file creation — use the structured tools
- In eval, use **static imports** (`import { rpc } from "@workspace/runtime"`), NOT dynamic `await import(...)`
- `contextId` is **pre-injected** — use it directly, do NOT import it from `@workspace/runtime`

---

## Filesystem Tools (Native SDK)

### Read

Read file contents.

```
Read({ file_path: "panels/my-app/index.tsx" })
```

### Write

Create or overwrite a file.

```
Write({ file_path: "panels/my-app/index.tsx", content: "..." })
```

### Edit

Edit a file using string replacement.

```
Edit({
  file_path: "panels/my-app/index.tsx",
  old_string: "const [value, setValue] = useState('')",
  new_string: "const [value, setValue] = useState('initial')"
})
```

### Glob

Find files by glob pattern.

```
Glob({ pattern: "**/*.tsx" })
Glob({ pattern: "panels/*/package.json" })
```

### Grep

Search file contents with regex.

```
Grep({ pattern: "useState", path: "panels/my-app" })
Grep({ pattern: "import.*runtime", type: "ts" })
```

---

## Creating Projects

Create new projects via eval with the `imports` parameter. The `imports` parameter triggers an on-demand library build and loads the skill package before code execution.

Supported types: `panel`, `package`, `skill`, `agent`, `worker`. Each scaffolds into its directory (`panels/`, `packages/`, `skills/`, `agents/`, `workers/`).

### Usage

```
eval({ code: `
  import { createProject } from "@workspace-skills/paneldev";
  await createProject({ projectType: "panel", name: "my-app", title: "My App" });
`, imports: { "@workspace-skills/paneldev": "latest" }, timeout: 30000 })
```

**`createProject(params)` parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `projectType` | string | Yes | One of: `panel`, `package`, `skill`, `agent`, `worker` |
| `name` | string | Yes | Project name (kebab-case) |
| `title` | string | No | Human-readable title (defaults to name) |

---

## eval

Execute TypeScript/JavaScript code in the panel runtime. Runtime APIs are available via static imports from `@workspace/runtime`.

**IMPORTANT:**
- Use static `import` syntax, NOT dynamic `await import(...)`.
- `contextId` is **pre-injected** — use it directly, do NOT import it from the runtime.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `code` | string | Yes | Code to execute |
| `syntax` | `"typescript"` \| `"tsx"` \| `"jsx"` | No | Syntax mode (default: `"tsx"`) |
| `timeout` | number | No | Max async wait in ms (default: 10000, max: 90000) |
| `imports` | `Record<string, string>` | No | Workspace packages to build on-demand. Values: `"latest"` or a git ref |

### Runtime APIs

Available via `import { ... } from "@workspace/runtime"` and `import { ... } from "@workspace/panel-browser"`:

| API | Description |
|-----|-------------|
| `rpc` | RPC bridge for calling main-process services via `rpc.call(target, method, ...args)` |
| `openPanel(source, opts?)` | Open any panel — URLs become browser panels, source paths open workspace panels |
| `buildPanelLink(source, opts)` | Build a URL for panel navigation (low-level — prefer `openPanel`) |
| `focusPanel(panelId)` | Focus an existing panel by ID (does NOT open new panels) |

**Pre-injected** (use directly, do NOT import):

| Variable | Description |
|----------|-------------|
| `contextId` | Current agent context ID for scoped operations |

### RPC Services

Called via `rpc.call("main", "service.method", ...args)`:

#### workerd (Worker Management)

Manage worker instances. Available to panels, workers, and server callers. **Limits are mandatory.**

```
// Create a worker instance
eval({ code: `
  import { workers } from "@workspace/runtime";
  const instance = await workers.create({
    source: "workers/my-worker",
    contextId,
    limits: { cpuMs: 100 },
  });
  console.log("Worker started:", instance.name, "on port", await workers.getPort());
`, timeout: 30000 })

// List running workers
eval({ code: `
  import { workers } from "@workspace/runtime";
  const list = await workers.list();
  console.log(list.map(w => w.name + " (" + w.status + ")"));
`, timeout: 10000 })

// Destroy a worker
eval({ code: `
  import { workers } from "@workspace/runtime";
  await workers.destroy("my-worker");
`, timeout: 10000 })
```

Methods: `create(options)`, `destroy(name)`, `update(name, updates)`, `list()`, `status(name)`, `listSources()`, `getPort()`, `restartAll()`. See [WORKERS.md](WORKERS.md) for full API.

#### Git (via `@workspace-skills/paneldev`)

Git operations use `@natstack/git` (isomorphic-git) through the skill package. All operations go directly to the git server over HTTP — no server-side RPC needed.

```
// Commit and push
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  const result = await commitAndPush("panels/my-app", "Update");
  console.log(result);
`, imports: { "@workspace-skills/paneldev": "latest" }, timeout: 30000 })
```

**`commitAndPush(dir, message)`** — stages all changes, commits, and pushes. Auto-initializes git if the directory doesn't have `.git` yet.

#### typecheck.check

Run TypeScript type checking on a panel/package.

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  const result = await rpc.call("main", "typecheck.check", "panels/my-app");
  console.log(result);
`, timeout: 30000 })
```

#### test.run

Run vitest tests on a workspace panel or package.

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  const result = await rpc.call("main", "test.run", contextId, "panels/my-app");
  console.log(result);
`, timeout: 60000 })
```

### Browser Data

```typescript
import { createBrowserDataApi } from "@workspace/panel-browser";
import { rpc } from "@workspace/runtime";
const browserData = createBrowserDataApi(rpc);
// In inline_ui components, use: createBrowserDataApi(chat.rpc)
```

Available methods:

| Method | Description |
|--------|-------------|
| `browserData.detectBrowsers()` | Detect all installed browsers and their profiles |
| `browserData.startImport(request)` | Import data from a browser profile |
| `browserData.getImportHistory()` | Get log of past imports |
| `browserData.getBookmarks(folderPath?)` | Get bookmarks in a folder |
| `browserData.searchBookmarks(query)` | Search bookmarks by title/URL |
| `browserData.addBookmark(bookmark)` | Add a bookmark |
| `browserData.deleteBookmark(id)` | Delete a bookmark |
| `browserData.getHistory(query)` | Query browsing history (search, time range, limit) |
| `browserData.searchHistory(query, limit?)` | Full-text search history |
| `browserData.clearAllHistory()` | Clear all history |
| `browserData.getPasswords()` | Get all stored passwords |
| `browserData.getPasswordForSite(url)` | Get passwords for a specific site |
| `browserData.addPassword(pw)` | Add a password |
| `browserData.getCookies(domain?)` | Get cookies, optionally filtered by domain |
| `browserData.clearCookies(domain?)` | Clear cookies |
| `browserData.syncCookiesToSession(domain?)` | Push stored cookies into the Electron session |
| `browserData.syncCookiesFromSession(domain?)` | Pull Electron session cookies into the store |
| `browserData.getSearchEngines()` | Get configured search engines |
| `browserData.setDefaultEngine(id)` | Set the default search engine |
| `browserData.getAutofillSuggestions(field, prefix?)` | Get autofill suggestions |
| `browserData.getPermissions(origin?)` | Get site permissions |
| `browserData.setPermission(origin, perm, setting)` | Set a site permission |
| `browserData.exportBookmarks(format)` | Export bookmarks (`"html"`, `"json"`, `"chrome-json"`) |
| `browserData.exportPasswords(format)` | Export passwords (`"csv-chrome"`, `"csv-firefox"`, `"json"`) |
| `browserData.exportCookies(format)` | Export cookies (`"json"`, `"netscape-txt"`) |
| `browserData.exportAll()` | Full JSON export of all data |

#### Detect and import

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const browsers = await browserData.detectBrowsers();
  console.log(browsers.map(b => b.displayName + ": " + b.profiles.length + " profiles"));
`, timeout: 15000 })
```

#### Import from Chrome

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const browsers = await browserData.detectBrowsers();
  const chrome = browsers.find(b => b.name === "chrome");
  if (!chrome) { console.log("Chrome not found"); return; }
  const profile = chrome.profiles.find(p => p.isDefault) || chrome.profiles[0];
  const results = await browserData.startImport({
    browser: "chrome",
    profilePath: profile.path,
    dataTypes: ["bookmarks", "history", "cookies"],
  });
  for (const r of results) {
    console.log(r.dataType + ": " + r.itemCount + " imported, " + r.skippedCount + " skipped");
    if (r.warnings.length) console.log("  warnings:", r.warnings);
  }
`, timeout: 60000 })
```

#### Search and export

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const bookmarks = await browserData.searchBookmarks("github");
  console.log("Found", bookmarks.length, "bookmarks");
  const html = await browserData.exportBookmarks("html");
  console.log("Exported", html.length, "bytes of HTML");
`, timeout: 15000 })
```

### Panel Lifecycle

#### First launch

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  import { openPanel } from "@workspace/runtime";
  await commitAndPush("panels/my-app", "Initial");
  await openPanel("panels/my-app");
`, imports: { "@workspace-skills/paneldev": "latest" }, timeout: 30000 })
```

#### Rebuild after edits

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  import { openPanel } from "@workspace/runtime";
  await commitAndPush("panels/my-app", "Update");
  await openPanel("panels/my-app");
`, imports: { "@workspace-skills/paneldev": "latest" }, timeout: 30000 })
```

---

## Web Tools

### web_search

Search the web for information.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `allowed_domains` | string[] | No | Only include results from these domains |
| `blocked_domains` | string[] | No | Exclude results from these domains |

### web_fetch

Fetch and process content from a URL.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `prompt` | string | Yes | What to extract from the page |

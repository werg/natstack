# Agent Tools Reference

Your working directory is the **context folder** — an isolated copy of the workspace.

**CRITICAL RULES:**

- All file paths are **relative to your working directory** (e.g., `panels/my-app/index.tsx`)
- **NEVER** use host absolute paths (e.g., `/home/.../workspace/panels/...`). Runtime `fs.*` accepts context-root absolute paths like `/panels/my-app/index.tsx`, but prefer `panels/my-app/index.tsx` in examples and source edits.
- **NEVER** use `Bash` for git operations, file listing, or file creation — use the structured tools
- In eval, use **static imports** (`import { rpc } from "@workspace/runtime"`). Dynamic `await import(...)` may work in some builds, but it bypasses the loader's static dependency planning and is not the supported pattern.

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

Search file contents. Grep is literal by default; use that for code snippets,
identifiers, function calls, paths, and punctuation. Set `literal: false` only
when the pattern is an intentional valid regex.

```
Grep({ pattern: "useState", path: "panels/my-app" })
Grep({ pattern: "openPanel(", path: "packages/runtime" })
Grep({ pattern: "import.*runtime", path: "panels/my-app", literal: false })
```

---

## Creating Projects

Create new projects via eval. Workspace skill packages are auto-resolved — just write the `import` statement.

Supported types: `panel`, `package`, `skill`, `agent`, `worker`. Each scaffolds into its directory (`panels/`, `packages/`, `skills/`, `agents/`, `workers/`).

### Usage

```
eval({ code: `
  import { createProject } from "@workspace-skills/workspace-dev";
  await createProject({ projectType: "panel", name: "my-app", title: "My App" });
`
})
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

- Use static `import` syntax. Dynamic `await import(...)` is a fallback only for ordinary browser/ESM code; do not use it for `@workspace/runtime` or workspace skill packages.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `code` | string | Yes | Code to execute |
| `syntax` | `"typescript"` \| `"tsx"` \| `"jsx"` | No | Syntax mode (default: `"tsx"`) |
| `imports` | `Record<string, string>` | No | Packages to build on-demand. Workspace packages: `"latest"` or a git ref. npm packages: `"npm:<version>"` (e.g. `"npm:^4.17.21"`, `"npm:latest"`) |

### Runtime APIs

Available via `import { ... } from "@workspace/runtime"` and `import { ... } from "@workspace/panel-browser"`:

| API                            | Description                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `rpc`                          | RPC bridge for calling services via `rpc.call(target, method, args)`            |
| `openPanel(source, opts?)`     | Open any panel — URLs become browser panels, source paths open workspace panels |
| `buildPanelLink(source, opts)` | Build a URL for panel navigation (low-level — prefer `openPanel`)               |
| `focusPanel(panelId)`          | Focus an existing panel by ID (does NOT open new panels)                        |

### Using extensions

Extensions are **declared** in `meta/natstack.yml` under `extensions:`. That declaration is the only way to add or remove one. To start using an extension, add it to the `extensions:` list in `meta/natstack.yml`; saving that change (a gated meta write) raises one joint approval covering every newly-declared extension. Once approved and running, call it with `extensions.use(name)`. Individual extension methods can still request their own approvals when the operation needs one, such as running tests.

`extensions.use(name)` is synchronous and returns a method proxy; do not `await`
it and do not call `.catch(...)` on it. Catch the method call instead:
`await extensions.use(name).method(...).catch(...)`.
`extensions.use(name).method(...)` fails with `ENOEXT` if the extension is not declared, or `ENOTREADY` if it is still starting. If you need an extension that isn't declared yet, edit `meta/natstack.yml`.

Extension methods normally use unary RPC and must return JSON-serializable values. If an extension method returns a `Response` or `ReadableStream`, declare it when creating the client so the runtime uses streaming RPC end-to-end:

```ts
import { extensions } from "@workspace/runtime";

type ShellApi = {
  attach(sessionId: string): Promise<Response>;
  write(sessionId: string, data: string): Promise<void>;
};

const shell = extensions.use<ShellApi>("@workspace-extensions/shell", {
  streamingMethods: ["attach"],
});
```

To check whether an extension is available before calling it, use `extensions.list()`:

```ts
eval({
  code: `
  import { extensions } from "@workspace/runtime";
  const name = "@workspace-extensions/image-service";
  const entry = (await extensions.list()).find((e) => e.name === name);
  if (!entry || entry.status !== "running") {
    throw new Error(name + " is not available — declare it in meta/natstack.yml and approve it.");
  }
`,
});
```

If an extension isn't declared, adding it to `meta/natstack.yml` raises a joint approval. If the user denies it, stop and report that the extension is required for the requested operation.

**Pre-injected** (use directly, do NOT import):

| Variable    | Description                                    |
| ----------- | ---------------------------------------------- |
| `contextId` | Current agent context ID for scoped operations |

### RPC Services

Called via `rpc.call("main", "service.method", args)`:

#### workerd (Worker Management)

Manage worker instances. Available to panels, workers, and server callers. **Limits are mandatory.**

```
// Create a worker instance
eval({ code: `
  import { workers } from "@workspace/runtime";
  const instance = await workers.create({
    source: "workers/my-worker",
    contextId,
  });
  console.log("Worker started:", instance.name, "on port", await workers.getPort());
`
})

// List running workers
eval({ code: `
  import { workers } from "@workspace/runtime";
  const list = await workers.list();
  console.log(list.map(w => w.name + " (" + w.status + ")"));
`
})

// Destroy a worker
eval({ code: `
  import { workers } from "@workspace/runtime";
  await workers.destroy("my-worker");
`
})
```

Methods: `create(options)`, `destroy(name)`, `update(name, updates)`, `list()`, `status(name)`, `listInstanceSources()`, `getPort()`, `restartAll()`. See [WORKERS.md](WORKERS.md) for full API.

#### Version control (GAD-native, edit-first)

Workspace version control is GAD-native and edit-first: the `edit`/`write` tools
— and `vcs.applyEdits` directly — apply each change as one atomic GAD transition
on your context head and project it to disk, then trigger rebuilds of every
changed unit. The edit *is* the commit. There is no staging, no push, no
separate commit or publish step — applying the edit does the whole thing
atomically. (`vcs.publish` is a distinct, explicit operation that publishes your
context head into `main`.)

```
// Apply an edit directly (commits + projects atomically, rebuilds changed units)
eval({ code: `
  import { vcs } from "@workspace/runtime";
  const base = (await vcs.resolveHead()).stateHash;
  const result = await vcs.applyEdits({
    baseStateHash: base,
    edits: [
      { kind: "write", path: "panels/my-app/index.tsx", content: { kind: "text", text: "..." } },
    ],
  });
  console.log(result.stateHash, result.changedPaths);
`
})
```

In normal flows just use the `edit`/`write` tools; they apply through
`vcs.applyEdits` for you. Source edits must land on the head this way — do not
edit via `fs.writeFile` and expect it to build, since the worktree is a
projection and builds read GAD state.

Raw `vcs` calls use VCS heads and state hashes, not filesystem cwd values:

| Need | Runtime call |
| --- | --- |
| Check current context status (unpublished changes vs main) | `await vcs.status()` |
| Check a materialized head | `await vcs.status("main")` |
| Resolve a head to a state hash | `(await vcs.resolveHead("main")).stateHash` |
| Compare committed states | `await vcs.diff(leftStateHash, rightStateHash)` |
| Read a file from the current head | `await vcs.readFile("", "panels/my-app/index.tsx")` |
| Inspect unpublished context changes | `await vcs.publishStatus()` |
| Publish your context head into main | `await vcs.publish()` |

Do not pass `process.cwd()`, `/workspace`, or a repo path to `vcs.status` or
`vcs.diff`. `vcs.status` reports unpublished changes vs `main`, not filesystem
dirtiness. `vcs.diff` compares two state hashes.

**`forkProject(options)`** — copies an existing workspace unit into a new one, rewrites safe metadata, and applies all files as one `vcs.applyEdits` transition on your context head (commits + projects atomically — no separate commit step).

```ts
import { forkProject } from "@workspace-skills/workspace-dev";

await forkProject({
  from: "panels/chat",
  to: "panels/chat-experiment",
  title: "Chat Experiment",
});

const workerPlan = await forkProject({
  from: "workers/agent-worker",
  to: "workers/agent-worker-v2",
  title: "Agent Worker V2",
  dryRun: true,
});
console.log(workerPlan.warnings);
```

Dry runs return the planned file list, metadata rewrites, and warnings without writing anything to the head. Worker forks rewrite package metadata, obvious worker file names, source strings, and Durable Object class names; pass `classMap` when a worker has more than one class.

Each context is its own VCS head (`ctx:{contextId}`), forked from the workspace
main head when the context was created. Your edits land on YOUR context head;
panels launched in your context build and serve from that head automatically.
The user's `main` head is never touched by agent edits — publishing your
context head into `main` (`vcs.publish`) is an explicit operation.

#### @workspace-extensions/typecheck-service.checkPanel (recommended)

Type-check a panel. The extension infers the current eval/agent context and checks that context folder, not canonical workspace source. Workspace package imports resolve through the same context tree, so context-local package edits are visible. Pass `{ contextId }` only when intentionally checking a different context. Pass the panel source path, or omit it to auto-detect from a panel caller ID.

Returns `{ diagnostics, errorCount, warningCount }` where each diagnostic has `{ file, line, column, message, severity, code }`.

```
eval({ code: `
  import { extensions } from "@workspace/runtime";
  const typecheck = extensions.use("@workspace-extensions/typecheck-service");
  // Type-check a specific panel
  const result = await typecheck.checkPanel("panels/my-app").catch((error) => ({
    error: String(error),
  }));
  if ("error" in result) return result;
  if (result.errorCount > 0) {
    console.log(result.errorCount + " errors:");
    for (const d of result.diagnostics) {
      if (d.severity === "error") console.log(d.file + ":" + d.line + " " + d.message);
    }
  } else {
    console.log("No type errors");
  }
`
})
```

#### @workspace-extensions/typecheck-service.check (advanced)

Lower-level type checking with positional args. Prefer `checkPanel` for simple whole-panel checks.

```
eval({ code: `
  import { extensions } from "@workspace/runtime";
  const typecheck = extensions.use("@workspace-extensions/typecheck-service");
  const result = await typecheck.check("panels/my-app");
  console.log(result);
`
})
```

#### @workspace-extensions/test-runner.run

Run Vitest tests for a workspace unit from inside the workspace runtime. The
extension infers the current eval/agent context and runs tests against that
context folder. Test execution goes through the approval service because tests
are code execution; the user can allow once, allow for the session, trust the
current code version, or deny.

```
eval({ code: `
  import { extensions } from "@workspace/runtime";
  const tests = extensions.use("@workspace-extensions/test-runner");
  const result = await tests.run("packages/my-lib").catch((error) => ({
    error: String(error),
  }));
  console.log(result);
`
})
```

For a single file or test name:

```
await tests.run({
  target: "packages/my-lib",
  fileFilter: "src/index.test.ts",
  testName: "handles empty input",
});
```

### Browser Data

```typescript
import { browserData } from "@workspace/panel-browser";
```

Available methods:

| Method                                               | Description                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `browserData.detectBrowsers()`                       | Detect all installed browsers and their profiles             |
| `browserData.startImport(request)`                   | Import data from a browser profile                           |
| `browserData.getImportHistory()`                     | Get log of past imports                                      |
| `browserData.getBookmarks(folderPath?)`              | Get bookmarks in a folder                                    |
| `browserData.searchBookmarks(query)`                 | Search bookmarks by title/URL                                |
| `browserData.addBookmark(bookmark)`                  | Add a bookmark                                               |
| `browserData.deleteBookmark(id)`                     | Delete a bookmark                                            |
| `browserData.getHistory(query)`                      | Query browsing history (search, time range, limit)           |
| `browserData.searchHistory(query, limit?)`           | Full-text search history                                     |
| `browserData.clearAllHistory()`                      | Clear all history                                            |
| `browserData.getPasswords()`                         | Get all stored passwords                                     |
| `browserData.getPasswordForSite(url)`                | Get passwords for a specific site                            |
| `browserData.addPassword(pw)`                        | Add a password                                               |
| `browserData.getCookies(domain?)`                    | Get cookies, optionally filtered by domain                   |
| `browserData.clearCookies(domain?)`                  | Clear cookies                                                |
| `browserData.getSearchEngines()`                     | Get configured search engines                                |
| `browserData.setDefaultEngine(id)`                   | Set the default search engine                                |
| `browserData.getAutofillSuggestions(field, prefix?)` | Get autofill suggestions                                     |
| `browserData.getPermissions(origin?)`                | Get site permissions                                         |
| `browserData.setPermission(origin, perm, setting)`   | Set a site permission                                        |
| `browserData.exportBookmarks(format)`                | Export bookmarks (`"html"`, `"json"`, `"chrome-json"`)       |
| `browserData.exportPasswords(format)`                | Export passwords (`"csv-chrome"`, `"csv-firefox"`, `"json"`) |
| `browserData.exportCookies(format)`                  | Export cookies (`"json"`, `"netscape-txt"`)                  |
| `browserData.exportAll()`                            | Full JSON export of all data                                 |

#### Detect and import

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const browsers = await browserData.detectBrowsers();
  console.log(browsers.map(b => b.displayName + ": " + b.profiles.length + " profiles"));
`
})
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
    profile,
    dataTypes: ["bookmarks", "history", "cookies"],
  });
  for (const r of results) {
    console.log(r.dataType + ": " + r.itemCount + " imported, " + r.skippedCount + " skipped");
    if (r.warnings.length) console.log("  warnings:", r.warnings);
  }
`
})
```

#### Search and export

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const bookmarks = await browserData.searchBookmarks("github");
  console.log("Found", bookmarks.length, "bookmarks");
  const html = await browserData.exportBookmarks("html");
  console.log("Exported", html.length, "bytes of HTML");
`
})
```

### Panel Lifecycle

#### First launch

```
eval({ code: `
  import { openPanel } from "@workspace/runtime";
  // Edits made via the edit/write tools are already committed to your head.
  await openPanel("panels/my-app");
`
})
```

#### Rebuild after edits

```
eval({ code: `
  import { openPanel } from "@workspace/runtime";
  // Your edits are already committed (edit-first); just reload the open panel.
  const handle = await openPanel("panels/my-app");
  const lifecycle = await handle.rebuildAndReload();
  console.log(lifecycle.status, lifecycle.effectiveVersion);
`
})
```

When iterating on an already-open panel after committed code changes, reuse its
handle from `scope` or rediscover it with `listPanels()`, then call
`handle.rebuildAndReload()`. It is target-only and does not recurse into
children. `handle.rebuildPanel()` only invalidates/prebuilds the target bundle;
it does not reload the renderer. `handle.reload()` is a browser-style renderer
reload; it does not rebuild code by itself and can cancel an eval running inside
that same target after the command is sent.

Lifecycle calls return a structured result with `panelId`, `operation`,
`status`, `loaded`, `rebuilt`, `reloaded`, `buildRevision`, and
`effectiveVersion` when the host can report those values.

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

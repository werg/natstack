# Agent Tools Reference

Your working directory is the **context folder** — an isolated copy of the workspace.

**CRITICAL RULES:**

- All file paths are **relative to your working directory** (e.g., `panels/my-app/index.tsx`)
- **NEVER** use host absolute paths (e.g., `/home/.../workspace/panels/...`). Runtime `fs.*` accepts context-root absolute paths like `/panels/my-app/index.tsx`, but prefer `panels/my-app/index.tsx` in examples and source edits.
- **NEVER** use `Bash` for git operations, file listing, or file creation — use the structured tools
- In eval, `rpc`, `services`, `fs`, `ctx`, `scope`, `scopes`, `db`, `help` (and, in agent eval, `chat`) are **injected free variables** — do **not** import them. Raw service catalog calls always work as `rpc.call("<svc>.<method>", [args])`; `services.<svc>` is convenience sugar and may be an ergonomic runtime client when the name collides (`services.workers` is `workers`). For workspace/npm **packages**, use a **static import** (`import { createProject } from "@workspace-skills/workspace-dev"`). Dynamic `await import(...)` may work in some builds, but it bypasses the loader's static dependency planning and is not the supported pattern.

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

Supported types: `panel`, `package`, `skill`, `project`, `worker`. Each scaffolds into its repo directory (`panels/`, `packages/`, `skills/`, `projects/`, `workers/`).

The scaffold runs the full dev loop for you: it writes the files (edit), commits
them with a scaffold message (commit), and pushes the new repo so its `main` is
created from empty (push). The new repo is build-gated green on return; your
follow-up `edit`/`write` changes are uncommitted working edits — `vcs.commit`
then `vcs.push` to ship them.

Do **not** use `createProject` for a context-local temporary repo that might
never be published. A repo path is established by writing any file inside it:
`write`/`edit`/`vcs.edit` to `projects/tmp-name/note.md` is enough. You may
leave it as uncommitted working state, `vcs.commit` it as a context-local
snapshot, or later `vcs.push({ repoPaths: ["projects/tmp-name"] })` if it should
become visible on `main`.

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
| `projectType` | string | Yes | One of: `panel`, `package`, `skill`, `project`, `worker` |
| `name` | string | Yes | Project name (kebab-case) |
| `title` | string | No | Human-readable title (defaults to name) |

---

## eval

Execute TypeScript/JavaScript code server-side in your own persistent sandbox (a per-agent EvalDO). It runs even when no panel is open. In eval, `rpc`, `services`, `fs`, `ctx`, `scope`, `scopes`, `db`, `help` (and, in agent eval, `chat`) are injected free variables; reach raw service catalog methods through `rpc.call("<svc>.<method>", [args])`. Use rich runtime bindings (`workers`, `vcs`, `fs`, etc.) directly for normal workspace operations; `services.<svc>` is convenience sugar for non-colliding service names. Do **not** import the injected names from `@workspace/runtime`.

**IMPORTANT:**

- Use static `import` syntax for **packages** (workspace/npm). Dynamic `await import(...)` is a fallback only for ordinary browser/ESM code; do not use it for workspace packages.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `code` | string | Yes | Code to execute |
| `syntax` | `"typescript"` \| `"tsx"` \| `"jsx"` | No | Syntax mode (default: `"tsx"`) |
| `imports` | `Record<string, string>` | No | Packages to build on-demand. Workspace packages: `"latest"` or a git ref. npm packages: `"npm:<version>"` (e.g. `"npm:^4.17.21"`, `"npm:latest"`) |

### Panel APIs

`openPanel`/`listPanels`/`getPanelHandle`/`panelTree` are part of the **portable runtime surface** — importable from `@workspace/runtime` (and injected ambiently) in panel, worker, **and server-side eval**. They are host-mediated over RPC: in eval they create/inspect panels via the server. A handful of panel-only extras (`panel.focusPanel`, `buildPanelLink`, `panel.reopen`, `panel.stateArgs`, `adblock`, `journal.Journal`, `agentApi`) are NOT in the eval surface — those need a real panel host:

| API                            | Description                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `openPanel(source, opts?)`     | Open any panel — URLs become browser panels, source paths open workspace panels (eval too) |
| `buildPanelLink(source, opts)` | Build a URL for panel navigation (panel/component code — not in eval)            |
| `panel.focusPanel(panelId)`    | Focus an existing panel by ID (panel/component code — not in eval)               |

`openPanel(source)` creates a new panel for main/pushed code. It does not take a
build `ref` and it must not be used as proof that context-local panel edits are
running. To run panel code from the current context branch, use a host/navigation
path that explicitly carries `ref: \`ctx:${ctx.contextId}\``; `contextId` alone
only selects the panel's filesystem/storage context.

In **eval**, `rpc` is the same portable client shape used by panels and workers:
`rpc.call(target, method, args)`. Raw server services target `"main"`, for
example `rpc.call("main", "build.getBuild", ["panels/my-app"])` or
`chat.rpc.call("main", "build.recompute", [])`.

### Using extensions

Extensions are **declared** in `meta/natstack.yml` under `extensions:`. That declaration is the only way to add or remove one. To start using an extension, add it to the `extensions:` list in `meta/natstack.yml`; saving that change (a gated meta write) raises one joint approval covering every newly-declared extension. Once approved and running, call it. **From eval**, invoke an extension method via
`services.extensions.invoke(name, "method", [args])` (the underlying RPC); list
availability with `rpc.call("main", "extensions.list", [])`. **In panel/component code**,
use the typed client `extensions.use(name)` instead (panel-runtime sugar over the
same RPC). Individual extension methods can still request their own approvals when
the operation needs one, such as running tests.

The panel-runtime `extensions.use(name)` is synchronous and returns a method
proxy; do not `await` it and do not call `.catch(...)` on it. Catch the method
call instead: `await extensions.use(name).method(...).catch(...)`. The eval form
`services.extensions.invoke(name, "method", [args])` returns the result promise
directly — `.catch(...)` it as usual. Either form fails with `ENOEXT` if the
extension is not declared, or `ENOTREADY` if it is still starting. If you need an
extension that isn't declared yet, edit `meta/natstack.yml`.

Extension methods normally use unary RPC and must return JSON-serializable values. If an extension method returns a `Response` or `ReadableStream`, declare it when creating the client so the runtime uses streaming RPC end-to-end. Streaming `Response`/`ReadableStream` methods need the panel-runtime typed client (`extensions.use`), so this runs in panel/component code, not server-side eval:

```tsx
import { extensions } from "@workspace/runtime";

type ShellApi = {
  attach(sessionId: string): Promise<Response>;
  write(sessionId: string, data: string): Promise<void>;
};

const shell = extensions.use<ShellApi>("@workspace-extensions/shell", {
  streamingMethods: ["attach"],
});
```

To check whether an extension is available before calling it from eval, list the registry with `rpc.call("main", "extensions.list", [])`:

```ts
eval({
  code: `
  const name = "@workspace-extensions/image-service";
  const entry = (await rpc.call("main", "extensions.list", [])).find((e) => e.name === name);
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

From eval, prefer the ergonomic runtime clients (`workers`, `vcs`, `fs`, etc.)
for normal workspace operations. Use raw `rpc.call("<svc>.<method>", [args])`
when following a `docs_open` service catalog entry exactly. `services.<svc>` is
a convenience namespace for non-colliding service names, but rich runtime
bindings win on collision: `services.workers` is the same ergonomic `workers`
client, not the raw `workers` service catalog.

#### Worker lifecycle (runtime entity API)

Launch, list, and retire workers through the **runtime entity API**. Available to
panels, workers, and server callers. The raw form is
`rpc.call("main", "runtime.<method>", [...])`.

```
// Launch a worker — `key` names the instance
eval({ code: `
  const handle = await rpc.call("main", "runtime.createEntity", [{
    kind: "worker",
    source: "workers/my-worker",
    key: "my-worker",
    contextId: ctx.contextId,
    ref: \`ctx:${ctx.contextId}\`, // for worker code created/edited in this context
  }]);
  scope.workerId = handle.id; // e.g. "worker:workers/my-worker:my-worker"
  console.log("Worker started:", handle.id, "→ target", handle.targetId);
`
})

// List running workers
eval({ code: `
  const list = await rpc.call("main", "runtime.listEntities", [{ kind: "worker" }]);
  console.log(list.map(w => w.id + " (" + w.source + ")"));
`
})

// Retire (stop) a worker — pass the id from the launch handle (or listEntities)
eval({ code: `
  await rpc.call("main", "runtime.retireEntity", [{ id: scope.workerId }]);
`
})
```

`contextId` selects the worker's runtime storage/state partition. It does not
select the code build. Pass `ref: \`ctx:${ctx.contextId}\`` when launching a
worker you just created or edited on the current context head. Omit `ref` only
when you intentionally want the main workspace build.

Launch/list/retire: `runtime.createEntity({ kind: "worker", source, key, contextId, env, stateArgs, ref? })` returns a handle (`{ id, targetId, … }`); `runtime.listEntities({ kind: "worker" })`; `runtime.retireEntity({ id })`. The `workers` binding exposes only service resolution — `listServices()`, `resolveService(...)`, `resolveDurableObject(...)`, `durableObjectService(...)`. To duplicate or tear down a whole context's durable state (every DO's storage + the file snapshot), use `runtime.cloneContext({ sourceContextId, include? })` → `{ contextId, entities }` and `runtime.destroyContext({ contextId })` — both gated by the context-boundary capability; the low-level cloneDO/destroyDO primitives are server-internal. See [WORKERS.md](WORKERS.md) for the service-resolution API.

#### Version control (GAD-native, edit → commit → push)

Workspace version control is GAD-native and **per-repo**. Each workspace repo
(`packages/foo`, `panels/chat`, `projects/<vault>`, `meta`) is its own versioned
unit with its own history. The model is three layers:

1. **edit** — `vcs.edit` (what the `edit`/`write` tools call) records file
   changes as **uncommitted working edits** on your context head. They are
   tracked durably with full provenance and projected to disk so the worktree
   reflects them, but they are **NOT a commit**: no commit-log entry, no head
   advance, no build, and they never show in `vcs.log`.
2. **commit** — `vcs.commit({ message })` folds your uncommitted edits into one
   deliberate, messaged snapshot per repo, advancing each repo's context head.
   `message` is mandatory. This is your milestone, queryable via `vcs.log` /
   `vcs.commitEdits`.
3. **push** — `vcs.push({ repoPaths })` ships committed snapshots into each
   repo's `main`. `main` advances **only** via push. Push is **fast-forward-only**
   and **build-gated**.

```
// 1. edit (the edit/write tools do this for you; direct call shown for clarity)
eval({ code: `
  const result = await services.vcs.edit({
    edits: [
      { kind: "write", path: "panels/my-app/index.tsx", content: { kind: "text", text: "..." } },
    ],
  });
  // { head, stateHash, committed: false, status: "uncommitted", editSeq, changedPaths }
  console.log(result.status, result.changedPaths);
`
})

// 2. commit a deliberate snapshot
eval({ code: `
  const commits = await services.vcs.commit({ message: "Wire up the form" });
  for (const c of commits) console.log(c.repoPath, c.status, c.editCount);
`
})

// 3. push (build-gated, ff-only)
eval({ code: `
  const r = await services.vcs.push({ repoPaths: ["panels/my-app"] });
  console.log(r.status); // "pushed" | "up-to-date" | "diverged" | "build-failed"
`
})
```

Source edits must land on the head through `vcs.edit` (i.e. the `edit`/`write`
tools) — do not edit via `fs.writeFile` and expect it to commit or build, since
the worktree is a projection and VCS reads GAD state. Reads (`vcs.readFile`,
`fs.*`, build/preview) see your **working** content (committed head + uncommitted
edits).

**Push outcomes** — `vcs.push` returns a discriminated union on `status`:

- `"pushed"` / `"up-to-date"` → green; `main` advanced (or already matched).
  Carries `reports` (per-repo build reports).
- `"diverged"` → `main` moved past your context's merge-base, so a
  fast-forward is impossible. Carries `divergences`. Reconcile with
  `vcs.merge(repoPath)` (pulls `main` into your head as a merge commit), then
  `vcs.commit` if conflicts needed resolving, then push again.
- `"build-failed"` → **no head advanced.** Carries `reports` with structured
  diagnostics (`file:line:col  severity  message`). Fix the cited lines and
  re-push.

Push **rejects (throws) if you have uncommitted edits** in a repo you're
pushing — commit first. Push multiple repoPaths to ship them as one atomic
group (all advance or none).

```
// Preview-build working content WITHOUT committing (dev preview; no main, no EV baseline)
eval({ code: `
  const reports = await services.vcs.previewBuild({ repoPaths: ["panels/my-app"] });
  for (const rep of reports) {
    for (const b of rep.builds) {
      for (const d of b.diagnostics) console.log(\`\${d.file}:\${d.line}:\${d.column} \${d.message}\`);
    }
  }
`
})

// Drop uncommitted edits (abort / stash-drop) — also clears a pending merge
eval({ code: `
  const { discarded, stateHash } = await services.vcs.discardEdits("panels/my-app");
  console.log("dropped", discarded, "edits");
`
})
```

Raw `vcs` calls are **per-repo** and use repo paths + VCS heads, not filesystem
cwd values:

| Need | Runtime call |
| --- | --- |
| Record working edits (what `edit`/`write` call) | `await vcs.edit({ edits: [...] })` |
| Commit working edits into a snapshot | `await vcs.commit({ message: "…" })` |
| Drop uncommitted edits (+ clear pending merge) | `await vcs.discardEdits("panels/my-app")` |
| A repo's unpushed changes (its committed head vs main) + `uncommitted` count | `await vcs.status("panels/my-app")` |
| How far a repo is ahead of main + uncommitted/diverged flags | `await vcs.pushStatus(["panels/my-app"])` |
| A repo's commit history | `await vcs.log("panels/my-app", 50)` |
| The edit-ops a commit owns | `await vcs.commitEdits("panels/my-app", { eventId })` |
| File history / blame (commit-lineage order) | `await vcs.fileHistory("panels/my-app", "index.tsx")` |
| Walk a commit's ancestry (event DAG) | `await vcs.commitAncestors("panels/my-app", eventId)` |
| Resolve a repo's head to a state hash | `(await vcs.resolveHead("main", "panels/my-app")).stateHash` |
| Read a file from a repo's head (working content) | `await vcs.readFile("", "index.tsx", "panels/my-app")` |
| Compare two committed states | `await vcs.diff(leftStateHash, rightStateHash)` |
| Build-gate committed changes into main (ff-only) | `await vcs.push({ repoPaths: ["panels/my-app"] })` |
| Preview-build working content (no commit, no main) | `await vcs.previewBuild({ repoPaths: ["panels/my-app"] })` |
| Reconcile a diverged push (pull main into your head) | `await vcs.merge("panels/my-app")` |
| Fork a repo to a new path (keep history) | `await vcs.forkRepo("panels/chat", "panels/mychat")` |
| What your context has touched / drifted | `await vcs.contextStatus()` → `{repoPath, forked, uncommitted, ahead, behind, deleted}[]` |
| Pull latest main into your context | `await vcs.rebaseContext()` |

`vcs.status(repoPath, head?)` reports a repo subtree's committed
`{added, removed, changed}` vs that repo's own `main` plus an `uncommitted` count
(working edits not yet committed) — a state diff, not filesystem dirtiness.
`vcs.diff` compares two state hashes.

**Context isolation & rebase.** Your context is a *pinned snapshot* — reads don't
drift as other contexts advance `main`. `vcs.contextStatus()` flags repos you're
`ahead` on (commit + push them), `uncommitted` on (working edits to commit), or
`behind` on (main moved past your pin); `vcs.rebaseContext()` merges latest
`main` into your edited repos and re-pins your base. The context folder is
**sparse** (a repo's files materialize on first edit/read); `vcs.*`/`fs.*` handle
materialization for you.

**Forking.** Prefer **`vcs.forkRepo(fromPath, toPath)`** to fork a repo to a new
path **preserving history** — the new repo's `log` shows the inherited commits and
your edits build on the forked lineage; its `package.json` name leaf is auto-rewritten
so it's build-valid (do any deeper renames yourself, then push). The
**`forkProject(options)`** skill is a from-scratch *source tree copy* (rewrites
component/class names, no inherited history) when you want a clean independent
unit. It copies only trackable workspace source and skips platform/generated
artifacts such as `.gad/`, `.git/`, `node_modules/`, `dist/`, `.env`, and logs.
Non-dry runs perform edit → commit → push for the new repo.

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

Your edits land on your own per-repo context head (`ctx:{contextId}` on each
repo's `vcs:repo:<path>` log), forked from that repo's `main`. Panels launched in
your context build and serve from your head automatically. A repo's `main` is
never touched by agent edits — shipping is the explicit, build-gated
`vcs.push({ repoPaths })`. A brand-new repo (files created under a new
`<section>/<name>/`) has no `main` yet; its first `vcs.push` creates `main` from
empty.

For throwaway project repos, skip scaffolding entirely: write a file such as
`projects/tmp-name/note.md`. That creates context-local working content for repo
`projects/tmp-name`; it remains private to the context until you explicitly
commit and push that repo. `createProject({ projectType: "project", ... })`
creates only a README, but it also immediately commits and pushes, so it is for
published workspace projects rather than private scratch space.

#### @workspace-extensions/typecheck-service.checkPanel (recommended)

Type-check a panel. The extension infers the current eval/agent context and checks that context folder, not canonical workspace source. Workspace package imports resolve through the same context tree, so context-local package edits are visible. Pass `{ contextId }` only when intentionally checking a different context. Pass the panel source path, or omit it to auto-detect from a panel caller ID.

Returns `{ diagnostics, errorCount, warningCount }` where each diagnostic has `{ file, line, column, message, severity, code }`.

```
eval({ code: `
  // Type-check a specific panel (extensions reached via services.extensions.invoke in eval)
  const result = await services.extensions.invoke(
    "@workspace-extensions/typecheck-service",
    "checkPanel",
    ["panels/my-app"],
  ).catch((error) => ({
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
  const result = await services.extensions.invoke(
    "@workspace-extensions/typecheck-service",
    "check",
    ["panels/my-app"],
  );
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
  const result = await services.extensions.invoke(
    "@workspace-extensions/test-runner",
    "run",
    ["packages/my-lib"],
  ).catch((error) => ({
    error: String(error),
  }));
  console.log(result);
`
})
```

For a single file or test name:

```
await services.extensions.invoke("@workspace-extensions/test-runner", "run", [{
  target: "packages/my-lib",
  fileFilter: "src/index.test.ts",
  testName: "handles empty input",
}]);
```

### Browser Data

```typescript
import { browserData } from "@workspace/panel-browser";
```

Available methods:

| Method                                               | Description                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `browserData.detectBrowsers()`                       | Detect all installed browsers and their profiles             |
| `browserData.startImport(request)`                   | Incrementally import data from a browser profile             |
| `browserData.getOpenTabs(request)`                   | Preview current Firefox/Chrome-family tabs                   |
| `browserData.openTabsAsPanels(request)`              | Open current HTTP(S) tabs as NatStack browser panels         |
| `browserData.getImportHistory()`                     | Get log of past imports                                      |
| `browserData.getBookmarks(folderPath?)`              | Get bookmarks in a folder                                    |
| `browserData.searchBookmarks(query)`                 | Search bookmarks by title/URL                                |
| `browserData.addBookmark(bookmark)`                  | Add a bookmark                                               |
| `browserData.deleteBookmark(id)`                     | Delete a bookmark                                            |
| `browserData.getHistory(query)`                      | Query unified imported + NatStack browser-panel history      |
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

`startImport` is source-keyed and incremental for the same browser/profile.
Repeat imports update changed records and add new records without duplicating
bookmarks, history visits, cookies, passwords, autofill values, search engines,
permissions, or favicons. `openTabsAsPanels` is an action and creates panels on
each call.

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

`openPanel` and panel handles are host-mediated over RPC and work in panel,
worker, **and server-side eval** (they're part of the portable runtime surface).
You can drive panel lifecycle from eval, panel code, or an
`inline_ui`/`feedback_custom` component:

#### First launch

```tsx
import { openPanel } from "@workspace/runtime";
// Opens the main/pushed build. Plain openPanel() does not infer code provenance
// from your contextId.
await openPanel("panels/my-app");
```

#### Rebuild after edits

```tsx
import { openPanel } from "@workspace/runtime";
// Rebuilds the panel's current build ref: explicit ref if the panel was pinned,
// otherwise main. It does not infer ctx:<contextId> from the panel context.
const handle = await openPanel("panels/my-app");
const lifecycle = await handle.rebuildAndReload();
console.log(lifecycle.status, lifecycle.effectiveVersion);
```

When iterating on an already-open panel after code changes, reuse its
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

Workspace-local operating guide for NatStack agents. This section focuses on workspace-specific paths, APIs, and diagnostics.

## Filesystem layout

Your file root IS the workspace root. Top-level directories: `about/`, `apps/`, `extensions/`, `meta/`, `packages/`, `panels/`, `projects/`, `skills/`, `templates/`, `workers/`. Always use paths relative to that root (`skills/sandbox/SKILL.md`, `panels/my-app/index.tsx`) — never prefix them with `workspace/`, `/workspace/`, or an absolute machine path, and don't probe with `process.cwd()` (not available in the sandbox).

## Tool guidance

- **read / ls / grep / find / edit / write** are native file tools over your workspace root — prefer them for reading docs and editing source; use **eval** when you need to run code.
- **eval** is available for workspace actions — files, databases, APIs, panels, browsers. Use static imports (not dynamic await import()). `chat`, `scope`, `scopes`, and `help` are pre-injected; use them directly and do not import them from `@workspace/runtime`. Import `contextId` from `@workspace/runtime`. Every eval result includes a `[scope]` summary showing current keys.
- Quick patterns: `fs.readFile(path)` / `fs.writeFile(path, data)` for files. `this.sql.exec("SELECT ...")` inside a Durable Object for databases (db is a client — call `.open()` first). Load the **sandbox** skill for the full API reference.
- Workspace source edits are **edit-first**: the `edit`/`write` tools and `vcs.applyEdits` apply each change as one atomic GAD transition on your context head and project it to disk — the edit IS the commit, with no separate step (`fs.writeFile` to a source path is GAD-backed the same way). `vcs.status()` takes no path argument (its optional argument is a materialized head such as `main` or `ctx:...`); it reports your head's unpublished changes vs `main` — a state-diff, not filesystem dirtiness, so editing a file does not make it report "dirty." `vcs.diff(leftStateHash, rightStateHash)` compares state hashes, so use the `stateHash` from `vcs.applyEdits` or `vcs.resolveHead(head)`. Use `vcs.publish()` to publish your context head into `main`. Do not use `node:child_process`, shell commands, raw `isomorphic-git`, or manually constructed clients for workspace source edits. For external Git remotes, use `@natstack/git` with `credentials.gitHttp()`.
- Call **set_title** after the first substantive exchange.
- **Tool availability is runtime-dependent.** `inline_ui`, `load_action_bar`, `feedback_form`, and `feedback_custom` are advertised by chat panels and only appear when a panel is connected. In headless contexts (workers, automated harnesses, tests) they will be absent — return data via eval results and ask follow-up questions through normal conversation messages instead. Do not assume a tool exists; rely on what's actually exposed to you.

## Scope

`scope` is a live in-memory object shared across eval calls — store anything (handles, pages, functions, data) and it all works between calls. After every eval, the result includes a `[scope]` line listing current keys. Scope is serialized to DB automatically; on panel reload, data survives but functions and class instances are lost. A system message will list what was restored, partially restored, or lost.

## Workspace skills

Skills have two parts: **documentation** (read via the read tool) and optionally **code exports** (used via JS `import` in eval). Read the docs first — they explain what the skill does and how to use it.

To read a skill's docs: `read("skills/<name>/SKILL.md")`

Some skills also export code you can use in eval. Workspace packages (`@workspace-skills/*`, `@workspace/*`, `@natstack/*`) are **auto-resolved** — just write the `import` and they're built on first use:

```
eval({ code: `import { createProject } from "@workspace-skills/workspace-dev"; ...` })
```

npm packages require the `imports` parameter: `imports: { "lodash": "npm:4" }`

Before using eval, read the **sandbox** skill — it has the complete API reference.

- **sandbox** — **read this first** — eval patterns, complete runtime API reference, inline_ui, feedback forms, browser automation
- **workspace-dev** — building panels, workers, Durable Objects; exports `createProject`, `forkProject`
- **browser-import** — importing cookies, passwords, bookmarks, history from installed browsers
- **api-integrations** — connecting to OAuth APIs (Gmail, GitHub, Slack, Notion, Linear)
- **agent-tuning** — changing the host chat agent's model/provider defaults and live effort, approval, and chattiness
- **onboarding** — first-time setup, workspace configuration, NatStack overview
- **system-testing** — headless test runner; exports `HeadlessRunner`, `TestRunner`, test suites
- **web-research** — searching the open web and reading pages with `web_search`, `web_fetch`, `web_read`

## Diagnostics — querying unit errors, logs, and build failures

Every workspace unit (panel, worker, DO, extension, app) feeds a per-unit diagnostics store. When something fails — a build breaks, a worker won't start, a panel's renderer crashes or logs errors — query it here instead of guessing:

```js
import { workspace } from "@workspace/runtime";

// One-stop health check: unit status + lastError, error ring, log tail,
// and recent build events (build-error entries carry the esbuild message).
const diag = await workspace.units.diagnostics("workers/my-worker");
// → { unit: { status, lastError, ... }, errors: [...], logs: [...], builds: [...] }

// Just the log tail (level: "debug"|"info"|"warn"|"error", since: epoch ms):
const logs = await workspace.units.logs("panels/my-panel", { level: "warn", limit: 50 });

// All units with status at a glance (status "error" + lastError for failed workers):
const units = await workspace.units.list();
```

Accepts either the package name or the workspace-relative source path (`workers/foo`, `panels/bar`). What's captured per kind:

- **Workers / DOs** — `console.*` output, plus lifecycle events (started, updated, *failed to start* with the error message).
- **Panels** — console warnings/errors and lifecycle failures (renderer crash, load failure) forwarded from the shell. Full console history for a *running* panel is available via the panel CDP host (`consoleHistory` host command).
- **All kinds** — state-triggered build events in `diag.builds`; a `build-error` entry means the last edit did not deploy and `error` holds the compiler output.

From a terminal, the same data is available via the external-agent CLI: `natstack agent diag UNIT` and `natstack agent logs UNIT [--level error]`.

Debugging order when a unit misbehaves: `units.diagnostics` → check `builds` for a failed build → check `errors` for runtime failures → `units.logs` for the surrounding log context.

## Web tools

You have three tools for reaching the open web:

- `web_search({ query, max_results })` — discovery. Returns ranked `{ title, url, snippet }`. DuckDuckGo by default; auto-upgrades to Tavily, Brave, or Exa when the matching API key is set in the worker env.
- `web_fetch({ url })` — fetches a URL, extracts the main content as markdown, caches the full result in the blobstore (URL-deduped within a session), and returns `{ url, title, digest, size, head }`.
- `web_read({ digest, offset, limit })` — reads a byte range from a previously-fetched page. Use this to drill into a large page without re-fetching it.

Typical flow: `web_search` to find URLs → `web_fetch` on the most promising one → if the head doesn't answer the question, `web_read` further into the cached content. Always cite source URLs.

For grepping a cached page, targeted searches (GitHub / npm / Stack Overflow), PDF handling, or aux-model summarization, **read the `web-research` skill** — those live as eval recipes, not top-level tools.

## Style

Keep workspace-facing answers concise and concrete; prefer diagnostics and exact paths over speculation.

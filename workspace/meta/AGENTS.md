Workspace-local operating guide for NatStack agents. This section focuses on workspace-specific paths, APIs, and diagnostics.

## Filesystem layout

Your file root IS the workspace root. Top-level directories: `about/`, `apps/`, `extensions/`, `meta/`, `packages/`, `panels/`, `projects/`, `skills/`, `templates/`, `workers/`. Always use paths relative to that root (`skills/sandbox/SKILL.md`, `panels/my-app/index.tsx`) — never prefix them with `workspace/`, `/workspace/`, or an absolute machine path, and don't probe with `process.cwd()` (not available in the sandbox).

## Tool guidance

- **read / ls / grep / find / edit / write** are native file tools over your workspace root — prefer them for reading docs and editing source; use **eval** when you need to run code.
- **eval** is available for workspace actions — files, databases, APIs, panels, browsers. Use static imports (not dynamic await import()). `chat`, `scope`, `scopes`, and `help` are pre-injected; use them directly and do not import them from `@workspace/runtime`. Import `contextId` from `@workspace/runtime`. Every eval result includes a `[scope]` summary showing current keys.
- Quick patterns: `fs.readFile(path)` / `fs.writeFile(path, data)` for files. `this.sql.exec("SELECT ...")` inside a Durable Object for databases (db is a client — call `.open()` first). Load the **sandbox** skill for the full API reference.
- Workspace source uses a three-layer model: **edit → commit → push**, and `main` advances ONLY via push. An **edit** is a *working* change: the `edit`/`write` tools and `vcs.edit({ edits })` record each change as one tracked working edit on your context head and project it to disk so it builds immediately — but it is **not** a commit, carries no message, and does not appear in `vcs.log`. A **commit** (`vcs.commit({ message })`) is a deliberate, messaged milestone that folds your uncommitted working edits into a per-repo snapshot; the `message` is **mandatory**. So edit ≠ commit: you accumulate working edits as you go (each tracked with provenance — actor, turn, invocation), then commit them as named checkpoints. VCS is **per-repo**: each repo (`panels/notes`, `packages/ui`, `projects/vault`, `meta`) has its own log, `main` head, and `ctx:*` context heads. `vcs.status(repoPath, head?)` (positional args) reports that one repo's `uncommitted` working-edit count plus its committed changes vs `main` — a state-diff, not filesystem dirtiness. `vcs.diff` compares state hashes (use the `stateHash` from `vcs.edit`/`vcs.commit` or `vcs.resolveHead(head, repoPath)`). Drop unwanted working edits with `vcs.discardEdits(repoPath)` (also clears any pending merge). Advance a repo's `main` with `vcs.push({ repoPaths: [repo], sourceHead? })` — push is **fast-forward-only** and **build-gated**: it requires your edits to be committed first (uncommitted edits cause it to throw), it builds the candidate (a `build-failed` result means no head advanced — see Diagnostics below), and if `main` has moved past your base it returns `status: "diverged"` instead of force-advancing. On divergence, `vcs.merge(repoPath)` pulls `main` into your context head: a clean merge auto-commits, a conflicting merge writes conflict markers into the working files which you then resolve via `vcs.edit` and seal with `vcs.commit` before re-pushing. To check a candidate without writing an EV baseline, use `vcs.previewBuild({ repoPaths })` — an on-demand build of your **working** content. Push several repos together (`repoPaths: [a, b]`) for an atomic group push. A **brand-new** repo needs no init: create its files under `<section>/<name>/`, commit them, then the first `vcs.push` of that path *creates* its `main` from empty (a typo'd/empty path errors with `unknown repo … has no main and no content`). To branch off an existing unit **with its history**, `vcs.forkRepo(fromPath, toPath)` copies the repo to a new path and rewrites the `package.json` `name` leaf so it is build-valid (make deeper component/class renames yourself, then commit and push). Your **context is a pinned snapshot** of the workspace: reads stay on a fixed base and do not drift as `main` advances under you, so a concurrent push never changes what you see mid-task. `vcs.contextStatus()` reports, per repo, which repos your context spans (`forked` — it has its own head there), which have `uncommitted` working edits, which you're `ahead` on (push it), and which are `behind` (main moved past your pin); when you want the latest, `vcs.rebaseContext()` merges latest `main` into your forked repos and re-pins your base. Do not use `node:child_process`, shell commands, raw `isomorphic-git`, or manually constructed clients for workspace source edits. For external Git remotes, use `@natstack/git` with `credentials.gitHttp()`.
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

## Diagnostics — the push report is the primary build signal

**Build/type errors come from the push, not from polling diagnostics.** Source is built authoritatively only at the push gate (working edits never trigger a build). When you advance a repo's `main` with `vcs.push`, the server build-gates the candidate: it bundles (esbuild) and type-checks (tsc) before any head moves. (To dry-run a build of your working content before committing, call `vcs.previewBuild({ repoPaths })` — it returns the same structured diagnostics without advancing or writing a baseline.) If the push build fails, **no head advances** and the result carries the errors directly:

```js
import { vcs } from "@workspace/runtime";

const result = await vcs.push({ repoPaths: ["panels/my-panel"] });
if (result.status === "build-failed") {
  // result.reports[].builds[].diagnostics[] are STRUCTURED:
  //   { source: "esbuild"|"tsc", severity, file, line, column, message, lineText?, suggestion? }
  for (const report of result.reports)
    for (const build of report.builds)
      for (const d of build.diagnostics)
        console.error(`${d.file}:${d.line}:${d.column}  ${d.severity}  [${d.source}] ${d.message}`);
}
```

`VcsPushResult.status` is `pushed` | `up-to-date` | `diverged` | `build-failed`. A `build-failed` push did **not** advance `main` — its diagnostics are your immediate next task; fix the cited `file:line:col`, re-commit, and re-push. A `diverged` push means `main` moved past your base (push is fast-forward-only, so it refused rather than force-advancing); its `divergences` list the affected repos — run `vcs.merge(repoPath)` to fold `main` into your head (resolving any conflict markers via `vcs.edit` + `vcs.commit`), then re-push. Push also throws outright if you have uncommitted working edits — `vcs.commit({ message })` (or `vcs.discardEdits`) first. Content-only repos (`projects/<vault>`, `meta`) are ungated. Pushing a repo that breaks a dependent fails on **regression** — push the broken repos together as an atomic group.

The per-unit diagnostics store below is for **already-running** units (runtime errors, logs, crashes) — not the build gate.

## Diagnostics — querying RUNNING unit errors, logs, and build failures

Every workspace unit (panel, worker, DO, extension, app) feeds a per-unit diagnostics store. When something fails at runtime — a worker won't start, a panel's renderer crashes or logs errors — query it here instead of guessing (for *build/type* errors, read the push report above first):

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
- **All kinds** — state-triggered build events in `diag.builds`; `diag.builds[].diagnostics` carries the same structured `{ source, severity, file, line, column, message }` array as the push report (not a blob).

From a terminal, the same data is available via the external-agent CLI: `natstack agent diag UNIT` and `natstack agent logs UNIT [--level error]`. `agent diag` is for already-running units; for whether a change *builds*, the `vcs push` report is the source of truth.

Debugging order: for a *build/type* failure, read the `vcs push` report (above). For a *running* unit that misbehaves: `units.diagnostics` → check `errors` for runtime failures → `units.logs` for the surrounding log context.

## Web tools

You have three tools for reaching the open web:

- `web_search({ query, max_results })` — discovery. Returns ranked `{ title, url, snippet }`. DuckDuckGo by default; auto-upgrades to Tavily, Brave, or Exa when the matching API key is set in the worker env.
- `web_fetch({ url })` — fetches a URL, extracts the main content as markdown, caches the full result in the blobstore (URL-deduped within a session), and returns `{ url, title, digest, size, head }`.
- `web_read({ digest, offset, limit })` — reads a byte range from a previously-fetched page. Use this to drill into a large page without re-fetching it.

Typical flow: `web_search` to find URLs → `web_fetch` on the most promising one → if the head doesn't answer the question, `web_read` further into the cached content. Always cite source URLs.

For grepping a cached page, targeted searches (GitHub / npm / Stack Overflow), PDF handling, or aux-model summarization, **read the `web-research` skill** — those live as eval recipes, not top-level tools.

## Style

Keep workspace-facing answers concise and concrete; prefer diagnostics and exact paths over speculation.

---
name: sandbox
description: Execute code in the sandbox — the server-side eval tool, inline UI components, feedback forms, browser automation, and all runtime APIs (fs, db, git, workers, ai).
---

# Sandbox Execution Skill

How to use the sandbox — the `eval` tool (which runs code **server-side** in your
own per-agent `EvalDO`), inline UI components, custom feedback forms, and all
runtime APIs they can access. `eval` runs server-side and does not require a
connected panel; `inline_ui`/`load_action_bar`/`feedback_*` render in the chat
panel.

## Files

| Document                                           | Content                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [EVAL.md](EVAL.md)                                 | Eval tool — run code, stream console, static imports, package loading                                       |
| [INLINE_UI.md](INLINE_UI.md)                       | Inline UI — persistent interactive components in chat                                                       |
| [ACTION_BAR.md](ACTION_BAR.md)                     | Action bar — file-backed compact UI pinned above chat history                                               |
| [CUSTOM_MESSAGES.md](CUSTOM_MESSAGES.md)           | Custom message types — register a renderer, publish typed instances with reducer updates                    |
| [MDX.md](MDX.md)                                   | Normal rich chat messages — callouts, badges, tables, ActionButton                                          |
| [FEEDBACK.md](FEEDBACK.md)                         | Feedback forms — block until user responds                                                                  |
| [RUNTIME_API.md](RUNTIME_API.md)                   | Full runtime API reference — fs, db, workers, ai, git, browser data, custom shared-resource approval grants |
| [CHAT_API.md](CHAT_API.md)                         | Chat API — publish messages, call methods, interact with the conversation                                   |
| [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md)     | Browser automation — Playwright-style page API via the lightweight CDP client                               |
| [PATTERNS.md](PATTERNS.md)                         | Common patterns and recipes                                                                                 |
| [INTERACTION_PATTERNS.md](INTERACTION_PATTERNS.md) | When to use inline UI for side-effect actions with choices/complexity                                       |

## Execution Modes

All code runs through the same compile pipeline (Sucrase transform + CJS
execution). **`eval` executes server-side in your per-agent `EvalDO`** (a
Durable Object) — it does not run in the panel and does not require a connected
panel. **`inline_ui`/`load_action_bar`/`feedback_custom` render React in the
chat panel** (panel-only). Eval/UI tools accept either raw `code` or a
context-relative `path` where noted; file-loaded sources support static relative
imports and infer bare package imports from the nearest `package.json` when
possible. The execution modes differ in presentation:

| Tool              | Where it runs              | Rendering                          | Lifecycle                         | Response                             |
| ----------------- | -------------------------- | ---------------------------------- | --------------------------------- | ------------------------------------ |
| `eval`            | server-side (`EvalDO`)     | imperative (run + return)          | persistent scope/`db`             | immediate (result to agent)          |
| `inline_ui`       | panel                      | component (render React)           | persistent (in chat history)      | none (fire-and-forget)               |
| `load_action_bar` | panel                      | component from file (render React) | persistent (top of current panel) | immediate tool result                |
| `feedback_custom` | panel                      | component (render React)           | transient                         | deferred (blocks until user submits) |

## Injected Variables

The two surfaces inject **different** variables, because eval runs server-side
and components render in the panel:

- **`eval`** (server-side): `rpc`, `services`, `fs`, `ctx`, `scope`, `scopes`,
  `db`, and `help` are injected as free variables — use them directly, do NOT
  `import` them, and do NOT `import` them from `@workspace/runtime` (the eval
  engine rejects importing the pre-injected names). See
  [EVAL.md](EVAL.md#injected-variables). When eval runs as an **agent** (bound
  to a channel), `chat` is injected too (see [EVAL.md](EVAL.md#chat-agent-eval));
  CLI/panel eval has no channel and gets no `chat`.
- **`inline_ui` / `load_action_bar` components** (panel): receive
  `{ props, chat }`. `feedback_custom` components receive
  `{ onSubmit, onCancel, onError, chat }`. They do NOT receive `scope`/`scopes`
  — the eval REPL scope is server-side and is not shared into rendered
  components. Inside a component, reach runtime services via `chat.rpc.call(...)`
  (see [CHAT_API.md](CHAT_API.md)).

For panel identity inside components, use `panel.slotId` for panel-tree
operations and PubSub/channel clients. `rpc.selfId` is the current live runtime
entity and can change after a panel navigation or reopen.

## Path Conventions

- `eval`, `inline_ui`, `load_action_bar`, and `feedback_custom` `path`
  parameters are context-relative file paths such as `.natstack/eval/audit.ts`;
  do not prefix these with `/`.
- Runtime `fs.*` methods are rooted at the caller's current context folder. A
  leading slash in `fs.readFile("/panels/chat/package.json")` means
  "context-root absolute", not a host path like `/home/...`. Prefer
  `panels/chat/package.json` in examples and source edits because it is less
  ambiguous.
- Never use host absolute paths for workspace source such as
  `/home/user/.../workspace/panels/...`.

## Available Imports

### In `eval` (server-side)

The injected variables above (`rpc`, `services`, `fs`, `ctx`, `scope`, `scopes`,
`db`, `help`) are NOT imports — use them as free variables. Everything else is
loaded via the `imports` parameter (npm) or auto-resolution (workspace), then
brought in with a normal `import`. Both static `import` and dynamic
`await import(...)` work in eval — both compile to the EvalDO's per-object
require (isolated per owner). See [EVAL.md](EVAL.md#imports).

### In components (`inline_ui` / `load_action_bar` / `feedback_custom`)

These are pre-bundled with the panel and work as bare `import` statements in
component code:

| Module                       | What it provides                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@workspace/runtime`         | rpc, fs, git, db, workers, ai, workspace, contextId, panel navigation, `approvals.request` for custom shared resources |
| `@workspace/panel-browser`   | Browser data import/export (cookies, passwords, bookmarks, history)                                             |
| `react`, `react/jsx-runtime` | React hooks and component APIs                                                                                  |
| `@radix-ui/themes`           | UI components (Button, Flex, Card, Table, etc.)                                                                 |
| `@radix-ui/react-icons`      | Icon components                                                                                                 |

### On-demand imports (require `imports` parameter)

For browser automation, use `handle.cdp.lightweightPage()` — it returns a
Playwright-style page driven by our own lightweight, workerd-native CDP client
and is the single browser-automation surface (there is no separate "full
Playwright" tier; do not import or install any `playwright*` package). It loads
the standalone `@workspace/cdp-client` internally, so eval code should not import
that package directly for ordinary page work. For protocol-level CDP, you may
`import { CdpConnection } from "@workspace/cdp-client"` and connect via
`handle.cdp.getCdpEndpoint()`. See [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md).

These are built on first use. Pass them in the tool's `imports` parameter:

| Module                  | `imports` value                  | What it provides                      |
| ----------------------- | -------------------------------- | ------------------------------------- |
| `@workspace-skills/*`   | auto-resolved                    | Just `import` — built on first use    |
| `@workspace/*` packages | auto-resolved                    | Just `import` — built on first use    |
| `@natstack/*` packages  | auto-resolved                    | Just `import` — built on first use    |
| npm packages            | `imports: { "lodash": "npm:^4.17.21" }` | Requires explicit `imports` parameter |

Workspace packages (`@workspace*`, `@natstack/*`) are **auto-resolved** — just write the `import` statement in your code and they're built on-demand. No `imports` parameter needed.

npm packages require the `imports` parameter with `"npm:<version>"` for raw inline code, using registry semver/range values such as `"npm:1"`, `"npm:1.3.0"`, or `"npm:^4.17.21"`. File-loaded code can infer dependency versions from the nearest `package.json`.

File-loaded package inference checks `dependencies`, `peerDependencies`,
`optionalDependencies`, then `devDependencies`. It also supports
`package.json` `imports` aliases and simple `tsconfig.json` paths. Use explicit
`imports` to override inferred versions.

To pin a workspace package to a specific VCS ref or state hash, use the `imports` parameter explicitly: `imports: { "pkg": "ctx:agent-1" }`.

In eval, injected ambient globals like `services`, `ctx`, `scope`, `scopes`,
`db`, `chat`, `agent`, and `help` are free variables, not runtime exports. For
portable client code, `@workspace/runtime` is importable in eval and exports
namespaces such as `vcs`, `fs`, `workspace`, `credentials`, and `panelTree`:

```
eval({ code: `
  import { vcs } from "@workspace/runtime";
  import { createProject } from "@workspace-skills/workspace-dev";
  const status = await vcs.status("panels/chat"); // or services.vcs.status("panels/chat")
  // workspace packages: just import, auto-resolved
` })
```

`vcs.status(repoPath, head?)` takes a repo path (positional), not a filesystem
path; its optional second argument is a materialized VCS head such as `main` or
`ctx:...`. It reports that repo head's `uncommitted` working-edit count and its
committed changes vs the repo's own `main`, not filesystem dirtiness. Record a
working change with `vcs.edit({ edits })`, seal a milestone with the mandatory-
message `vcs.commit({ message })`, then ship committed changes into `main` with
the fast-forward-only, build-gated `vcs.push({ repoPaths: ["panels/chat"] })`.
For diffs, pass state hashes from `vcs.edit`/`vcs.commit` or `vcs.resolveHead`,
not workspace paths.

See [EVAL.md](EVAL.md) for details. On-demand imports are not available in inline_ui/load_action_bar/feedback_custom components (use eval to preload first).

## Interaction Patterns

See [MDX.md](MDX.md) for rich normal chat messages and `ActionButton`.
See [INTERACTION_PATTERNS.md](INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. In short: if an action involves choices or could fail, prefer rendering an inline UI that lets the user trigger it. When a UI control represents a user choice or follow-up instruction that should go back to the agent, send that prompt with `chat.send(content)`. Use [ACTION_BAR.md](ACTION_BAR.md) when small controls or status should stay pinned above chat history for the current panel. For setup workflows with links, use the [INLINE_UI.md](INLINE_UI.md) link/checklist patterns and offer both internal browser-panel opens and approval-gated `openExternal` system-browser opens.

Transcript-visible behavior is driven by typed PubSub events. User-authored
prompts generated by inline UI, action bars, or similar controls should go
through `chat.send(content)`, which publishes a canonical `message.completed`
agentic event and can start the next agent turn. Do not use `chat.send` for
agent acknowledgements or ordinary eval status; those should come from the
agent's normal response path. Do **not** use `chat.publish("message", {
content })` for visible transcript text: that writes a legacy raw PubSub row
which may be persisted but is not reduced by the current `agentic-chat` UI.
Rendered UI should go through `inline_ui`, `load_action_bar`, `feedback_form`,
or `feedback_custom` rather than hand-written raw channel records.

## Critical Rules

1. **Do NOT import eval-only ambient variables** — `services`, `ctx`, `scope`, `scopes`, `db`, `help`, `chat`, and `agent` are injected free variables in eval and are not importable. `rpc` and `fs` are the same portable bindings exposed by panels/workers, so either use them ambiently or import them from `@workspace/runtime`. For *packages*, both static `import` and dynamic `await import(...)` work in eval. File-loaded relative imports must be static/literal.
2. **Workspace packages are auto-resolved** — just write `import { createProject } from "@workspace-skills/workspace-dev"` and it builds on first use; npm packages require `imports: { "lodash": "npm:^4.17.21" }`. (For raw services, use `rpc.call("main", "<svc>.<method>", [...])`.)
3. **Components must `export default`** — named exports alone won't work for inline_ui/load_action_bar/feedback_custom components
4. **Inline UI / action-bar components receive `{ props, chat }`** (NOT `scope`/`scopes` — the eval REPL scope is server-side and is not shared into rendered components) — always default `props` (`{ props = {}, chat }`) and guard property access (`props?.items ?? []`). For maximum portability, prefer embedding small constant data in the component source.
5. **Feedback components receive `{ onSubmit, onCancel, onError, chat }`**
6. **Workspace code builds from your working edits, in lockstep, even before you commit** — source under `packages/`, `panels/`, `workers/`, `skills/`, `apps/`, and `extensions/` is built from your context head's working state. The model is **edit → commit → push**: the `edit`/`write` tools and `vcs.edit({ edits })` record each change as a tracked *working* edit on your context head and project it to disk, so it takes effect for builds immediately. `vcs.commit({ message })` then seals those working edits as a messaged milestone (the message is mandatory; the edit itself is NOT a commit), and `vcs.push` advances `main` (fast-forward-only, build-gated). Do NOT edit source via `fs.writeFile` and expect it to build; the worktree is a projection and builds read GAD state, so edits must go through `edit`/`write`/`vcs.edit`.
7. **Close temporary panels you open** — when eval opens a browser/workspace panel for diagnostics, scraping, setup, or testing, keep its handle and call `await handle.close()` in `finally` when done. Reuse an existing handle instead of opening duplicates. Leave a panel open only when the user explicitly asked to inspect or continue using it, or the workflow explicitly needs it to remain open.

For optional workspace probes, prefer one of these patterns:

- Import the helper statically and catch the helper call:
  `const status = await getStatus().catch(error => ({ error: String(error) }))`.
- If the helper may not exist in this workspace at all, run that probe in a
  separate eval and tolerate that separate eval failing.

(A missing package still throws even though dynamic `await import(...)` works in
eval, so wrap optional loads in a try/catch or isolate them in a separate eval.)

## Environment Compatibility

- `inline_ui`, `load_action_bar`, `feedback_form`, and `feedback_custom` are **panel-only** — they render in a browser context, so they require a connected panel.
- `eval` runs **server-side** in your per-agent `EvalDO`: it works in both panel and **headless** sessions and keeps working even if the panel or user disconnects. `set_title` works in both panel and headless sessions.

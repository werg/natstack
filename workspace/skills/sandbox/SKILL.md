---
name: sandbox
description: Execute code in the chat sandbox — eval tool, inline UI components, feedback forms, browser automation, and all runtime APIs (fs, db, git, workers, ai).
---

# Sandbox Execution Skill

How to use the chat panel's code execution sandbox — the eval tool, inline UI components, custom feedback forms, and all runtime APIs they can access.

## Files

| Document                                           | Content                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [EVAL.md](EVAL.md)                                 | Eval tool — run code, stream console, dynamic imports                                                       |
| [INLINE_UI.md](INLINE_UI.md)                       | Inline UI — persistent interactive components in chat                                                       |
| [ACTION_BAR.md](ACTION_BAR.md)                     | Action bar — file-backed compact UI pinned above chat history                                               |
| [CUSTOM_MESSAGES.md](CUSTOM_MESSAGES.md)           | Custom message types — register a renderer, publish typed instances with reducer updates                    |
| [MDX.md](MDX.md)                                   | Normal rich chat messages — callouts, badges, tables, ActionButton                                          |
| [FEEDBACK.md](FEEDBACK.md)                         | Feedback forms — block until user responds                                                                  |
| [RUNTIME_API.md](RUNTIME_API.md)                   | Full runtime API reference — fs, db, workers, ai, git, browser data, custom shared-resource approval grants |
| [CHAT_API.md](CHAT_API.md)                         | Chat API — publish messages, call methods, interact with the conversation                                   |
| [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md)     | Browser automation — lazy Playwright-style API via CDP                                                      |
| [PATTERNS.md](PATTERNS.md)                         | Common patterns and recipes                                                                                 |
| [INTERACTION_PATTERNS.md](INTERACTION_PATTERNS.md) | When to use inline UI for side-effect actions with choices/complexity                                       |

## Execution Modes

All code runs in the same sandbox (Sucrase transform + CJS execution in the panel's browser context). Eval/UI tools accept either raw `code` or a context-relative `path` where noted; file-loaded sources support static relative imports and infer bare package imports from the nearest `package.json` when possible. The execution modes differ in presentation:

| Tool              | Rendering                          | Lifecycle                         | Response                             |
| ----------------- | ---------------------------------- | --------------------------------- | ------------------------------------ |
| `eval`            | imperative (run + return)          | transient                         | immediate (result to agent)          |
| `inline_ui`       | component (render React)           | persistent (in chat history)      | none (fire-and-forget)               |
| `load_action_bar` | component from file (render React) | persistent (top of current panel) | immediate tool result                |
| `feedback_custom` | component (render React)           | transient                         | deferred (blocks until user submits) |

## Pre-injected Variables

Only `chat`, `scope`, `scopes` are pre-injected. Everything else (`db`, `fs`,
`rpc`, `ai`, `workers`, `workspace`, `contextId`) must be imported from
`@workspace/runtime` using static `import` syntax (no `await import(...)`).

## Available Imports

### Static imports (always available, no `imports` parameter needed)

These are pre-bundled with the panel and work as bare `import` statements:

| Module                       | What it provides                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@workspace/runtime`         | rpc, fs, db, workers, ai, workspace, contextId, panel navigation, `requestApproval` for custom shared resources |
| `@workspace/panel-browser`   | Browser data import/export (cookies, passwords, bookmarks, history)                                             |
| `react`, `react/jsx-runtime` | React hooks and component APIs                                                                                  |
| `@radix-ui/themes`           | UI components (Button, Flex, Card, Table, etc.)                                                                 |
| `@radix-ui/react-icons`      | Icon components                                                                                                 |
| `isomorphic-git`             | Git operations (clone, fetch, checkout, etc.)                                                                   |

### On-demand imports (require `imports` parameter)

Use `@workspace/playwright-automation` here for full Playwright panel
automation, then call `playwrightPage(handle)`. This intentionally keeps full
Playwright out of the default runtime bundle.

Use `handle.cdp.lightweightPage()` for lightweight panel inspection. It loads
the standalone `@workspace/cdp-client` internally; eval code should not import
that package directly.

These are built on first use. Pass them in the tool's `imports` parameter:

| Module                  | `imports` value                  | What it provides                      |
| ----------------------- | -------------------------------- | ------------------------------------- |
| `@workspace-skills/*`   | auto-resolved                    | Just `import` — built on first use    |
| `@workspace/*` packages | auto-resolved                    | Just `import` — built on first use    |
| `@natstack/*` packages  | auto-resolved                    | Just `import` — built on first use    |
| npm packages            | `imports: { "lodash": "npm:4" }` | Requires explicit `imports` parameter |

Workspace packages (`@workspace*`, `@natstack/*`) are **auto-resolved** — just write the `import` statement in your code and they're built on-demand. No `imports` parameter needed.

npm packages require the `imports` parameter with `"npm:<version>"` for raw inline code. File-loaded code can infer dependency versions from the nearest `package.json`.

File-loaded package inference checks `dependencies`, `peerDependencies`,
`optionalDependencies`, then `devDependencies`. It also supports
`package.json` `imports` aliases and simple `tsconfig.json` paths. Use explicit
`imports` to override inferred versions.

To pin a workspace package to a specific git ref, use the `imports` parameter explicitly: `imports: { "pkg": "branch-name" }`.

```
eval({ code: `
  import { git } from "@workspace/runtime";
  import { createProject } from "@workspace-skills/workspace-dev";
  const client = git.client();
  // workspace packages: just import, auto-resolved
` })
```

See [EVAL.md](EVAL.md) for details. On-demand imports are not available in inline_ui/load_action_bar/feedback_custom components (use eval to preload first).

## Interaction Patterns

See [MDX.md](MDX.md) for rich normal chat messages and `ActionButton`.
See [INTERACTION_PATTERNS.md](INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. In short: if an action involves choices or could fail, prefer rendering an inline UI that lets the user trigger it and reports results back via `chat.publish`. Use [ACTION_BAR.md](ACTION_BAR.md) when small controls or status should stay pinned above chat history for the current panel. For setup workflows with links, use the [INLINE_UI.md](INLINE_UI.md) link/checklist patterns and offer both internal browser-panel opens and approval-gated `openExternal` system-browser opens.

Transcript-visible behavior is driven by typed PubSub events. Normal user-side
messages should go through `chat.publish("message", { content })`; rendered UI
should go through `inline_ui`, `load_action_bar`, `feedback_form`, or
`feedback_custom` rather than hand-written raw channel records.

## Critical Rules

1. **Static imports only** — `import { rpc } from "@workspace/runtime"` (NOT `await import(...)`). File-loaded relative imports must also be static/literal.
2. **Workspace packages are auto-resolved** — `import { git } from "@workspace/runtime"` just works. Use `git.client()` for git operations; npm packages require `imports: { "lodash": "npm:4" }`
3. **Components must `export default`** — named exports alone won't work for inline_ui/load_action_bar/feedback_custom components
4. **Inline UI components receive `{ props, chat, scope, scopes }`** — always default `props` (`{ props = {}, chat }`) and guard property access (`props?.items ?? []`). For maximum portability, prefer embedding small constant data in the component source.
5. **Feedback components receive `{ onSubmit, onCancel, onError, chat }`**
6. **Workspace code is built from git refs, not from the working tree** — source under `packages/`, `panels/`, `workers/`, `skills/`, `apps/`, and `extensions/` is extracted from published workspace refs for builds. Editing files or creating a local/context commit has NO effect until you call `git.publishWorkspaceRepo(repoPath, message)` or the workspace-dev `commitAndPush` wrapper.
7. **Close temporary panels you open** — when eval opens a browser/workspace panel for diagnostics, scraping, setup, or testing, keep its handle and call `await handle.close()` in `finally` when done. Reuse an existing handle instead of opening duplicates. Leave a panel open only when the user explicitly asked to inspect or continue using it, or the workflow explicitly needs it to remain open.

## Environment Compatibility

- `inline_ui`, `load_action_bar`, `feedback_form`, and `feedback_custom` are **panel-only** -- they require a browser rendering context.
- `eval` and `set_title` work in both panel and **headless** sessions.

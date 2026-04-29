---
name: sandbox
description: Execute code in the chat sandbox — eval tool, inline UI components, feedback forms, browser automation, and all runtime APIs (fs, db, git, workers, ai).
---

# Sandbox Execution Skill

How to use the chat panel's code execution sandbox — the eval tool, inline UI components, custom feedback forms, and all runtime APIs they can access.

## Files

| Document | Content |
|----------|---------|
| [EVAL.md](EVAL.md) | Eval tool — run code, stream console, dynamic imports |
| [INLINE_UI.md](INLINE_UI.md) | Inline UI — persistent interactive components in chat |
| [MDX.md](MDX.md) | Normal rich chat messages — callouts, badges, tables, ActionButton |
| [FEEDBACK.md](FEEDBACK.md) | Feedback forms — block until user responds |
| [RUNTIME_API.md](RUNTIME_API.md) | Full runtime API reference — fs, db, workers, ai, git, browser data |
| [CHAT_API.md](CHAT_API.md) | Chat API — publish messages, call methods, interact with the conversation |
| [BROWSER_AUTOMATION.md](BROWSER_AUTOMATION.md) | Browser automation — Playwright API via CDP |
| [PATTERNS.md](PATTERNS.md) | Common patterns and recipes |
| [INTERACTION_PATTERNS.md](INTERACTION_PATTERNS.md) | When to use inline UI for side-effect actions with choices/complexity |

## Execution Modes

All code runs in the same sandbox (Sucrase transform + CJS execution in the panel's browser context). The three tools differ in presentation:

| Tool | Rendering | Lifecycle | Response |
|------|-----------|-----------|----------|
| `eval` | imperative (run + return) | transient | immediate (result to agent) |
| `inline_ui` | component (render React) | persistent (in chat history) | none (fire-and-forget) |
| `feedback_custom` | component (render React) | transient | deferred (blocks until user submits) |

## Pre-injected Variables

Only `chat`, `scope`, `scopes` are pre-injected. Everything else (`db`, `fs`,
`rpc`, `ai`, `workers`, `workspace`, `contextId`) must be imported from
`@workspace/runtime` using static `import` syntax (no `await import(...)`).

## Available Imports

### Static imports (always available, no `imports` parameter needed)

These are pre-bundled with the panel and work as bare `import` statements:

| Module | What it provides |
|--------|-----------------|
| `@workspace/runtime` | rpc, fs, db, workers, ai, workspace, contextId, panel navigation |
| `@workspace/panel-browser` | Browser data import/export (cookies, passwords, bookmarks, history) |
| `@workspace/playwright-client` | Playwright browser automation |
| `react`, `react/jsx-runtime` | React hooks and component APIs |
| `@radix-ui/themes` | UI components (Button, Flex, Card, Table, etc.) |
| `@radix-ui/react-icons` | Icon components |
| `isomorphic-git` | Git operations (clone, fetch, checkout, etc.) |

### On-demand imports (require `imports` parameter)

These are built on first use. Pass them in the eval `imports` parameter:

| Module | `imports` value | What it provides |
|--------|----------------|-----------------|
| `@workspace-skills/*` | auto-resolved | Just `import` — built on first use |
| `@workspace/*` packages | auto-resolved | Just `import` — built on first use |
| `@natstack/*` packages | auto-resolved | Just `import` — built on first use |
| npm packages | `imports: { "lodash": "npm:4" }` | Requires explicit `imports` parameter |

Workspace packages (`@workspace*`, `@natstack/*`) are **auto-resolved** — just write the `import` statement in your code and they're built on-demand. No `imports` parameter needed.

npm packages require the `imports` parameter with `"npm:<version>"`.

To pin a workspace package to a specific git ref, use the `imports` parameter explicitly: `imports: { "pkg": "branch-name" }`.

```
eval({ code: `
  import { GitClient } from "@natstack/git";
  import { createProject } from "@workspace-skills/paneldev";
  // workspace packages: just import, auto-resolved
` })
```

See [EVAL.md](EVAL.md) for details. On-demand imports are not available in inline_ui/feedback_custom (use eval to preload first).

## Interaction Patterns

See [MDX.md](MDX.md) for rich normal chat messages and `ActionButton`.
See [INTERACTION_PATTERNS.md](INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. In short: if an action involves choices or could fail, prefer rendering an inline UI that lets the user trigger it and reports results back via `chat.publish`. For setup workflows with links, use the [INLINE_UI.md](INLINE_UI.md) link/checklist patterns and offer both internal browser-panel opens and approval-gated `openExternal` system-browser opens.

## Critical Rules

1. **Static imports only** — `import { rpc } from "@workspace/runtime"` (NOT `await import(...)`)
2. **Workspace packages are auto-resolved** — `import { GitClient } from "@natstack/git"` just works. npm packages require `imports: { "lodash": "npm:4" }`
3. **Components must `export default`** — named exports alone won't work for inline_ui/feedback_custom
4. **Inline UI components receive `{ props, chat, scope, scopes }`** — always default `props` (`{ props = {}, chat }`) and guard property access (`props?.items ?? []`). For maximum portability, prefer embedding small constant data in the component source.
5. **Feedback components receive `{ onSubmit, onCancel, onError, chat }`**
6. **Workspace code is built from git, not from the working tree** — `workspace/` source (`packages/`, `panels/`, `workers/`, `skills/`) is extracted from git commits for builds. Editing files has NO effect until you **commit and push**. This applies to eval imports too: if you edit `@workspace/agentic-session` source, it won't change the imported module until the edit is committed and pushed.

## Environment Compatibility

- `inline_ui`, `feedback_form`, and `feedback_custom` are **panel-only** -- they require a browser rendering context.
- `eval` and `set_title` work in both panel and **headless** sessions.

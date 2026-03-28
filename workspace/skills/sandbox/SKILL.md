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

These are available in eval code without importing:

- **`chat`** — the ChatSandboxValue object (publish, callMethod, channelId, rpc)
- **`scope`** — persistent REPL scope (shared across eval calls)
- **`scopes`** — scope management API (push, get, list, save)

For `contextId`, import it: `import { contextId } from "@workspace/runtime"`

## Available Imports

These modules are available via `import` / `require()` in sandbox code:

| Module | What it provides |
|--------|-----------------|
| `@workspace/runtime` | rpc, fs, db, workers, ai, workspace, git, panel navigation |
| `@workspace/panel-browser` | Browser data import/export (cookies, passwords, bookmarks, history) |
| `@workspace/playwright-client` | Playwright browser automation (advanced — prefer `handle.page()` from `@workspace/runtime`) |
| `react` | React hooks and component APIs |
| `@radix-ui/themes` | UI components (Button, Flex, Card, Table, TextField, etc.) |
| `@radix-ui/react-icons` | Icon components |
| `isomorphic-git` | Git operations (clone, fetch, checkout, etc.) |
| **Any npm package** | Use the `imports` parameter with `"npm:<version>"` in eval — see [EVAL.md](EVAL.md). Not available in inline_ui/feedback_custom (use eval to preload first) |

## Interaction Patterns

See [INTERACTION_PATTERNS.md](INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. In short: if an action involves choices or could fail, prefer rendering an inline UI that lets the user trigger it and reports results back via `chat.publish`.

## Critical Rules

1. **Static imports only** — `import { rpc } from "@workspace/runtime"` (NOT `await import(...)`)
2. **`@natstack/*` packages are importable** — `import { GitClient } from "@natstack/git"` works via the `imports` parameter
3. **Components must `export default`** — named exports alone won't work for inline_ui/feedback_custom
4. **Inline UI components receive `{ props, chat }`** — not raw props
5. **Feedback components receive `{ onSubmit, onCancel, onError, chat }`**
6. **Workspace code is built from git** — files under `workspace/` (`packages/`, `panels/`, `workers/`) are built artifacts. Editing them has no effect until committed, pushed, and rebuilt. Load the `paneldev` skill for this workflow.

## Environment Compatibility

- `inline_ui`, `feedback_form`, and `feedback_custom` are **panel-only** -- they require a browser rendering context.
- `eval` and `set_title` work in both panel and **headless** sessions.

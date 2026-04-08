---
name: headless-sessions
description: Use this when running agentic sessions without a chat panel. Covers HeadlessSession, SessionManager, eval in workers or tests, auto-approval, and the tool/runtime differences between panel and headless execution.
---

# Headless Agentic Sessions

Run agentic sessions (connection, messaging, eval, scope) without the chat panel UI. Useful for eval harnesses, worker-driven pipelines, tests, and any context where React isn't available.

Use this when the task runs from a worker, test harness, automation flow, or any environment where there is no panel UI to render inline components or feedback forms.

## Files

| Document | Content |
|----------|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Package layout, SessionManager vs HeadlessSession, what lives where |
| [QUICK_START.md](QUICK_START.md) | Getting started: create a session, send messages, run eval |
| [API.md](API.md) | Full API reference for SessionManager and HeadlessSession |

## Packages

| Package | Purpose | React? |
|---------|---------|--------|
| `@workspace/agentic-core` | SessionManager, types, pure functions, event emitter, SandboxConfig factories | No |
| `@workspace/agentic-session` | HeadlessSession, headless prompts, channel helpers, worker/node sandbox factories | No |
| `@workspace/agentic-chat` | React adapter (useChatCore, useAgenticChat) — thin wrappers over SessionManager | Yes |

## When to Use What

- **Building a panel with chat UI?** Use `@workspace/agentic-chat` — it wraps SessionManager in React hooks.
- **Running eval from a worker/DO?** Use `@workspace/agentic-session` — HeadlessSession with sandbox config.
- **Writing a test harness?** Use `@workspace/agentic-core` — SessionManager directly.
- **Need just the types/pure functions?** Import from `@workspace/agentic-core`.

## Environment Compatibility

Headless sessions use the same agent worker and core tool surface as
panel-hosted sessions. Guidance that used to live in prompt overrides now lives
in skill docs and tool descriptions. The runtime difference is simple: with no
chat panel connected, UI-only tools simply aren't advertised on the channel and
naturally drop out of the agent's tool list.

| Capability | Panel | Headless |
|------------|-------|----------|
| eval | Yes | Yes (requires SandboxConfig) |
| set_title | Yes | Yes |
| scope persistence | Yes | Yes (auto-created when SandboxConfig provided) |
| inline_ui | Yes | No — no panel to render the component |
| feedback_form / feedback_custom | Yes | No — no panel to render the form |
| Tool approval UI | Yes | No — headless uses full-auto approval |

When running headless, prefer plain message replies for anything that would
normally use `inline_ui`, `feedback_form`, or `feedback_custom`.

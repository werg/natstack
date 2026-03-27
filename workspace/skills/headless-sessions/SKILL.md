---
name: headless-sessions
description: Run agentic sessions without a UI — eval harnesses, workers, automated pipelines, tests. Uses SessionManager from @workspace/agentic-core and HeadlessSession from @workspace/agentic-session.
---

# Headless Agentic Sessions

Run agentic sessions (connection, messaging, eval, scope) without the chat panel UI. Useful for eval harnesses, worker-driven pipelines, tests, and any context where React isn't available.

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

| Capability | Panel | Headless |
|------------|-------|----------|
| eval | Yes | Yes (requires SandboxConfig) |
| set_title | Yes | Yes |
| scope persistence | Yes | Yes (auto-created when SandboxConfig provided) |
| inline_ui | Yes | No (requires React + browser) |
| feedback_form / feedback_custom | Yes | No (requires tool-ui) |
| Tool approval UI | Yes | No (headless uses full-auto) |

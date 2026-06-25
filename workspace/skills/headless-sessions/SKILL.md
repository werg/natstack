---
name: headless-sessions
description: Run agentic sessions without a UI — eval harnesses, workers, automated pipelines, tests. Uses ConnectionManager from @workspace/agentic-core and HeadlessSession from @workspace/agentic-session.
---

# Headless Agentic Sessions

Run agentic sessions (connection, messaging) without the chat panel UI. Useful for eval harnesses, worker-driven pipelines, tests, and any context where React isn't available.

The session itself is just a channel client: it connects to a PubSub channel,
subscribes an agent DO, sends user messages, and reads the persisted transcript.
The agent's own capabilities (eval, file tools, web tools) live in the agent
worker, not in this session wrapper. In particular, the agent's `eval` runs
**server-side in the agent's own per-channel EvalDO**, so it works even when no
panel/session UI is connected — the session does not need to register an eval
method or keep a sandbox alive for the agent to evaluate code.

## Files

| Document | Content |
|----------|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Package layout, ConnectionManager vs HeadlessSession, what lives where |
| [QUICK_START.md](QUICK_START.md) | Getting started: create a session, send messages, drive an agent |
| [API.md](API.md) | Full API reference for HeadlessSession |

## Packages

| Package | Purpose | React? |
|---------|---------|--------|
| `@workspace/agentic-core` | ConnectionManager, types, pure functions, channel-view reducer/selectors, panel SandboxConfig factory | No |
| `@workspace/agentic-session` | HeadlessSession, channel helpers, RPC sandbox factory | No |
| `@workspace/agentic-chat` | React adapter (useChatCore, useAgenticChat) | Yes |

## When to Use What

- **Building a panel with chat UI?** Use `@workspace/agentic-chat` — React hooks over the same channel-view reducer.
- **Driving an agent from a worker/DO, test, or pipeline?** Use `@workspace/agentic-session` — `HeadlessSession.createWithAgent()`.
- **Just connecting to a channel without the headless conveniences?** Use `ConnectionManager` from `@workspace/agentic-core` directly.
- **Need just the types/pure functions?** Import from `@workspace/agentic-core`.

## Environment Compatibility

Headless sessions use the same agent worker, system prompt, and tool surface as
panel-hosted sessions. The only difference is the runtime environment: with no
chat panel connected, UI-only tools simply aren't advertised on the channel and
naturally drop out of the agent's tool list.

When creating a headless session from server-side eval, a worker, or a Durable
Object, set `config.clientId` to `rpc.selfId`. That value is the authorized
PubSub participant id for connectionless runtime callers; arbitrary labels are
rejected when the session subscribes to the channel.

| Capability | Panel | Headless |
|------------|-------|----------|
| eval | Yes | Yes — runs server-side in the agent's EvalDO; no panel/sandbox needed |
| scope / db persistence | Yes | Yes — held in the agent's EvalDO, not the session |
| set_title | Yes | Yes |
| inline_ui | Yes | No — no panel to render the component |
| load_action_bar | Yes | No — no panel-local top bar to render |
| feedback_form / feedback_custom | Yes | No — no panel to render the form |
| Tool approval UI | Yes | No — headless uses full-auto approval |

`eval` and its persistent `scope`/`db` are agent-worker capabilities, not session
capabilities: the agent runs eval in its own per-channel `EvalDO` server-side, so
they work the same whether or not a panel or headless session UI is connected.
The agent's prompt notes that the UI-only tools (inline_ui, load_action_bar,
feedback) are runtime-dependent, so it automatically falls back to plain message
replies for the same content when running headless.

Headless agents still own runtime resources they create. If a headless session
opens panels, browser panels, or CDP page clients through eval, its prompt or
harness should require cleanup: reuse handles, close temporary panels in
`finally`, and close/dispose page clients when the API exposes a close method.
Do not rely on channel unsubscribe alone to clean up panels the agent opened.
Leave panels open only when the user or harness explicitly requested that state.

# Terminal-renderable workers + the terminal browser

NatStack can run **userland terminal apps inside the workerd sandbox**, rendering
with [Ink](https://github.com/vadimdemedes/ink), while a single trusted
**terminal-browser** app owns the real TTY and mediates all terminal I/O,
approvals, and session lifecycle.

```
real TTY ── terminal-browser (trusted app) ──RPC──▶ terminal-chat (sandboxed DO)
            • one host Ink tree (chrome +              • Ink app via @workspace/terminal-shim
              composited per-session VT grids)          • frames ▶ host ; input ◀ host
            • approvals overlay (shellApproval.*)        • talks to AiChatWorker over pubsub
```

## Why this shape

- **Sandbox.** Userland terminal apps run in workerd as Durable Objects, governed
  by the same capability/approval/RPC machinery as every other unit — not as
  trusted Node processes.
- **One screen owner.** Ink redraws with *relative* cursor motion (climb up N
  lines, erase, rewrite) and assumes it solely owns the terminal. Two Inks (host
  chrome + worker) on one TTY corrupt each other. So the host runs a **headless
  VT emulator per session** (`@xterm/headless`), parses each worker's byte
  stream into a cell grid, and re-renders that grid inside its own single Ink
  frame. Only the host's Ink touches the real TTY. This also makes the approval
  overlay un-spoofable: worker bytes never reach the screen.

## Writing a terminal-renderable worker

Declare it in `package.json`:

```jsonc
{
  "natstack": {
    "entry": "worker.tsx",
    "durable": { "classes": [{ "className": "MyTerminalWorker" }] },
    "terminal": { "renderer": "ink" }, // marks it terminal-renderable
    "persistent": true                  // resident DO (holds the live render tree)
  },
  "dependencies": {
    "@workspace/terminal-shim": "workspace:*",
    "@workspace/terminal-host-protocol": "workspace:*",
    "ink": "^6.0.0",
    "react": "^19.0.0"
  }
}
```

In the DO, build the shim session and render Ink into it:

```tsx
import { createInkTerminalSession } from "@workspace/terminal-shim";
import { HOST_METHODS, SESSION_METHODS, encodeFrame, decodeInputData } from "@workspace/terminal-host-protocol";

async [SESSION_METHODS.start](args) {
  const session = createInkTerminalSession({
    sessionId: args.sessionId,
    sink: { write: (stream, bytes) => /* rpc.call(host, HOST_METHODS.onFrame, [encodeFrame(...)]) */ },
    initialSize: args.viewport,
  });
  const app = render(<App />, { stdin: session.stdin, stdout: session.stdout, stderr: session.stderr });
  this.ctx.waitUntil?.(app.waitUntilExit()); // keep the DO resident
}
```

See `workspace/workers/terminal-chat` for a complete example (chat UI, agent
bootstrap, persistence).

## How it works under the hood

- **yoga in workerd.** Ink's layout engine (yoga) ships its WASM base64-inlined
  and instantiates it with async `WebAssembly.instantiate`, which workerd
  rejects. The build aliases `yoga-layout` to `@workspace/terminal-shim/yoga`,
  which instantiates a **pre-compiled `yoga.wasm` module binding** synchronously
  via emscripten's `instantiateWasm` hook. The build emits `yoga.wasm` as a
  second artifact; `workerdManager` attaches it as a `wasm` module on the DO.
  Ink itself is unmodified.
- **node shims.** `signal-exit` and `terminal-size` break in workerd; the build
  aliases them to terminal-shim replacements. `nodejs_compat` supplies
  process/stream/events/Buffer, so those are *not* shimmed.
- **transport.** Terminal output is delivered as ordered discrete
  `terminal.onFrame` RPC calls (frames are small — Ink only redraws changed
  lines). The unified RPC transport work is adding stream routing everywhere,
  but terminal frames intentionally remain message-based so ownership checks,
  sequence guards, and per-frame size limits stay simple.
- **lifecycle.** A connectionless idle DO is evicted in ~10 s. Terminal session
  workers are `persistent`: `ctx.waitUntil(waitUntilExit())` + an alarm heartbeat
  keep them resident while attached. On detach/evict, resumable state (transcript,
  channel id) is restored from `state` on reattach.

## Shared chat core (terminal chat ≡ panel)

The terminal chat is **not a reimplementation** — it runs on the same headless
core as the chat panel:

- `@workspace/agentic-session` `HeadlessSession` (over `@workspace/agentic-core`
  `ConnectionManager` + `reduceChannelView` + `chatMessagesFromChannelView`)
  drives connection, agent subscription, the send/receive protocol, streaming,
  and the `ChatMessage` model.
- The panel wraps that core in React hooks (`useAgenticChat`/`useChatCore`); the
  terminal wraps it in a thin `ChatViewModel` (the Ink analog). Both consume the
  identical message stream, so behavior matches: streaming deltas, thinking,
  tool-invocation cards, approval cards, model/provider config.
- `HeadlessSession.createWithAgent({ model, thinkingLevel, approvalLevel,
  systemPrompt })` does the panel-equivalent bootstrap (create channel +
  subscribe agent DO + connect). `/model`, `/connect`, `/agents` reuse the same
  `providerConnect` presets and RPC the panel uses.

The one addition to the shared core was a public `HeadlessSession.onMessage()`
(fires on every channel update incl. deltas) so non-React renderers can drive a
re-render the same way the hooks do.

## Interactive launch

Terminal apps that render a TUI declare `natstack.app.interactive: true`. The
runner then launches them with stdio `"inherit"` (the process-adapter gained a
`stdio` option), giving the app the real terminal (stdin/stdout/stderr) while
keeping the IPC channel for graceful shutdown. This yields a usable TTY only
when the server itself runs attached to an interactive terminal; the app exits
with a clear message if stdin/stdout are not TTYs. Headless terminal CLIs (e.g.
`remote-cli`) omit the flag and keep piped, log-captured stdio.

## Color & attributes

The host composites the VT grid with **full color/attribute fidelity**:
`VtSession.styledGrid()` reads each xterm cell's fg/bg (default / 256-palette /
truecolor → Ink color or hex) and bold/dim/italic/underline/inverse/strikethrough,
merges same-styled runs, and renders them as Ink `<Text>` spans.

## Caller-verified session ownership (RPC caller context)

There is one canonical inbound-caller type, `AuthenticatedCaller
{ callerId; callerKind }` (in `@natstack/rpc`), used by the unified
context-object handler surface. `callerId`/`callerKind` are gateway-verified
identity from the `RpcEnvelope.delivery.caller`, never the self-reported
`fromId`. `req.origin` is the distinct root principal from the envelope
provenance chain.

How each layer obtains it:
- **Point-to-point client** → `rpc.expose(method, (req) => …)`, with
  `req.caller`, `req.origin`, `req.args`, and provenance-scoped `req.rpc`.
- **Durable Objects/workers** → the HTTP ingress receives an envelope from the
  gateway and exposes the same request context to handlers.
- **Server services** → `authenticatedCallerOf(ctx.caller)` remains the richer
  server-side view, with capability/code identity on top of the canonical
  caller.

The host's `HostService` uses `rpc.expose` for every worker→host method
(`onFrame`/`setTitle`/`requestClose`/`setRawMode`). A call is authorized only if
the immediate caller is the session's owner
(`ownerOf(sessionId) === req.caller.callerId`). The previous trusted-gateway
fallback is intentionally gone; a collapsed server caller such as `"main"` is
rejected. OSC/escape side effects are independently contained — worker bytes
never reach the real TTY (the host re-renders a grid).

**Sweep — where strict caller checks live:** the terminal-browser host is the
worker→app callback boundary and now requires strict owner identity. Other
RPC-exposing sites migrate to the same vocabulary: DOs/workers through
`req.caller`, server services through `VerifiedCaller`, and extension-host
through gateway-attested invocation provenance.

`CallerKind` is now defined once: canonically in `@natstack/rpc`, re-exported by
`@natstack/shared/principalKinds` (which keeps the richer per-kind registry) behind a
compile-time parity guard that fails the build if the two ever drift.

## Known limitations / follow-ups

1. The server routing cutover must preserve DO/worker identity end-to-end for
   worker→app callbacks. Until that full route is migrated, tests should reject
   collapsed `"main"` callers at the host boundary rather than accepting a relay
   exception.

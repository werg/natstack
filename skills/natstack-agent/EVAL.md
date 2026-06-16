# Eval: Running Code Against the Server

`natstack eval run` executes TypeScript/JavaScript in a sandboxed local child
process wired to the paired server over RPC, with a **persistent REPL scope**
per agent session. It is the fastest way to explore live data or do anything
the dedicated commands don't cover.

```bash
natstack eval run [FILE | -e CODE | -]
    [--session NAME] [--timeout MS] [--fresh-scope]
    [--syntax typescript|jsx|tsx] [--imports JSON] [--json]
natstack eval repl-reset [--session NAME]
```

Code sources (mutually exclusive): a `FILE` positional, inline `-e CODE`, or
stdin (`-`, or implicitly when stdin is piped). Default syntax is `tsx`;
top-level `await` and `return` are allowed.

## Bindings available to your code

| Binding | What it is |
|---------|------------|
| `rpc.call(method, args)` | Raw RPC: `await rpc.call("vcs.status", ["ctx:" + ctx.contextId])` |
| `rpc.callTarget(targetId, method, args)` | Call a runtime entity (DO/worker) by target id, e.g. after `workers.resolveService`: `const svc = await rpc.call("workers.resolveService", ["natstack.testkit-driver.v1", null]); await rpc.callTarget(svc.targetId, "ping", [])` |
| `services` | Proxy over rpc: `await services.meta.listServices()` ≡ `rpc.call("meta.listServices", [])` |
| `fs` | Context-bound fs service — the session contextId is injected as the first arg: `await fs.readdir("/")`, `await fs.grep("TODO", {})` |
| `ctx` | `{contextId, sessionId, workspaceId, serverUrl}` |
| `scope` | Persistent REPL scope (see below): `scope.results = data` survives across runs |
| `help()` | `await help()` lists services + import guidance; `await help("vcs")` describes one service |

```bash
natstack eval run -e '
  const files = await fs.glob("**/*.ts");
  scope.fileCount = files.length;
  return files.slice(0, 10);
'
```

## Persistent scope

- Assignments to `scope` (e.g. `scope.x = ...`) are serialized after every
  run — success **or** failure — and restored on the next run for the same
  session. One scope per session. Infrastructure failures (timeout, runner
  crash, bad handshake) leave the stored scope untouched.
- `--fresh-scope` starts a single run from an empty scope without touching
  the stored one; `natstack eval repl-reset` clears it permanently.
- Unserializable values are dropped with a `scope: dropped <path> (<reason>)`
  warning on stderr (listed in `scopeWarnings` in JSON mode).

## Imports

```bash
natstack eval run --imports '{"lodash":"npm:4","@workspace/gad":"latest"}' -e '
  import _ from "lodash";
  import { something } from "@workspace/gad";
  ...
'
```

- The map value is a *ref*, not a package name: `npm:<version>` for npm
  packages (installed/bundled server-side on demand), `"latest"` or a git
  ref (branch/tag/SHA) for `@workspace/*` packages.
- `@workspace/*` packages resolve to server-built library bundles, including
  subpath exports (e.g. `{"@workspace/testkit/profiling":"latest"}`). They
  are browser-targeted builds — packages depending on panel/worker runtime
  globals may not work in the Node runner.

## Output

- **Text mode (TTY):** the `return` value prints to stdout
  (pretty-printed JSON for objects); `console.*` output streams to stderr
  live, prefixed `[warn]`/`[error]`/`[info]`/`[debug]` for non-log levels;
  scope warnings go to stderr.
- **JSON mode (`--json` or piped stdout):** one document on stdout:
  `{success, returnValue, returnTruncated, error, console, scopeSaved, scopeWarnings}`
  where `console` is `[{type:"console", level, text, ts}]`.
- On timeout or runner death, the JSON error document
  (`{error, exitCode, ...}`) includes the `console` events collected before
  the failure and the trimmed runner `stderr`, so hung evals stay debuggable.
- Return values are truncated at 256KB of JSON (`returnTruncated: true`).

## Timeouts and exit codes

- `--timeout MS` (default 120000) SIGKILLs the runner — sandboxed sync code
  cannot be preempted any other way. A timeout exits `4`.
- Exit codes: `0` success · `1` eval threw / RPC error / runner died ·
  `2` usage (bad flags, FILE+`-e` conflict) · `3` not paired/unreachable ·
  `4` timeout · `5` stale session.
- Long evals: the runner holds a single shell token issued at startup. Tokens
  have no TTL, but if the server restarts (or the token is revoked) mid-run,
  RPC calls fail with `shell token rejected (server restarted?)` — rerun the
  eval. Split long work into shorter runs and carry state in `scope`.
- `NATSTACK_EVAL_RUNNER` overrides the runner path; it must point at a built
  `.mjs` runner (e.g. `dist/cli/eval-runner.mjs`) — it is executed with plain
  `node`, not tsx, so TypeScript sources will not work.

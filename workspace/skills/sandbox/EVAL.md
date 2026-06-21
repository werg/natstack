# Eval Tool

Run TypeScript/JavaScript code **server-side** in your own per-agent sandbox.
`eval` is a LOCAL agent tool: the agent loop dispatches it in-process and it
executes the code in your channel's `EvalDO` (a server-side Durable Object), not
in the chat/editor panel. Console output is captured and the return value is
sent back.

**Eval does not need a connected panel.** It keeps working even if the
chat/editor panel — or the user — disconnects. State (`scope`, the in-DO SQLite
`db`) lives in the EvalDO and persists across calls and across turns.

## Basic Usage

```
eval({ code: `console.log("hello")` })
```

For multi-file code, put the entry point in a context-relative file and use `path`:

```
eval({ path: ".natstack/eval/check-project.ts" })
```

File-loaded eval reads the entry file from the current context, supports static
relative imports from that file, and resolves bare imports from the nearest
`package.json` when it can find one.

Inline `code` eval has no source file, so relative imports such as
`./panels/my-app/module` are not resolvable there. Put multi-file eval code in a
context-relative file and pass `path`, or import workspace packages by package
name.

## Parameters

| Param     | Type                             | Default | Description                                                            |
| --------- | -------------------------------- | ------- | ---------------------------------------------------------------------- |
| `code`    | string                           | —       | TypeScript/JavaScript code to execute. Provide either `code` or `path` |
| `path`    | string                           | —       | Context-relative TypeScript/TSX file to execute instead of inline code |
| `syntax`  | `"typescript" \| "jsx" \| "tsx"` | `"tsx"` | Source syntax                                                          |
| `imports` | `Record<string, string>`         | —       | Packages to build on-demand (workspace or npm)                         |

## Injected Variables

These are **injected as free variables** in eval code. Use them directly — do
NOT `import` them:

| Variable | What it is |
| --- | --- |
| `rpc.call(method, args)` | Raw RPC to the server: `await rpc.call("vcs.status", ["ctx:" + ctx.contextId])` |
| `rpc.callTarget(targetId, method, args)` | Call a runtime entity (DO/worker) by target id, e.g. after `rpc.call("workers.resolveService", [...])` |
| `services` | The runtime service clients — `services.vcs` is the SAME object as the bare `vcs` / `import { vcs }` (e.g. `await services.extensions.use("@workspace-extensions/typecheck-service").checkPanel("panels/app")`). A server service with no curated client is reached generically via `rpc.call("meta.listServices", [])`. |
| `fs` | Context-scoped filesystem — the EvalDO resolves your context, so you do NOT pass a contextId: `await fs.readdir("/")`, `await fs.readFile("src/index.ts", "utf-8")` |
| `ctx` | `{ contextId, objectKey }` for the current eval session |
| `scope` | Persistent REPL scope (see below); `scope.x = …` survives across calls in the same channel |
| `scopes` | Management API for the serialized scope layer (see below) |
| `db` | Synchronous in-DO SQLite (see below) |
| `chat` | The full chat API for the current channel — `publish`/`send`, custom-message cards, `registerMessageType`, `callMethod`, etc. (agent eval only; see below) |
| `agent` | Inspect/configure THIS agent's own state — `await agent.describe()`, `await agent.setModel("provider:model")`, etc. (agent eval only; see below) |
| `help()` | `await help()` lists services + import guidance; `await help("vcs")` describes one service |

```
eval({ code: `
  const files = await fs.readdir("/");
  scope.fileCount = files.length;
  return files.slice(0, 10);
` })
```

### chat (agent eval)

When eval runs **as an agent** (the agent's own server-side EvalDO), a `chat`
binding for the agent's current channel is injected — the same surface as
[CHAT_API.md](CHAT_API.md): `chat.send`, `chat.publish`,
`chat.publishCustomMessage`/`chat.updateCustomMessage`,
`chat.registerMessageType`/`chat.clearMessageType`, `chat.callMethod`,
`chat.callMethodByHandle`, `chat.participantByHandle`, `chat.contextId`,
`chat.channelId`, etc. Everything publishes **as the agent** (correct `@agent`
attribution).

```
eval({ code: `
  await chat.registerMessageType({
    typeId: "status",
    displayMode: "row",
    source: { type: "file", path: "renderers/status.tsx" },
    stateSchema: { type: "object", properties: { phase: { type: "string" } } },
  });
  const { messageId } = await chat.publishCustomMessage({ typeId: "status", initialState: { phase: "starting" } });
  await chat.updateCustomMessage(messageId, { phase: "done" });
` })
```

Under the hood `chat` is a thin proxy: the EvalDO forwards each call to the
owning agent DO, which performs it with its channel machinery and relays the
result. `chat.callMethod` resolves to the **delivered** participant result, and
`chat.participantByHandle` is async (the roster is fetched over RPC).
`chat.focusMessage` is panel-only and resolves `false` server-side.

> Note: `chat` is only present for **agent** eval. CLI/panel eval (no channel)
> gets no `chat` — interact with the channel through `rpc`/`services` instead.
> The `chat` handle is also available to panel-rendered components
> (`inline_ui`, `feedback_custom`, action bars) — see [CHAT_API.md](CHAT_API.md).

### agent (agent eval)

When eval runs **as an agent**, an `agent` binding lets the agent introspect and
reconfigure **itself**. Config is **per-agent** (one model, thinking level,
approval posture, respond policy, … shared across every channel the agent is in)
— it is NOT per-channel. Writes apply to all the agent's channels and take effect
on the next turn.

```
// Read your own state (identity, resolved config, channels, tools, turn, effects):
const me = await agent.describe();
me.config.model;        // the model you are running
me.channels;            // every channel you're a member of
me.turn.status;         // this channel's turn status

// Reconfigure yourself (each returns the updated config):
await agent.setModel("openai:gpt-5.3");
await agent.setThinkingLevel("high");
await agent.setApprovalLevel(2);          // UX convenience; sensitive ops are gated by app approvals
await agent.setRespondPolicy("mentioned-or-followup");
await agent.setRespondFrom(["@alice"]);   // handles resolve per-channel
await agent.configure({ model: "…", thinkingLevel: "medium" });  // batch
```

To make a spawned/headless agent inherit your model, read it here and pass it
into the new agent's **creation** config (its `stateArgs.agentConfig.model`),
since model rides creation — not the subscription.

> Note: `agent` is only present for **agent** eval (same gate as `chat`); the
> EvalDO forwards each call to your own vessel, which only accepts your own eval.

## Top-level Await

Fully supported. Async operations are automatically tracked and awaited:

```
eval({ code: `
  const response = await fetch("https://api.example.com/data");
  const data = await response.json();
  console.log(data);
  return data;
`
})
```

## Console Output

`console.log/warn/error/info/debug` output is captured during the run and
returned to the agent in the result's `console` field.

## Result Shape

`eval.run` returns `{ success, console, returnValue?, error?, scopeKeys? }`:

- `success` — whether the run completed without throwing.
- `console` — captured console output.
- `returnValue` — the `return` value (or last expression), safe-serialized.
- `error` — present on failure.
- `scopeKeys` — the keys currently held in the persistent `scope`.

Non-serializable values (functions, symbols, circular refs) are safely converted
to string representations in `returnValue`.

## Imports

Workspace and npm packages are loaded via the `imports` parameter (npm) or
auto-resolution (workspace), then brought in with a normal `import`. Both static
`import` and dynamic `await import(...)` work — they compile to the EvalDO's
per-object require, which is isolated per owner (your loaded modules never leak
to another agent's EvalDO sharing the same isolate).

Do NOT import the **ambient-only** globals (`services`, `scope`, `scopes`, `db`,
`ctx`, `help`, `chat`) — they are injected free variables, not module exports,
and the eval engine rejects importing them.

`rpc` and `fs` are the exception: they are injected ambiently (the table above)
**and** re-exported by `@workspace/runtime`, so importing them is allowed and
gives the full portable client. `import { rpc } from "@workspace/runtime"` is the
3-arg `rpc.call(targetId, method, args)` client (the ambient `rpc` is 2-arg sugar
over the server); `import { fs } from "@workspace/runtime"` is the same
context-scoped fs.

### Importing the runtime surface

`@workspace/runtime` is importable in eval and exposes the **same portable
surface** as panels and workers — so the same code runs on any target:

```
eval({ code: `
  import { vcs, workspace, gad, credentials, openPanel, panelTree } from "@workspace/runtime";
  const head = await vcs.resolveHead("main");
  const off = vcs.subscribeHead(head, (advance) => console.log("head advanced", advance));
` })
```

Importable members: `id`, `contextId`, `rpc`, `fs`, `gad`, `blobstore`,
`workspace`, `credentials`, `git`, `vcs`, `webhooks`, `extensions`, `approvals`,
`notifications`, `workers`, `doTargetId`, `createDurableObjectServiceClient`,
`gatewayConfig`, `gatewayFetch`, `openExternal`, `openPanel`, `listPanels`,
`getPanelHandle`, `panelTree`. (`gatewayFetch` in eval is **gateway-relative
only** — use `credentials.fetch` for external requests.)

#### CDP (Chrome DevTools Protocol) from eval

Drive a live panel's browser target over CDP — full commands **and** events —
from eval. Get an endpoint from a panel handle, then connect with
`CdpConnection` from `@workspace/cdp-client`:

```
eval({ code: `
  import { CdpConnection } from "@workspace/cdp-client";
  const handle = getPanelHandle("<panelSlotId>");
  const { wsEndpoint, token } = await handle.cdp.getCdpEndpoint();
  const cdp = await CdpConnection.connect(wsEndpoint, token);
  cdp.on("Runtime.consoleAPICalled", (e) => console.log("panel console:", e.args));
  await cdp.send("Runtime.enable", {});
  const r = await cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
  return r.result.value;
` })
```

### Workspace packages — auto-resolved

Workspace packages (`@workspace/*`, `@workspace-skills/*`, `@natstack/*`) are
**automatically built and loaded** when you import them. Just write the import —
no `imports` parameter needed:

```
eval({ code: `
  import { createProject } from "@workspace-skills/workspace-dev";
  await createProject({ projectType: "panel", name: "my-app", title: "My App" });
`
})
```

The first import triggers an on-demand build from the committed workspace state (a few seconds). Subsequent imports use the cached build.

To pin a specific VCS ref or state hash, use the `imports` parameter explicitly:

```
eval({ code: `...`, imports: { "@workspace-skills/workspace-dev": "my-branch" } })
```

The map value is a *ref*, not a package name: `"latest"` or a git ref
(branch/tag/SHA) for `@workspace/*` packages. They resolve to server-built
library bundles, including subpath exports (e.g.
`{ "@workspace/testkit/profiling": "latest" }`).

**Important:** Workspace runtime units are built from the committed context head, which is always in lockstep with your edits. Edits are edit-first: the `edit`/`write` tools and `vcs.applyEdits` apply each change to source under `apps/`, `extensions/`, `packages/`, `panels/`, `workers/`, or `skills/` as one atomic GAD transition on your context head and project it to disk, so the change takes effect for builds immediately — there is no separate commit step. Do not edit source via `fs.writeFile` and expect it to build: the worktree is a projection, builds read GAD state, and there is no commit step to ingest stray `fs` writes.

Context folders are isolated working trees backed by context-local VCS heads. Do not assume another context's edits reset your current context. An "unpublished changes" count shown by a running panel is the unpublished state of that panel's own context head (changes ahead of `main`), not a global workspace state.

### npm packages

Use the `imports` parameter with `"npm:<version>"`, then `import` the package:

```
eval({
  code: `
    import _ from "lodash";
    console.log(_.chunk([1, 2, 3, 4, 5, 6], 2));
  `,
  imports: { "lodash": "npm:^4.17.21" }
})
```

```
eval({
  code: `
    import * as d3 from "d3-array";
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    console.log("mean:", d3.mean(data));
    console.log("deviation:", d3.deviation(data));
  `,
  imports: { "d3-array": "npm:3" }
})
```

Version values follow npm semver conventions: `"npm:^1.0.0"`, `"npm:~2.3.0"`, `"npm:3"`, `"npm:latest"`.

Packages are installed with `--ignore-scripts` for security (no postinstall hooks). Specifiers are validated against npm naming rules — only standard package names are accepted (no URLs, file paths, or git refs). Native addon packages (those requiring `.node` binary files) are not supported.

Installed packages and their bundles are both cached, so subsequent imports of the same package/version are fast. The first install of a new package may take 10-30 seconds (npm download + esbuild bundle); eval waits for that work to complete.

For file-loaded code, npm package versions are inferred from the nearest
`package.json` dependency fields when possible. The lookup checks
`dependencies`, `peerDependencies`, `optionalDependencies`, and
`devDependencies`, in that order. Use `imports` to override or provide versions
not declared there.

File-loaded code also supports package-local aliases declared through
`package.json` `imports` (for `#alias` style imports) and simple
`tsconfig.json` `compilerOptions.paths` mappings.

### Mixing workspace and npm imports

```
eval({
  code: `
    import { createProject } from "@workspace-skills/workspace-dev";
    import Ajv from "ajv";
    const ajv = new Ajv();
    console.log("Ajv loaded:", typeof ajv.compile);
  `,
  imports: {
    "@workspace-skills/workspace-dev": "latest",
    "ajv": "npm:^8.12.0"
  }
})
```

### Limitations

- `package.json` `exports`, lockfile-exact versions, and full Node
  `node_modules` resolution are not implemented.
- Only packages with standard npm names are accepted (e.g. `lodash`, `@scope/pkg`). URLs, file paths, and git specifiers are rejected.
- Packages requiring native addons (`.node` binaries) won't work — esbuild cannot bundle them.

## Path Conventions

The `path` parameter for file-loaded eval is always context-relative, for
example `.natstack/eval/check-project.ts`.

Runtime `fs.*` calls are also scoped to the current context folder. In `fs`
calls, both `src/index.ts` and `/src/index.ts` refer to files under the context
root; the leading slash means context-root absolute, not a host filesystem path.
Prefer paths without a leading slash in examples that touch workspace source,
and never pass host absolute paths such as `/home/user/.../workspace/...`.

## REPL Scope

`scope` is a persistent object shared across eval calls within the same channel.
Store data — query results, intermediate state, config — in `scope.*` and it is
available on the next eval call. After every eval call the EvalDO serializes
`scope` to its own SQLite (`repl_scopes` table) and rehydrates it on the next
run, so scope survives EvalDO eviction and reconstruction.

### scope vs scopes

- **`scope`** — the persistent REPL object. Read/write `scope.x` during normal
  operation; assignments and deep mutations are saved after each eval call.
- **`scopes`** — management API for the serialized (DB) layer:
  - `scopes.currentId` — current scope's durable UUID
  - `scopes.push()` — serialize + archive current scope, start a fresh one (only serializable values carry over)
  - `scopes.get(id)` — retrieve an archived scope by its durable ID (deserialized snapshot — data only, no functions)
  - `scopes.list()` — list all scopes for this channel with keys and partial keys
  - `scopes.save()` — force-serialize scope to DB now

### Serialization

Scope is serialized per-property when persisted:

- **Kept:** primitives, plain objects, arrays, Date, Map, Set, RegExp
- **Dropped:** functions, symbols, class instances, WeakRef/WeakMap/WeakSet, circular refs, depth > 20

Because the EvalDO is a server-side isolate (not the browser), prefer storing
plain serializable data in `scope`. Functions and class instances held in
`scope` between calls only survive while the EvalDO instance stays warm; after
idle eviction the scope is rehydrated from the serialized snapshot, so any
non-serializable values are lost.

### Resetting scope

To start with an empty scope and empty `db`, reset the eval context. The agent
`eval` tool does not take a reset flag; reset is exposed as the `eval.reset` RPC
(`rpc.call("eval.reset", [])` resets your own session, since the owner is your
verified identity). `eval.reset` drops your user `db` tables and the persistent
scope, preserving only reserved/base tables.

### Deep Mutations

Deep mutations (`scope.data.push(x)`, `scope.config.key = val`) are captured by
the post-eval auto-save. No need for extra `scopes.save()` calls within eval.

## Database Access

`db` is a **synchronous** in-DO SQLite database, persisted in the EvalDO across
calls (so it survives across turns and panel disconnects). It is the persistent
storage companion to `scope`.

```
eval({ code: `
  db.run("CREATE TABLE IF NOT EXISTS findings (id INTEGER PRIMARY KEY, note TEXT)");
  db.run("INSERT INTO findings (note) VALUES (?)", "first finding");
  const rows = db.exec("SELECT * FROM findings");
  console.log(rows);
  return rows;
` })
```

- `db.exec(query, ...params)` runs a statement and returns the rows as an array.
- `db.run(query, ...params)` runs a statement for its side effect (no result).
- Reserved tables `state`, `repl_scopes`, and `sqlite_*` are off-limits to
  destructive statements (DROP/DELETE/ALTER/UPDATE/INSERT/REPLACE/TRUNCATE/CREATE)
  — use your own table names. Create and write your own tables freely.

(For storage that other panels/workers need to read, define a Durable Object and
use its `this.sql`, then call it over RPC. See the workers guide
`workspace/workers/README.md` and `workspace-dev/WORKERS.md`. The eval `db` is
private to your EvalDO.)

## Filesystem Access

`fs` is injected and scoped to your current context — no contextId argument:

```
eval({ code: `
  const content = await fs.readFile("src/index.ts", "utf-8");
  console.log(content);
` })
```

Pass an encoding such as `"utf-8"` when reading text. Without an encoding,
`fs.readFile` returns bytes, so string methods like `.replace()` will fail.

Available methods: `readFile`, `writeFile`, `readdir`, `stat`, `mkdir`, `rm`,
`exists`, `rename`. (Note: source edits that must take effect for builds go
through the `edit`/`write` tools or `vcs.applyEdits`, not `fs.writeFile` — see
the VCS note below.)

## Calling Services

Use `services.<svc>.<method>(...)` or `rpc.call("<svc>.<method>", [...])` to
reach server/main services. `services` is a proxy: `services.git.status(...)`
is `rpc.call("git.status", [...])`.

```
eval({ code: `
  const tree = await rpc.call("workspace.sourceTree", []);
  console.log("Workspace tree:", tree);
  // or, equivalently:
  const tree2 = await services.workspace.sourceTree();
` })
```

Use `await help()` for the live service catalog and `await help("vcs")` for one
service's surface.

## Worker Management

```
eval({ code: `
  const sources = await services.workers.listInstanceSources();
  console.log("Available worker sources:", sources);
  const instances = await services.workers.list();
  console.log("Running instances:", instances);
` })
```

## Workspace VCS

Use the `vcs` service for workspace source changes:
`rpc.call("vcs.<method>", [...])` or `services.vcs.<method>(...)`.

Edits are edit-first: applying an edit commits it to your context head and
projects it to disk atomically. The `edit`/`write` tools do this for you;
`vcs.applyEdits` does the same directly and returns the new `stateHash`.

VCS tracks workspace **source**: every path must live under a tracked directory
(`projects/`, `panels/`, `packages/`, `apps/`, `workers/`, `skills/`,
`extensions/`). A *temporary* file you commit still goes under one of those (e.g.
`projects/tmp-foo.txt`) — `vcs.applyEdits` rejects platform-ignored paths
(`.natstack`, `.tmp`, `.git`, `.gad`, `node_modules`, `dist`, `.env`, `*.log`),
so never use an `fs.mktemp()` path here. `vcs.readFile("", path)` returns
`{ content, stateHash, ... }` (no `baseStateHash` field) — pass its `stateHash`
as the `baseStateHash` of a later `applyEdits`.

```
eval({ code: `
  const before = (await services.vcs.resolveHead()).stateHash;
  const result = await services.vcs.applyEdits({
    baseStateHash: before,
    edits: [
      { kind: "write", path: "panels/my-panel/index.tsx", content: { kind: "text", text: "..." } },
    ],
  });
  console.log("New state:", result.stateHash);
  const status = await services.vcs.status();
  console.log("Changed files:", [...status.added, ...status.changed, ...status.removed]);
` })
```

`vcs.status()` takes no workspace-root or repo-path argument. Its optional
argument is a materialized VCS head such as `"main"` or `"ctx:..."`. It reports
that head's unpublished changes vs `main`, not filesystem dirtiness. To compare
two committed states, use state hashes returned by `vcs.applyEdits` or
`resolveHead`:

```
eval({ code: `
  const before = (await services.vcs.resolveHead("main")).stateHash;
  const after = (await services.vcs.resolveHead()).stateHash;
  const diff = before ? await services.vcs.diff(before, after) : null;
  console.log({ before, after, diff });
` })
```

## Large Results And Diagnostics

Do not return broad hydrated channel histories, full `scope` dumps, large DOM
dumps, or full GAD payloads from `eval`. Large values are intentionally stored as
blob refs in trajectory/channel storage; broad hydrated reads can pull them back
into the transcript and hide the useful part of the report.

Prefer compact inspectors first:

```ts
return await rpc.call("gad.inspectChannelEnvelopes", [{ channelId, limit: 50 }]);
return await rpc.call("gad.inspectTurnState", [{ branchId }]);
return await rpc.call("gad.inspectInvocationState", [{ transportCallId }]);
return await rpc.call("gad.inspectPublicationIntegrity", [{ channelId }]);
```

If you need a large artifact, store the full bytes/text in the **blobstore** and
return its digest, byte count, and a small head sample. Keep full objects in
`scope` only for short-lived interactive follow-up.

The blobstore is a curated runtime binding — reach it as `services.blobstore`
(equivalently `import { blobstore } from "@workspace/runtime"`, or the raw
`rpc.call("blobstore.<method>", [...])`). Read/write methods
(`putText`/`putBase64`/`getText`/`getRange`/`grep`/…) work from agent eval; the
admin methods (`delete`/`list`/`pruneUnreferenced`) are server-only. A binary
artifact (e.g. a screenshot you captured) goes in as base64:

```ts
const { digest, size } = await services.blobstore.putBase64(pngBase64);
return { digest, size, kind: "image/png" };
```

Preferred return shape for large artifacts:

```ts
const text = JSON.stringify(largeValue);
const stored = await services.blobstore.putText(text);
return {
  omitted: true,
  reason: "large diagnostic value stored in blobstore",
  digest: stored.digest,
  bytes: new TextEncoder().encode(text).byteLength,
  type: Array.isArray(largeValue) ? "array" : typeof largeValue,
  keys: largeValue && typeof largeValue === "object" ? Object.keys(largeValue).slice(0, 20) : [],
  preview: text.slice(0, 1000),
};
```

The method transport also caps oversized durable results and records a blob
digest when storage is available. Agents should still return bounded summaries
because compact results are easier to inspect and less likely to hide the
important error message. Read stored text with
`services.blobstore.getRange(digest, offset, length)` or search it server-side
with `services.blobstore.grep(digest, pattern)`.

## Build System

```
eval({ code: `
  // Build a panel at the current head and get its bundle
  const build = await rpc.call("build.getBuild", ["panels/my-app"]);
  console.log("Build artifacts:", Object.keys(build));

  // Build at a specific immutable GAD state ref (second arg) — e.g. an
  // outputStateHash from vcs.log(), or (await vcs.resolveHead("main")).stateHash.
  // The returned build's sourceStateHash echoes the requested ref.
  const [{ outputStateHash }] = await services.vcs.log(1);
  const pinned = await rpc.call("build.getBuild", ["panels/my-app", outputStateHash]);
  console.log("Built at:", pinned.sourceStateHash);

  // Check effective version
  const ev = await rpc.call("build.getEffectiveVersion", ["panels/my-app"]);
  console.log("Effective version:", ev);
`
})
```

## Return Values

The last expression or `return` value is serialized and sent back to the agent:

```
eval({ code: `
  const files = await fs.readdir("src");
  return files;
` })
// Agent receives a result whose returnValue is ["index.ts", "utils.ts", ...]
```

## Timeouts

Eval runs are not bounded by a hidden wall-clock timeout; they finish on
completion, error, or explicit interruption. Split long work into shorter runs
and carry state in `scope` or `db` (both persisted in the EvalDO between runs,
across turns, and across panel disconnects).

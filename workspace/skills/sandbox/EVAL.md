# Eval Tool

Run TypeScript/JavaScript code in the panel sandbox. Code executes immediately, console output streams to the agent in real-time, and the return value is sent back.

## Basic Usage

```
eval({ code: `console.log("hello")` })
```

For multi-file code, put the entry point in the workspace and use `path`:

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

## Console Streaming

`console.log/warn/error/info/debug` output streams to the agent in real-time as the code runs. The final console output is also included in the return value.

## Large Return Values

Durable eval results are capped at the channel-method boundary. If a return
value is too large to inline safely, the terminal invocation event contains an
omitted-result summary with byte count, preview, type/key summary, and a
blobstore pointer to the full JSON. Store broad query results in `scope` and
return compact summaries; fetch exact blobs or envelopes only after you know the
artifact you need.

## Imports

Use static `import` syntax for `@workspace/runtime`, workspace skills, and
workspace packages. Dynamic `await import(...)` may work for ordinary browser
ESM, but it is not the supported path for runtime or workspace package loading
because the eval loader plans those dependencies statically.

Do not use dynamic `await import(...)` to probe optional
`@workspace/*`, `@workspace-skills/*`, or `@natstack/*` packages. Import the
helper statically and catch the helper call, or run truly optional probes as
separate small eval calls so one missing package does not break the main
snapshot.

### Workspace packages — auto-resolved

Workspace packages (`@workspace/*`, `@workspace-skills/*`, `@natstack/*`) are **automatically built and loaded** when you import them. Just write the import — no `imports` parameter needed:

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

**Important:** Workspace runtime units are built from the committed context head, which is always in lockstep with your edits. Edits are edit-first: the `edit`/`write` tools and `vcs.applyEdits` apply each change to source under `apps/`, `extensions/`, `packages/`, `panels/`, `workers/`, or `skills/` as one atomic GAD transition on your context head and project it to disk, so the change takes effect for builds immediately — there is no separate commit step. Do not edit source via `fs.writeFile` and expect it to build: the worktree is a projection, builds read GAD state, and there is no commit step to ingest stray `fs` writes.

Context folders are isolated working trees backed by context-local VCS heads. Do not assume another context's edits reset your current context. An "unpublished changes" count shown by a running panel is the unpublished state of that panel's own context head (changes ahead of `main`), not a global workspace state.

### npm packages

For raw inline code, use the `imports` parameter with `"npm:<version>"`:

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

- File-loaded code supports static relative `import`, `export ... from`, and
  literal `require()` specifiers only. Dynamic `import()` and computed
  `require()` are not supported.
- `package.json` `exports`, lockfile-exact versions, and full Node
  `node_modules` resolution are not implemented.
- `eval`, `inline_ui`, `load_action_bar`, and `feedback_custom` all support explicit `imports`; file-loaded sources also infer bare imports from the nearest `package.json` when possible.
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

## Pre-injected Variables

Only `chat`, `scope`, `scopes`, and `help` are pre-injected. Use them directly;
do not import them from `@workspace/runtime`. Everything else (`db`, `fs`, `rpc`,
`ai`, `workers`, `workspace`, `contextId`) must be imported from
`@workspace/runtime` — bare references throw `ReferenceError`.

## REPL Scope

`scope` is a live in-memory object shared across eval calls. Store anything — handles, pages, functions, class instances, data — and it all works between calls within the same panel session. No serialization happens between eval calls; `scope` is the same in-memory Proxy every time.

Serialization only matters in two situations:

1. **Panel reload** — scope is rehydrated from DB. Data survives, functions/class instances are lost.
2. **`scopes.get(id)`** — returns a serialized snapshot. Data only, no functions.

### Basic Usage

```
// Call 1: Store data in scope
eval({ code: `
  scope.items = [1, 2, 3];
  scope.name = "test";
  console.log("Stored", scope.items.length, "items");
` })

// Call 2: Access persisted data
eval({ code: `
  console.log("Name:", scope.name);       // "test"
  console.log("Items:", scope.items);      // [1, 2, 3]
  scope.items.push(4);                     // deep mutation — auto-saved after eval
` })
```

### scope vs scopes

- **`scope`** — the live in-memory object. Holds everything including functions and class instances. Works perfectly between eval calls. This is what you read/write during normal operation.
- **`scopes`** — management API for the serialized (DB) layer:
  - `scopes.currentId` — current scope's durable UUID
  - `scopes.push()` — serialize + archive current scope, start a fresh one (only serializable values carry over)
  - `scopes.get(id)` — retrieve an archived scope by its durable ID (deserialized snapshot — data only, no functions)
  - `scopes.list()` — list all scopes for this channel with keys and partial keys
  - `scopes.save()` — force-serialize scope to DB now (use after non-eval writes)

### Serialization

Scope is serialized per-property when persisted:

- **Kept:** primitives, plain objects, arrays, Date, Map, Set, RegExp
- **Dropped:** functions, symbols, class instances, WeakRef/WeakMap/WeakSet, circular refs, depth > 20
- **Partial restoration:** if `scope.browser` is a panel handle, after reload `scope.browser.id` and `scope.browser.title` survive but function-valued fields such as `scope.browser.cdp.lightweightPage` are lost

On reload, a system message lists what was restored, partially restored, and lost.

### Deep Mutations

Deep mutations (`scope.data.push(x)`, `scope.config.key = val`) are captured by the post-eval auto-save. No need for extra `scopes.save()` calls within eval.

### Scope History

Scopes are append-only. Each has a stable UUID:

```
// Push creates a new scope (old one is archived)
eval({ code: `
  scope.phase = "data-collection";
  const oldId = scopes.currentId;
  const newId = await scopes.push();
  console.log("Old scope:", oldId, "New scope:", newId);
  scope.phase = "analysis";  // new scope
  const old = await scopes.get(oldId);
  console.log("Old phase:", old.phase);  // "data-collection"
` })
```

### Persistence Contract

- **Automatic after every eval call** — no action needed
- **Non-eval writes require explicit `scopes.save()`** — inline_ui/action-bar button handlers, async callbacks, timers, feedback_custom interactions
- Example: an inline_ui component modifies `scope.count++` on button click → call `scopes.save()` to persist

## Filesystem Access

```
eval({ code: `
  import { fs } from "@workspace/runtime";
  const content = await fs.readFile("src/index.ts", "utf-8");
  console.log(content);
` })
```

Pass an encoding such as `"utf-8"` when reading text. Without an encoding,
`fs.readFile` returns bytes, so string methods like `.replace()` will fail.

## Database Access

`eval` runs ephemeral code — there is no importable `db` and no persistence across
runs. For persistent storage, define a Durable Object and use its `this.sql` API,
then call that DO over RPC. See the workers guide (`workspace/workers/README.md`)
and `workspace-dev/WORKERS.md`.

## Worker Management

```
eval({ code: `
  import { workers } from "@workspace/runtime";
  const sources = await workers.listInstanceSources();
  console.log("Available worker sources:", sources);
  const instances = await workers.list();
  console.log("Running instances:", instances);
` })
```

## Workspace VCS

Use the `vcs` helper from `@workspace/runtime` for workspace source changes.
Sandbox eval does not provide Node built-ins such as `node:child_process`; if an operation seems to need a process, first look for a runtime API (`fs`, `vcs`, `git`, `workspace`, `workers`, `extensions`) or move privileged host work into an extension/worker service.

Edits are edit-first: applying an edit commits it to your context head and
projects it to disk atomically. The `edit`/`write` tools do this for you;
`vcs.applyEdits` does the same directly and returns the new `stateHash`.

```
eval({ code: `
  import { vcs } from "@workspace/runtime";

  const before = (await vcs.resolveHead()).stateHash;
  const result = await vcs.applyEdits({
    baseStateHash: before,
    edits: [
      { kind: "write", path: "panels/my-panel/index.tsx", content: { kind: "text", text: "..." } },
    ],
  });
  console.log("New state:", result.stateHash);
  const status = await vcs.status();
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
  import { vcs } from "@workspace/runtime";
  const before = (await vcs.resolveHead("main")).stateHash;
  const after = (await vcs.resolveHead()).stateHash;
  const diff = before ? await vcs.diff(before, after) : null;
  console.log({ before, after, diff });
` })
```

## Large Results And Diagnostics

Do not return broad hydrated channel histories, full `scope.results`, large DOM
dumps, or full GAD payloads from `eval`. Large values are intentionally stored as
blob refs in trajectory/channel storage; broad hydrated reads can pull them back
into the transcript and hide the useful part of the report.

Prefer compact inspectors first:

```ts
import { gad } from "@workspace/runtime";

return await gad.inspectChannelEnvelopes({ channelId, limit: 50 });
return await gad.inspectTurnState({ branchId });
return await gad.inspectInvocationState({ transportCallId });
return await gad.inspectPublicationIntegrity({ channelId });
```

If you need a large artifact, store the full text in blobstore and return its
digest, byte count, and a small head sample. Keep full objects in `scope` only
for short-lived interactive follow-up.

Preferred return shape for large artifacts:

```ts
const text = JSON.stringify(largeValue);
const stored = await rpc.call("main", "blobstore.putText", [text]);
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
`rpc.call("main", "blobstore.getRange", [digest, offset, length])` or search it
server-side with `rpc.call("main", "blobstore.grep", [digest, pattern])`.

## Extension Calls

`extensions.use(name)` is synchronous and returns a method proxy. Do not `await`
it and do not attach `.catch(...)` to it. Catch the actual extension method
Promise instead:

```ts
import { extensions } from "@workspace/runtime";

const typecheck = extensions.use("@workspace-extensions/typecheck-service");
const result = await typecheck.checkPanel("panels/spectrolite").catch((error) => ({
  error: String(error),
}));
return result;
```

Run workspace unit tests through the scoped test-runner extension, not shell
commands:

```ts
import { extensions } from "@workspace/runtime";

const tests = extensions.use("@workspace-extensions/test-runner");
const result = await tests
  .run({
    target: "packages/my-lib",
    fileFilter: "src/index.test.ts",
  })
  .catch((error) => ({ error: String(error) }));
return result;
```

For read-only queries, RPC shortcuts work too:

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  const tree = await rpc.call("main", "workspace.sourceTree", []);
  console.log("Workspace tree:", tree);
` })
```

## Browser Data Import

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";

  // Detect installed browsers
  const browsers = await browserData.detectBrowsers();
  console.log("Detected browsers:", browsers.map(b => b.displayName));

  // Import cookies from Chrome
  const chrome = browsers.find(b => b.name === "chrome");
  if (chrome) {
    const result = await browserData.startImport({
      browser: "chrome",
      profile: chrome.profiles[0] ?? chrome.dataDir,
      dataTypes: ["cookies"],
    });
    console.log("Import result:", result);
  }
`
})
```

## Panel Navigation

```
eval({ code: `
  import { openPanel } from "@workspace/runtime";

  // Open a URL in a browser panel
  await openPanel("https://example.com");

  // Open a workspace panel
  await openPanel("panels/chat", { stateArgs: { topic: "hello" } });

  // Use openPanel when you need page automation
  const handle = await openPanel("https://example.com");
  const page = await handle.cdp.lightweightPage();
  console.log(await page.title());
` })
```

## Sending Messages to Chat

Use `chat.send(...)` only when eval is deliberately simulating a user-authored
follow-up prompt that should be fed back to the agent. In normal eval flows,
return values or `console.log` output are better for agent-visible diagnostics,
and agent acknowledgements should come from the agent's normal response path.
`chat.send(...)` publishes a canonical `message.completed` agentic event and is
rendered by `agentic-chat`.

```
eval({ code: `
  // chat is pre-injected
  await chat.send("Hello from eval!");
` })
```

Do **not** use `chat.publish("message", { content })` for ordinary chat text;
that writes a legacy raw PubSub row which may be in the durable log but is not
reduced into the current transcript UI.

## Build System

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  // Build a panel and get its bundle
  const build = await rpc.call("main", "build.getBuild", ["panels/my-app"]);
  console.log("Build artifacts:", Object.keys(build));
  // Check effective version
  const ev = await rpc.call("main", "build.getEffectiveVersion", ["panels/my-app"]);
  console.log("Effective version:", ev);
`
})
```

## Type Checking

```
eval({ code: `
  import { extensions } from "@workspace/runtime";
  const typecheck = extensions.use("@workspace-extensions/typecheck-service");
  const result = await typecheck.checkPanel("panels/my-app");
  console.log("Type errors:", result);
`
})
```

## Return Values

The last expression or `return` value is serialized and sent back to the agent:

```
eval({ code: `
  import { fs } from "@workspace/runtime";
  const files = await fs.readdir("src");
  return files;
` })
// Agent receives: { consoleOutput: "", returnValue: ["index.ts", "utils.ts", ...] }
```

Non-serializable values (functions, symbols, circular refs) are safely converted to string representations.

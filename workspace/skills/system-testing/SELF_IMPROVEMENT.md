# Self-Improvement Workflow

When system tests reveal bugs in NatStack, follow this workflow to fix them.

## Priority: Fix Infrastructure First

**Never work around broken infrastructure in skills or prompts.** If an RPC method returns unintuitive results, has a confusing signature, swallows errors, or doesn't exist when it should — fix the service, not the caller. The goal is a platform where agents can discover how to use APIs naturally from skill documentation, without needing implementation tricks.

Concretely:

- **RPC method doesn't work as expected** → fix the service in `src/server/services/`, not the eval code calling it
- **API requires unintuitive parameters** → fix the API signature, add sensible defaults, improve error messages
- **Error is swallowed or unclear** → surface it properly with a descriptive message
- **Capability missing** → add it to the service layer, don't hack a workaround in eval
- **Skill docs are misleading** → fix the docs AFTER fixing the underlying API

Only after the infrastructure is solid should you adjust skills or test prompts. The test agent should be able to accomplish any task with minimal hints — if it can't, the platform has a bug.

## Phase 1: Run Tests

Run the full suite with test-level parallelism so agents exercise the runtime
under realistic contention. The progress callback checkpoints partial results
after every completed test.

```
eval({
  code: `
    import { HeadlessRunner, TestRunner, allTests } from "@workspace-skills/system-testing";
    import { contextId } from "@workspace/runtime";

    const runner = new HeadlessRunner(contextId);
    const tester = new TestRunner(runner, {
      onTestStart: (t) => console.log("  Running: " + t.name + "..."),
      onTestEnd: (t, r, ex) => console.log("  " + (r.passed ? "PASS" : "FAIL") + ": " + t.name + " (" + ex.duration + "ms)"),
      onTestResult: (_entry, aggregate) => {
        scope.results = aggregate;
        console.log("  Progress: " + aggregate.total + "/" + allTests().length);
      },
      testTimeoutMs: 20 * 60 * 1000,
    });

    const results = await tester.runSuiteParallel(allTests(), { concurrency: 24 });
    scope.results = results;
    return {
      total: results.total,
      passed: results.passed,
      failed: results.failed,
      errored: results.errored,
      skipped: results.skipped,
    };
  `,
})
```

## Phase 2: Analyze Failures

For each failed test, inspect **everything** — the conversation, every tool call and its result, harness lifecycle, and participant state:

```typescript
for (const r of scope.results.results.filter((r) => !r.result.passed)) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`FAIL: ${r.test.name} (${r.test.category})`);
  console.log(`Prompt: ${r.test.prompt}`);
  console.log(`Validation: ${r.result.reason}`);
  console.log(`Duration: ${r.execution.duration}ms`);
  if (r.execution.error) console.log(`Session error: ${r.execution.error}`);

  // 1. Full conversation — every message exchanged
  console.log(`\n--- Conversation (${r.execution.messages.length} messages) ---`);
  const selfId = r.execution.messages[0]?.senderId;
  for (const m of r.execution.messages) {
    const who = m.senderId === selfId ? "USER" : "AGENT";
    const type = m.contentType ?? m.kind ?? "text";
    console.log(`  [${who}] (${type}) ${m.content?.slice(0, 500) ?? "(empty)"}`);
    if (m.error) console.log(`    ERROR: ${m.error}`);
  }

  // 2. Invocation cards — every tool call, args, return value, errors
  const snap = r.execution.snapshot;
  if (snap?.invocations.length) {
    console.log(`\n--- Invocations (${snap.invocations.length} calls) ---`);
    for (const inv of snap.invocations) {
      console.log(`  [${inv.status}] ${inv.name}`);
      if (inv.error) console.log(`    Error: ${inv.error}`);
    }
  }

  // 3. Debug events — harness lifecycle (spawn, start, stop, crash)
  if (snap?.debugEvents.length) {
    console.log(`\n--- Debug Events (${snap.debugEvents.length}) ---`);
    for (const ev of snap.debugEvents) {
      console.log(`  ${JSON.stringify(ev).slice(0, 300)}`);
    }
  }

  // 4. Participants — who joined, who disconnected
  if (snap?.participants) {
    console.log(`\n--- Participants ---`);
    for (const [id, p] of Object.entries(snap.participants)) {
      console.log(
        `  ${p.name} (${p.type}/${p.handle}): ${p.connected ? "connected" : "DISCONNECTED"}`
      );
    }
  }
}
```

If lifecycle events show `turn.opened` but no assistant message, tool call, or
`turn.closed`, query the agent debug port instead of adding sleeps or timeouts:

```typescript
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
console.log(JSON.stringify(debug, null, 2).slice(0, 4000));
```

The default AI agent exposes this read-only method for stall diagnosis. It
captures dispatcher state, runner phase, persisted pending work, checkpoints,
and recent lifecycle/debug events. See `docs/agent-debug-port.md` for the full
field guide.

## Phase 3: Classify the Root Cause

For each failure, determine the root cause category and act accordingly:

### Infrastructure bugs (fix the platform)

- **RPC method returns wrong data** → fix the service handler
- **RPC method missing** → add it to the service definition
- **Error swallowed silently** → add proper error propagation
- **API signature unintuitive** → redesign the API, add defaults, improve types
- **Missing capability** → implement it in the service layer
- **Service not registered** → add it to the server or Electron ServiceContainer; only add true Electron-local services to `ELECTRON_LOCAL_SERVICE_NAMES`

### Documentation bugs (fix the docs)

- **Skill docs describe a different API** → update the skill docs to match reality
- **Skill docs missing a capability** → add documentation for the undocumented feature
- **System prompt misleads the agent** → fix the headless system prompt

### Test bugs (fix the test — last resort)

- **Validation too strict** → loosen the validator, but only after confirming the agent's response is correct
- **Prompt ambiguous** → clarify the prompt, but only if the underlying API works correctly
- **Long-running task** → inspect where progress stopped and fix the blocked operation

**Default assumption: the infrastructure is wrong, not the test.** Only classify as a test bug after reading the service code and confirming the API works correctly.

## Phase 4: Identify Files to Change

| Symptom                     | Likely files                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| fs operation failed         | `src/server/services/fsService.ts`, `workspace/packages/runtime/src/panel/fs.ts`                   |
| DO storage operation failed | `src/server/internalDOs/*`, `workspace/packages/runtime/src/worker/durable-base.ts`                |
| git operation failed        | `packages/git/src/client.ts`, `src/server/services/gitService.ts`                                  |
| Build failed                | `src/server/buildV2/`, `build.mjs`                                                                 |
| Worker/DO issue             | `src/server/services/workerService.ts`, `workspace/packages/runtime/src/worker/`                   |
| Panel lifecycle             | `src/main/panelOrchestrator.ts`, `src/server/services/bridgeService.ts`                            |
| Credential/OAuth error      | `src/server/services/credentialService.ts`, `workspace/packages/runtime/src/shared/credentials.ts` |
| Harness crash               | `packages/harness/src/entry.ts`, `src/server/harnessManager.ts`                                    |
| PubSub issue                | `workspace/packages/pubsub/src/`, `workspace/workers/pubsub-channel/`                              |
| Skill import                | `src/server/buildV2/`, package.json exports                                                        |
| Agent behavior              | `workspace/workers/agent-worker/ai-chat-worker.ts`, harness config                                 |
| RPC routing                 | `src/shared/serviceDispatcher.ts`, `packages/rpc/src/`                                             |
| Error swallowed             | Search for `.catch(` and empty catch blocks near the failure site                                  |

## Phase 5: Prepare an Editable Checkout

Pick the checkout type based on what failed.

### Workspace Runtime Repos

If the bug is in workspace-owned runtime source such as `workspace/apps/`,
`workspace/extensions/`, `workspace/packages/`, `workspace/panels/`,
`workspace/workers/`, or `workspace/skills/`, edit the existing workspace repo
directly in your context and commit/push to the internal git server. These repos
are live build inputs.

For `workspace/apps/` bugs, read `workspace/skills/appdev/SKILL.md` before
editing. App fixes can require target-specific validation: Electron host chrome,
mobile native bootstrap and principal grants, or terminal process supervision.

### NatStack Application Source

If the bug is in the NatStack application itself, such as `src/server/`,
`src/main/`, `packages/git/`, or `packages/git-server/`, use a plain project
checkout under `projects/natstack`.

#### Dogfood Server Mode

When the operator launched NatStack with:

```bash
pnpm dev:self:server
```

the active workspace is a managed dogfood workspace. The launcher creates or
reuses `~/.config/natstack/workspaces/dogfood/source/projects/natstack`, writes
`meta/dogfood.json`, and configures the running server to mirror pushes from
`projects/natstack` back to the launching checkout with a git fast-forward.

In this mode, `projects/natstack` is still a plain project, not a Build V2
runtime unit, but it is a **self-edit target**:

- Commit and push from `projects/natstack` to the internal git server.
- If the host checkout is clean and fast-forwardable, the server mirrors the
  commit back to the launching checkout.
- Server-runtime changes rebuild `dist/server.mjs` and restart the standalone
  dogfood server on the same gateway port.
- Docs, desktop shell, mobile app, and `workspace/` runtime-unit changes may
  mirror without restarting the server.
- If the host checkout is dirty, propagation is refused. Do not try to work
  around that from userland; ask the operator to clean or commit the host
  checkout.
- If the host checkout is dirty at startup, the launcher warns, but startup
  continues. The later mirror apply is what refuses dirty targets.
- If the dogfood project clone is dirty or diverged at startup, the launcher
  warns and does not force it. Resolve that git state before expecting
  fast-forward propagation.

Userland code can detect this mode by reading `meta/dogfood.json`:

```typescript
import { fs } from "@workspace/runtime";

async function getDogfoodInfo() {
  try {
    return JSON.parse(await fs.readFile("meta/dogfood.json", "utf-8"));
  } catch {
    return null;
  }
}

const dogfood = await getDogfoodInfo();
if (dogfood?.schemaVersion === 1 && dogfood.project === "projects/natstack") {
  console.log("Dogfood server mode:", dogfood.sourceRoot);
}
```

Do not rely on `NATSTACK_DOGFOOD` from userland. That environment variable is a
server launcher detail; `meta/dogfood.json` is the workspace-visible marker.

#### Normal Project Mode

When the server is not running in dogfood mode, plain projects are editable
repos, not runtime units. Changing `projects/natstack` prepares a branch/patch,
but it does not hot-patch the running NatStack server. Verification may require
restarting NatStack from that checkout or handing the branch to a developer.

Prefer an existing `projects/natstack` workspace repo when it exists. If it
does not exist yet and the workspace is not dogfood-managed, import it with
`git.importProject()`. That uses targeted approval copy, clones into canonical
workspace source, records the shared remote in `meta/natstack.yml`, and
propagates the repo into contexts. The same API can import panels, packages,
skills, workers, agents, templates, about pages, and plain projects by choosing
the destination path.

```
eval({
  code: `
    import { fs, git } from "@workspace/runtime";

    const client = git.client();
    const dir = "projects/natstack";
    try {
      await fs.stat(dir);
      console.log(dir + " already exists");
    } catch {
      await git.importProject({
        path: dir,
        remote: {
          name: "origin",
          url: "https://github.com/YOUR_ORG/natstack.git",
        },
      });
    }

    scope.git = client;
    scope.checkoutDir = dir;
  `,
})
```

**Important:** Work on a branch before making changes.

```typescript
const branchName = `fix/system-test-${failedTestName}`;
await scope.git.createBranch(scope.checkoutDir, branchName); // positional: (dir, name)
await scope.git.checkout(scope.checkoutDir, branchName);
```

## Phase 6: Edit and Fix

Edit source files in the checkout using fs operations. For a NatStack
application checkout, paths are relative to `projects/natstack/`:

```typescript
const content = await fs.readFile("projects/natstack/src/server/services/fsService.ts", "utf-8");
// ... modify content ...
await fs.writeFile("projects/natstack/src/server/services/fsService.ts", fixedContent);
```

**Fix checklist:**

- [ ] Service method has clear parameter types and returns useful data
- [ ] Errors are propagated with descriptive messages (no empty catch blocks)
- [ ] The fix is in the service/infrastructure layer, not a workaround in caller code
- [ ] Skill documentation matches the actual API after the fix

## Phase 7: Commit, Push, then Verify

**Critical:** The build system builds from git, not from the working tree. Your edits have NO effect until you commit and push them. Always commit+push before verifying.

```typescript
// First: commit and push your changes
await scope.git.addAll(scope.checkoutDir);
await scope.git.commit(scope.checkoutDir, `fix: describe the change`);
await scope.git.push(scope.checkoutDir, { remote: "origin", ref: branchName });

// Then rebuild if the fix touched workspace runtime repos. Plain projects
// such as projects/natstack are not Build V2 live inputs.
if (!scope.checkoutDir.startsWith("projects/")) {
  const buildResult = await chat.rpc.call("main", "build.recompute", []);
  console.log("Build recomputed:", buildResult);
}

// If this is dogfood mode and checkoutDir is projects/natstack, the push
// mirrors to the host checkout. Watch the operator logs for [mirror] events:
//   applied       -> host fast-forwarded; server may rebuild/restart
//   skipped-dirty -> host checkout is dirty; propagation refused
//   branch-created -> non-fast-forward; host HEAD unchanged
// Reconnect/retry the test after the dogfood server restarts.

// For panel fixes, check types in the current context before re-testing.
if (scope.checkoutDir.startsWith("panels/")) {
  const typecheck = await chat.rpc.call("main", "extensions.invoke", [
    "@workspace-extensions/typecheck-service",
    "checkPanel",
    [scope.checkoutDir],
  ]);
  console.log("Type errors:", typecheck);
}

// Re-run the specific failed test
const runner = new HeadlessRunner(contextId);
const tester = new TestRunner(runner);
const retest = await tester.runOne(failedTest);
console.log(`Re-test: ${retest.result.passed ? "PASS" : "FAIL"}`);
```

Before assuming a fix failed, verify provenance:

- the checkout containing the edit is the context the test is using
- the change is committed and pushed
- the build/reload consumed the pushed commit
- dogfood mirror logs did not report `skipped-dirty`

Planned hardening: expose a runtime build-provenance API with context id,
source path, git SHA, dirty flag, build timestamp, and artifact id, then include
it automatically in system-test failure reports.

## Phase 8: Iterate or Finalize

```typescript
if (retest.result.passed) {
  console.log(`Fix verified on branch: ${branchName}`);
} else {
  console.log("Fix didn't work. Iterating...");
  // Go back to Phase 6 — edit, commit+push, rebuild, re-test
}
```

## Tips

- **Start with smoke tests.** They're fast and catch the most common issues.
- **One fix per branch.** Don't bundle unrelated fixes.
- **Always create a branch** before making changes.
- **Check type errors before committing.** Use the `@workspace-extensions/typecheck-service` extension.
- **Re-run the full smoke suite after fixing.** Your fix might break something else.
- **Use `projects/` for plain external repos.** They are editable and can have
  shared remotes, but they are not live runtime units.
- **Shared remotes are not clone declarations.** `git.setSharedRemote()` records
  and propagates remotes for a workspace repo that exists or will exist later;
  it does not import external repository contents into workspace source.
- **Use `git.importProject()` to create a workspace repo from a remote.** It
  clones into canonical workspace source, records the shared remote, and makes
  the repo available to future contexts. Use the destination path to choose the
  category, such as `panels/name`, `skills/name`, `workers/name`, or
  `projects/name`.
- **Use `git.completeWorkspaceDependencies()` when shared remotes are already
  declared.** It imports each configured remote whose workspace repo is missing
  and reports imported, skipped, and failed paths.
- **If an API is confusing, fix the API.** Don't add comments explaining the confusion.
- **If an error message is unhelpful, fix the error message.** Don't add try/catch wrappers that translate it.
- **If a service is missing a method, add the method.** Don't chain multiple calls to work around it.

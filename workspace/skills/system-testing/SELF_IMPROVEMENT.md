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

```
eval({
  code: `
    import { HeadlessRunner, TestRunner, allTests } from "@workspace-skills/system-testing";
    import { contextId } from "@workspace/runtime";

    const runner = new HeadlessRunner(contextId);
    const tester = new TestRunner(runner, {
      onTestStart: (t) => console.log("  Running: " + t.name + "..."),
      onTestEnd: (t, r, ex) => console.log("  " + (r.passed ? "PASS" : "FAIL") + ": " + t.name + " (" + ex.duration + "ms)"),
    });

    const results = await tester.runSuite(allTests());
    scope.results = results;
    return { total: results.total, passed: results.passed, failed: results.failed };
  `,
})
```

## Phase 2: Analyze Failures

For each failed test, inspect **everything** — the conversation, every tool call and its result, harness lifecycle, and participant state:

```typescript
for (const r of scope.results.results.filter(r => !r.result.passed)) {
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

  // 2. Method history — every tool call, args, return value, errors
  const snap = r.execution.snapshot;
  if (snap?.methodHistory.length) {
    console.log(`\n--- Method History (${snap.methodHistory.length} calls) ---`);
    for (const mh of snap.methodHistory) {
      const dur = mh.duration ? `${mh.duration}ms` : "pending";
      console.log(`  [${mh.status}] ${mh.method} (${dur})`);
      if (mh.error) console.log(`    Error: ${mh.error}`);
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
      console.log(`  ${p.name} (${p.type}/${p.handle}): ${p.connected ? "connected" : "DISCONNECTED"}`);
    }
  }
}
```

## Phase 3: Classify the Root Cause

For each failure, determine the root cause category and act accordingly:

### Infrastructure bugs (fix the platform)
- **RPC method returns wrong data** → fix the service handler
- **RPC method missing** → add it to the service definition
- **Error swallowed silently** → add proper error propagation
- **API signature unintuitive** → redesign the API, add defaults, improve types
- **Missing capability** → implement it in the service layer
- **Service not registered** → add to ServiceContainer + SERVER_SERVICE_NAMES

### Documentation bugs (fix the docs)
- **Skill docs describe a different API** → update the skill docs to match reality
- **Skill docs missing a capability** → add documentation for the undocumented feature
- **System prompt misleads the agent** → fix the headless system prompt

### Test bugs (fix the test — last resort)
- **Validation too strict** → loosen the validator, but only after confirming the agent's response is correct
- **Prompt ambiguous** → clarify the prompt, but only if the underlying API works correctly
- **Timeout too short** → increase, but investigate why it's slow first

**Default assumption: the infrastructure is wrong, not the test.** Only classify as a test bug after reading the service code and confirming the API works correctly.

## Phase 4: Identify Files to Change

| Symptom | Likely files |
|---------|-------------|
| fs operation failed | `src/server/services/fsService.ts`, `workspace/packages/runtime/src/panel/fs.ts` |
| db operation failed | `src/server/services/dbService.ts`, `workspace/packages/runtime/src/shared/database.ts` |
| git operation failed | `packages/git/src/client.ts`, `src/server/services/gitService.ts` |
| Build failed | `src/server/buildV2/`, `build.mjs` |
| Worker/DO issue | `src/server/services/workerService.ts`, `workspace/packages/runtime/src/worker/` |
| Panel lifecycle | `src/main/panelOrchestrator.ts`, `src/server/services/bridgeService.ts` |
| Credential/OAuth error | `src/server/services/credentialService.ts`, `workspace/packages/runtime/src/shared/credentials.ts` |
| Harness crash | `packages/harness/src/entry.ts`, `src/server/harnessManager.ts` |
| PubSub issue | `workspace/packages/pubsub/src/`, `workspace/workers/pubsub-channel/` |
| Skill import | `src/server/buildV2/`, package.json exports |
| Agent behavior | `workspace/workers/agent-worker/ai-chat-worker.ts`, harness config |
| RPC routing | `src/shared/serviceDispatcher.ts`, `packages/rpc/src/` |
| Error swallowed | Search for `.catch(` and empty catch blocks near the failure site |

## Phase 5: Prepare an Editable Checkout

Pick the checkout type based on what failed.

### Workspace Runtime Repos

If the bug is in workspace-owned runtime source such as `workspace/packages/`,
`workspace/panels/`, `workspace/workers/`, or `workspace/skills/`, edit the
existing workspace repo directly in your context and commit/push to the
internal git server. These repos are live build inputs.

### NatStack Application Source

If the bug is in the NatStack application itself, such as `src/server/`,
`src/main/`, `packages/git/`, or `packages/git-server/`, use a plain project
checkout under `projects/natstack`. Plain projects are editable repos, not
runtime units; changing them prepares a branch/patch, but it does not hot-patch
the running NatStack server. Verification may require restarting NatStack from
that checkout or handing the branch to a developer.

Prefer an existing `projects/natstack` workspace repo when it exists. If it
does not exist yet, import it with `git.importProject()`. That uses targeted
approval copy, clones into canonical workspace source, records the shared
remote in `meta/natstack.yml`, and propagates the repo into contexts. The same
API can import panels, packages, skills, workers, agents, templates, about
pages, and plain projects by choosing the destination path.

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
await scope.git.createBranch(scope.checkoutDir, branchName);  // positional: (dir, name)
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

// Then rebuild if the fix touched workspace runtime repos.
// Plain projects such as projects/natstack are not live build inputs.
if (!scope.checkoutDir.startsWith("projects/")) {
  const buildResult = await chat.rpc.call("main", "build.recompute");
  console.log("Build recomputed:", buildResult);
}

// Check types
const typecheck = await chat.rpc.call("main", "typecheck.check");
console.log("Type errors:", typecheck);

// Re-run the specific failed test
const runner = new HeadlessRunner(contextId);
const tester = new TestRunner(runner);
const retest = await tester.runOne(failedTest);
console.log(`Re-test: ${retest.result.passed ? "PASS" : "FAIL"}`);
```

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
- **Check type errors before committing.** Use `chat.rpc.call("main", "typecheck.check")`.
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

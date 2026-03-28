# Self-Improvement Workflow

When system tests reveal bugs in NatStack, follow this workflow to fix them.

## Phase 1: Run Tests

```typescript
import { HeadlessRunner, TestRunner, allTests } from "@workspace-skills/system-testing";

const runner = new HeadlessRunner(contextId);
const tester = new TestRunner(runner, {
  onTestStart: (t) => console.log(`  Running: ${t.name}...`),
  onTestEnd: (t, r) => console.log(`  ${r.passed ? "PASS" : "FAIL"}: ${t.name}`),
});

const results = await tester.runSuite(allTests());
scope.results = results;
return { total: results.total, passed: results.passed, failed: results.failed };
```

## Phase 2: Analyze Failures

For each failed test, inspect the full execution:

```typescript
for (const r of scope.results.results.filter(r => !r.result.passed)) {
  console.log(`\n=== FAIL: ${r.test.name} ===`);
  console.log(`Category: ${r.test.category}`);
  console.log(`Description: ${r.test.description}`);
  console.log(`Validation: ${r.result.reason}`);
  console.log(`Duration: ${r.execution.duration}ms`);
  if (r.execution.error) console.log(`Error: ${r.execution.error}`);

  console.log(`\nConversation (${r.execution.messages.length} messages):`);
  for (const m of r.execution.messages) {
    const prefix = m.kind === "system" ? "[SYS]" : m.kind === "method" ? "[METHOD]" : `[${m.senderId?.slice(0, 8)}]`;
    const content = m.content?.slice(0, 200) ?? "(empty)";
    console.log(`  ${prefix} ${m.contentType ?? ""}: ${content}`);
  }
}
```

Key things to look for:
- **Agent didn't attempt the task** → system prompt issue, tool availability
- **Eval errored** → runtime API bug, missing service, incorrect RPC method
- **Agent succeeded but validation failed** → test case validation too strict, or response format changed
- **Timeout** → agent stuck in a loop, harness crash, PubSub issue
- **Agent disconnected** → harness spawn failure, DO crash

## Phase 3: Identify the Bug

Read the relevant source files to understand the root cause. Common locations:

| Symptom | Likely files |
|---------|-------------|
| fs operation failed | `workspace/packages/runtime/src/panel/fs.ts`, `src/server/services/fsService.ts` |
| db operation failed | `workspace/packages/runtime/src/shared/database.ts`, `src/server/services/dbService.ts` |
| git operation failed | `packages/git/src/client.ts`, `src/server/services/gitService.ts` |
| Build failed | `src/server/buildV2/`, `build.mjs` |
| Worker/DO issue | `workspace/packages/runtime/src/worker/`, `src/server/services/workerService.ts` |
| Panel lifecycle | `src/main/panelOrchestrator.ts` |
| OAuth error | `workspace/packages/runtime/src/shared/oauth.ts`, `src/server/services/oauthService.ts` |
| Harness crash | `packages/harness/src/entry.ts`, `src/server/harnessManager.ts` |
| PubSub issue | `workspace/packages/pubsub/src/`, `workspace/workers/pubsub-channel/` |
| Skill import | `src/server/buildV2/`, package.json exports |
| Agent behavior | `workspace/workers/agent-worker/ai-chat-worker.ts`, harness config |

## Phase 4: Fix

```typescript
// Create a fix branch
import { GitClient } from "@natstack/git";

const git = new GitClient(fs);
const branchName = `fix/system-test-${failedTestName}`;
await git.createBranch(".", branchName);
await git.checkout(".", branchName);
```

Then use your normal file editing tools (Read, Edit, Write) to fix the bug.

## Phase 5: Verify

```typescript
// Rebuild
const buildResult = await chat.rpc.call("main", "build.recompute");
console.log("Build recomputed:", buildResult);

// Run the existing vitest suite
// (via shell eval — vitest runs in Node.js, not eval sandbox)
// The agent should use eval to check for type errors:
const typecheck = await chat.rpc.call("main", "typecheck.check");
console.log("Type errors:", typecheck);

// Re-run the specific failed test
const runner = new HeadlessRunner(contextId);
const tester = new TestRunner(runner);
const retest = await tester.runOne(failedTest);
console.log(`Re-test: ${retest.result.passed ? "PASS" : "FAIL"}`);
```

## Phase 6: Commit and Push

```typescript
if (retest.result.passed) {
  await git.addAll(".");
  await git.commit(".", `fix: ${failedTest.name} — ${failedTest.description}`);
  await git.push(".", { remote: "origin", ref: branchName });
  console.log(`Pushed fix to branch: ${branchName}`);
} else {
  console.log("Fix didn't work. Iterating...");
  // Go back to Phase 3
}
```

## Tips

- **Start with smoke tests.** They're fast and catch the most common issues.
- **One fix per branch.** Don't bundle unrelated fixes.
- **Check type errors before committing.** Use `chat.rpc.call("main", "typecheck.check")`.
- **Re-run the full smoke suite after fixing.** Your fix might break something else.
- **If a test case is too strict**, consider whether the test needs updating rather than the code.

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

Start by presenting the user with a feedback UI so they can choose which stages
to run. A stage is a category-sized group by default, so stages can contain more
than three tests. Keep one eval call per stage, run as much concurrency inside
that stage as is feasible, publish a concise user-visible report after each
stage, then continue to the next selected stage.

Store the full stage/run scaffold in `scope`; return only the compact control
data needed to render the feedback form. Do not return `scope.systemTestingRun`,
the full stage list, or test result arrays from eval calls.

```
eval({
  code: `
    import { allTests, testStageChoices, testStages } from "@workspace-skills/system-testing/stages";
    const tests = allTests();
    const stages = testStages(tests);
    const stageOptions = testStageChoices(stages);
    const runId = crypto.randomUUID();
    await scopes.push();
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      skipped: tests.length,
      duration: 0,
      results: [],
    };
    scope.systemTestingRun = {
      runId,
      stages: stages.map((stage) => ({
        index: stage.index,
        name: stage.name,
        category: stage.category,
        tests: stage.tests.map((test) => test.name),
      })),
      completedStages: [],
      results,
    };
    scope.results = results;
    return {
      runId,
      stageOptions,
      defaultStages: stageOptions.map((option) => option.value),
      stageCount: stages.length,
      testCount: tests.length,
    };
  `,
})
```

Before running any tests, show a feedback form populated from the initialization
eval's `stageOptions` and `defaultStages`, then store the selected stage indexes
on `scope.systemTestingRun.selectedStageIndexes`. The selection eval should
return only a compact selection summary, such as selected stage count and
selected test count, while leaving the selected stage objects in `scope`. Do not
hard-code stage names or counts; they must come from the current system-testing
skill exports. If the user cancels, stop and report that no tests were run.

Then run the next selected stage with this eval. This eval must be invoked once
per stage and must not contain a `for`, `while`, or recursive loop over stages.
After it returns, publish/report the stage findings in the normal assistant
turn. If `remainingStages` is greater than `0`, continue by issuing this same
eval again as a new tool call.

Run the short stage-loop snippet directly in eval. File-loaded eval remains
preferred for substantive multi-line or multi-file code, but helper files should
not be used merely to wrap this stage loop. If eval cannot be called, report
the exact failed eval attempt and its exact error; helper-file edit/write/read
errors are separate setup failures.

```
eval({
  code: `
    import { HeadlessRunner } from "@workspace-skills/system-testing/runner";
    import { TestRunner } from "@workspace-skills/system-testing/test-runner";
    import { allTests, nextSelectedStage } from "@workspace-skills/system-testing/stages";
    import { contextId } from "@workspace/runtime";
    const tests = allTests();
    const run = scope.systemTestingRun;
    if (!run || typeof run !== "object") {
      throw new Error("No active systemTestingRun. Run the initialization eval first.");
    }
    const next = nextSelectedStage(tests, run);
    if (!next) {
      const aggregate = run.results ?? scope.results;
      return {
        done: true,
        runId: run.runId,
        total: aggregate?.total ?? 0,
        passed: aggregate?.passed ?? 0,
        failed: aggregate?.failed ?? 0,
        errored: aggregate?.errored ?? 0,
        toolFailureCount: aggregate?.toolFailureCount ?? 0,
        testsWithToolFailures: aggregate?.testsWithToolFailures ?? 0,
        skipped: aggregate?.skipped ?? 0,
      };
    }
    const { stage, stagePosition, selectedStages } = next;
    const completed = new Set(Array.isArray(run.completedStages) ? run.completedStages : []);

    const runner = new HeadlessRunner(contextId);
    const tester = new TestRunner(runner, {
      onTestStart: (t) => console.log("  Running: " + t.name + "..."),
      onTestEnd: (t, r, ex) => console.log("  " + (r.passed ? "PASS" : "FAIL") + ": " + t.name + " (" + ex.duration + "ms)"),
      onTestResult: (_entry, aggregate) => {
        console.log("  Stage progress: " + stage.name + " " + aggregate.total + "/" + stage.tests.length);
      },
      testTimeoutMs: 20 * 60 * 1000,
    });

    const concurrency = stage.category === "workers"
      ? 1
      : Math.min(2, Math.max(1, stage.tests.length));
    const partial = await tester.runSuite(stage.tests, { concurrency });
    const aggregate = run.results ?? scope.results ?? {
      total: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      toolFailureCount: 0,
      testsWithToolFailures: 0,
      skipped: tests.length,
      duration: 0,
      results: [],
    };
    aggregate.total += partial.total;
    aggregate.passed += partial.passed;
    aggregate.failed += partial.failed;
    aggregate.errored += partial.errored;
    aggregate.toolFailureCount = (aggregate.toolFailureCount ?? 0) + (partial.toolFailureCount ?? 0);
    aggregate.testsWithToolFailures = (aggregate.testsWithToolFailures ?? 0) + (partial.testsWithToolFailures ?? 0);
    aggregate.duration += partial.duration;
    aggregate.results.push(...partial.results);
    aggregate.skipped = tests.length - aggregate.total;
    completed.add(stage.index);
    run.completedStages = [...completed];
    run.results = aggregate;
    run.stageSummaries = Array.isArray(run.stageSummaries) ? run.stageSummaries : [];
    scope.systemTestingRun = run;
    scope.results = aggregate;

    const failedNames = partial.results
      .filter((entry) => !entry.result.passed || entry.execution.error)
      .map((entry) => {
        const reason = entry.execution.error || entry.result.reason || "No reason captured";
        return entry.test.name + ": " + reason.slice(0, 240);
      });
    const toolFailureNames = partial.results
      .filter((entry) => (entry.execution.toolFailures?.length ?? 0) > 0)
      .map((entry) => {
        const tools = entry.execution.toolFailures.map((failure) => failure.name).join(", ");
        return entry.test.name + ": " + entry.execution.toolFailures.length + " tool failure(s): " + tools;
      });
    const remainingStages = selectedStages.filter((item) => !completed.has(item.index)).length;
    const stageSummary = {
      index: stage.index,
      name: stage.name,
      position: stagePosition,
      selectedStageCount: selectedStages.length,
      total: partial.total,
      passed: partial.passed,
      failed: partial.failed,
      errored: partial.errored,
      toolFailureCount: partial.toolFailureCount ?? 0,
      testsWithToolFailures: partial.testsWithToolFailures ?? 0,
      durationMs: partial.duration,
      concurrency,
      failedTests: failedNames,
      toolFailures: toolFailureNames,
    };
    run.stageSummaries.push(stageSummary);
    run.lastStageSummary = stageSummary;
    scope.systemTestingRun = run;
    const reportLines = [
      "**System Test Stage " + stagePosition + "/" + selectedStages.length + ": " + stage.name + "**",
      "- Stage results: " + partial.passed + " passed, " + partial.failed + " failed, " + partial.errored + " errored",
      "- Concurrency: " + concurrency + " test agents",
      "- Cumulative results: " + aggregate.passed + " passed, " + aggregate.failed + " failed, " + aggregate.errored + " errored, " + aggregate.skipped + " not run/skipped",
      failedNames.length ? "- Findings: " + failedNames.join("; ") : "- Findings: no failures in this stage",
      "- Next: " + (remainingStages ? "continuing to the next selected stage" : "all selected stages complete"),
    ];
    await chat.publish("message", { content: reportLines.join("\\n") });

    return {
      runId: run.runId,
      stage: stage.name,
      remainingStages,
      total: aggregate.total,
      passed: aggregate.passed,
      failed: aggregate.failed,
      errored: aggregate.errored,
      toolFailureCount: aggregate.toolFailureCount ?? 0,
      testsWithToolFailures: aggregate.testsWithToolFailures ?? 0,
      skipped: aggregate.skipped,
      failedTestCount: failedNames.length,
      toolFailureTestCount: toolFailureNames.length,
    };
  `,
})
```

## Phase 2: Analyze Failures

Full test state lives in `scope.results.results`, with compact per-stage
summaries in `scope.systemTestingRun.stageSummaries`. Eval return values are
only progress/control packets; do not use them as the diagnostic record.

Tool failures are not automatically task failures. If a subagent hits a tool
error and then recovers enough to satisfy validation, keep the test as passed
but report the tool failure as an investigation item. Do not trim messages or
snapshots from passing results; the top-level agent needs the full raw evidence
to determine whether the issue is runtime, docs, harness, or expected recovery.
`summarizeFailures(scope.results)` includes both failed tests and passed tests
with tool failures, so use it as the bounded investigation packet before
drilling into the full raw session state.

For each failed test, inspect **everything** — the conversation, every tool call and its result, harness lifecycle, and participant state. Never hand off only filenames or artifact paths. A useful report must say what the test agent did, where it diverged from the expected marker/behavior, what tool calls completed or errored, and whether the failure looks like runtime, docs, harness, or test validation.

Start with the bounded summary helper:

```typescript
import { summarizeFailures } from "@workspace-skills/system-testing/diagnostics";
return summarizeFailures(scope.results);
```

Then drill into any failure whose summary does not explain the mismatch:

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

If a build failure follows a successful VCS commit, inspect the server's
state-triggered build event buffer before retrying. The commit call can return
before the background build finishes:

```typescript
import { rpc } from "@workspace/runtime";

return {
  recent: await rpc.call("main", "build.listRecentBuildEvents", []),
  forUnit: await rpc.call("main", "build.listRecentBuildEvents", ["panels/example"]),
  unit: await rpc.call("main", "build.inspectBuildProvenance", [
    "panels/example",
  ]),
};
```

`build.listRecentBuildEvents` can be filtered with a unit name or
workspace-relative path. State-triggered events include `trigger.head`,
`trigger.stateHash`, and `trigger.changedPaths`. An edit applied via
`vcs.applyEdits(...)` returns the resulting `stateHash` and `changedPaths`;
pass the unit path here for the matching build-event lookup.

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
| GAD VCS operation failed    | `src/server/services/vcsService.ts`, `src/server/gadVcs/`, `workspace/packages/runtime/src/shared/vcsClient.ts` |
| external Git operation failed | `packages/git/src/client.ts`, `src/server/services/gitInteropService.ts`                         |
| Build failed                | `src/server/buildV2/`, `build.mjs`                                                                 |
| Worker/DO issue             | `src/server/services/workerService.ts`, `workspace/packages/runtime/src/worker/`                   |
| Panel lifecycle             | `src/main/panelOrchestrator.ts`, `src/server/services/bridgeService.ts`                            |
| Credential/OAuth error      | `src/server/services/credentialService.ts`, `workspace/packages/runtime/src/shared/credentials.ts` |
| Harness crash               | `workspace/packages/harness/src/entry.ts`, `src/server/harnessManager.ts`                          |
| PubSub issue                | `workspace/packages/pubsub/src/`, `workspace/workers/pubsub-channel/`                              |
| Skill import                | `src/server/buildV2/`, package.json exports                                                        |
| Agent behavior              | `workspace/workers/agent-worker/ai-chat-worker.ts`, harness config                                 |
| RPC routing                 | `src/shared/serviceDispatcher.ts`, `packages/rpc/src/`                                             |
| Error swallowed             | Search for `.catch(` and empty catch blocks near the failure site                                  |

## Phase 5: Prepare an Editable Checkout

Pick the checkout type based on what failed.

### Workspace Runtime Source

If the bug is in workspace-owned runtime source — from your file root that is
`apps/`, `extensions/`, `packages/`, `panels/`, `workers/`, or `skills/` —
edit the files directly in your context with the `edit`/`write` tools (which
apply through `vcs.applyEdits`). Each edit commits to your context head and
projects to disk atomically — there is no separate commit step. These trees are
live build inputs.

For `apps/` bugs, read `skills/appdev/SKILL.md` before
editing. App fixes can require target-specific validation: Electron host chrome,
mobile native bootstrap and principal grants, or terminal process supervision.

### NatStack Application Source

If the bug is in the NatStack application itself, such as `src/server/`,
`src/main/`, or root `packages/*`, use a plain project checkout under
`projects/natstack`.

#### Dogfood Server Mode

When the operator launched NatStack with:

```bash
pnpm dev:self:server
```

the active workspace is a managed dogfood workspace. The launcher creates or
reuses `~/.config/natstack/workspaces/dogfood/source/projects/natstack` and
writes `meta/dogfood.json`.

In this mode, `projects/natstack` is still a plain project, not a Build V2
runtime unit, but it is a **self-edit target**:

- Host-checkout mirroring is unavailable under GAD VCS.
- Changes in `projects/natstack` prepare an external Git branch or patch; they
  do not hot-patch the running NatStack server.
- Verification requires restarting NatStack from that checkout, applying the
  patch in the host checkout, or handing the branch to a developer.

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

    return dir;
    scope.checkoutDir = dir;
  `,
})
```

**Important:** Work on a branch before making changes.

```typescript
const branchName = `fix/system-test-${failedTestName}`;
import { GitClient } from "@natstack/git";
import { credentials, fs } from "@workspace/runtime";
const externalGit = new GitClient(fs, { http: credentials.gitHttp() });
await externalGit.createBranch(scope.checkoutDir, branchName);
await externalGit.checkout(scope.checkoutDir, branchName);
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

## Phase 7: Publish, then Verify

**Critical:** The build system builds from the committed context head, which is in lockstep with your edits. Edits made via the `edit`/`write` tools (or `vcs.applyEdits`) commit to your context head and project to disk atomically — there is no separate commit step. A stray `fs.writeFile` that never lands on the head has no effect on the build.

```typescript
// For workspace runtime units, editing via edit/write/vcs.applyEdits already
// committed the change to your context head — no separate commit call needed.

// For plain external project repos, use @natstack/git with credentials.gitHttp():
// const externalGit = new GitClient(fs, { http: credentials.gitHttp() });
// await externalGit.addAll(scope.checkoutDir);
// await externalGit.commit(scope.checkoutDir, `fix: describe the change`);
// await externalGit.push(scope.checkoutDir, { remote: "origin", ref: branchName });

// Then rebuild if the fix touched workspace runtime units. Plain projects
// such as projects/natstack are not Build V2 live inputs.
if (!scope.checkoutDir.startsWith("projects/")) {
  const buildResult = await chat.rpc.call("main", "build.recompute", []);
  console.log("Build recomputed:", buildResult);
}

// If checkoutDir is projects/natstack, this is an external project edit. It
// does not hot-patch the running server under GAD VCS; restart from that
// checkout or hand off the branch/patch before re-testing server changes.

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
- the edit landed on the head via `edit`/`write`/`vcs.applyEdits` (not a stray `fs.writeFile`)
- the build/reload consumed the committed state
- external project edits under `projects/` were applied to the server under test

Planned hardening: expose a runtime build-provenance API with context id,
source path, state hash, dirty flag, build timestamp, and artifact id, then include
it automatically in system-test failure reports.

## Phase 8: Iterate or Finalize

```typescript
if (retest.result.passed) {
  console.log(`Fix verified on branch: ${branchName}`);
} else {
  console.log("Fix didn't work. Iterating...");
  // Go back to Phase 6 — edit, publish, rebuild, re-test
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

---
name: system-testing
description: Automated system testing via headless agentic sessions. Spawns test agents to exercise NatStack services, skills, and runtime, then validates results programmatically. Includes a self-improvement workflow for fixing discovered bugs.
---

# System Testing Skill

Spin up headless agentic sessions to systematically test every NatStack capability — filesystem, database, GAD workspace VCS, external Git interop, workers, panels, browser panels, build system, OAuth, skills, and more. Collect structured pass/fail results with full diagnostic data for every turn.

## Files

| Document                                   | Content                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| runner.ts                                  | `HeadlessRunner` — spawn headless sessions from eval with one line |
| test-runner.ts                             | `TestRunner` — orchestrate test suites, collect full diagnostics   |
| types.ts                                   | `TestCase`, `TestResult`, `TestSuiteResult`, `TestExecutionResult` |
| tests/                                     | 94 pre-built test cases across 19 categories                       |
| deterministic.ts                           | Bridge to `@workspace/testkit` deterministic suites (see below)    |
| [SELF_IMPROVEMENT.md](SELF_IMPROVEMENT.md) | Workflow for analyzing failures and committing fixes               |

## Deterministic tests (testkit)

The `deterministic` stage wraps the exact-assertion suites from
`@workspace/testkit` (see the **testkit** skill — panel lifecycle, viewport
fits, chat transcript, spectrolite, terminal). They run via
`deterministicTestCases()` inside the normal staged agentic workflow, or
directly without an agent session:

```
import { runDeterministic } from "@workspace-skills/system-testing/deterministic";
const { suiteResult } = await runDeterministic();
```

Layering: testkit = deterministic layer (exact assertions, CDP automation,
profiling); system-testing = agentic layer (LLM-driven sessions judged by
validators). Prefer testkit when expected behavior is exactly specifiable.

## Quick Start

```
eval({
  code: `
    import { HeadlessRunner } from "@workspace-skills/system-testing/runner";
    import { TestRunner } from "@workspace-skills/system-testing/test-runner";
    import { smokeTests } from "@workspace-skills/system-testing/stages";

    // Spawned test agents inherit YOUR model — read it from your own state.
    const runner = new HeadlessRunner(ctx.contextId, {
      model: (await agent.describe()).config.model,
    });
    const tester = new TestRunner(runner, {
      onTestStart: (t) => console.log("Running: " + t.name + "..."),
      onTestEnd: (t, r) => console.log((r.passed ? "PASS" : "FAIL") + ": " + t.name),
    });
    const results = await tester.runSuite(smokeTests);
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

Workspace packages like `@workspace-skills/system-testing/stages` are auto-resolved - the build system builds them on first import. No `imports` parameter needed.

When a test requires workspace development or panel API docs, read the
canonical skill path from the workspace root, for example
`skills/workspace-dev/PANEL_API.md`. Do not use bare root paths like
`workspace-dev/PANEL_API.md`. The Files table above is relative to this skill
directory; when using read/grep tools, use workspace-root paths such as
`skills/system-testing/tests/oauth.ts`, not `system-testing/tests/oauth.ts`.

## Full Suite

Start by presenting the user with a feedback UI so they can choose which stages
to run. A stage is a category-sized group by default, so stages can contain more
than three tests. Keep one eval call per stage, run as much concurrency inside
that stage as is feasible, publish a concise user-visible report after each
stage, then continue to the next selected stage.

First initialize stage progress. Store the full stage/run scaffold in `scope`;
return only the compact control data needed to render the feedback form. Do not
return `scope.systemTestingRun`, the full stage list, or test result arrays from
eval calls.

> `rpc`, `services`, `fs`, `ctx`, `scope`, `scopes`, `db`, `help`, and (in agent
> eval) `chat` are **pre-injected ambient globals** in eval — use them directly.
> Do **not** `import` any of them from `@workspace/runtime`. The context id is
> `ctx.contextId`; reach services through `services.<svc>.<method>(...)` or
> `rpc.call("<svc>.<method>", [...])`. Run the block below as written.

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

Then show a feedback form before running any tests. Populate `options` from the
`stageOptions` returned by the initialization eval and `default` from
`defaultStages`. Do not hard-code stage names or counts; they must come from the
current system-testing skill exports. Default to all stages if the user does not
narrow the selection. In the example below, substitute
`stageOptionsFromInitialization` and `defaultStagesFromInitialization` with the
actual arrays returned by the initialization eval.

```
feedback_form({
  title: "Choose System Test Stages",
  fields: [
    {
      key: "stages",
      label: "Stages to run",
      type: "multiSelect",
      options: stageOptionsFromInitialization,
      default: defaultStagesFromInitialization,
      allowFreeText: false,
      required: true,
      description: "The agent will run only the selected stages, reporting after each stage.",
    },
  ],
  submitLabel: "Run selected stages",
  cancelLabel: "Cancel",
})
```

If the user cancels, stop and report that no tests were run. If they submit,
store the selected stage indexes in `scope` and return only a compact selection
summary:

```
eval({
  code: `
    const selected = [
      // Fill from feedback result value.stages, e.g. "0", "3", "7".
    ];
    const run = scope.systemTestingRun;
    if (!run || typeof run !== "object") {
      throw new Error("No active systemTestingRun. Run the initialization eval first.");
    }
    const allIndexes = Array.isArray(run.stages) ? run.stages.map((stage) => stage.index) : [];
    const selectedIndexes = selected
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && allIndexes.includes(value));
    run.selectedStageIndexes = selectedIndexes.length ? selectedIndexes : allIndexes;
    scope.systemTestingRun = run;
    const selectedStages = run.stages.filter((stage) => run.selectedStageIndexes.includes(stage.index));
    return {
      runId: run.runId,
      selectedStageCount: selectedStages.length,
      selectedTestCount: selectedStages.reduce((total, stage) => total + stage.tests.length, 0),
    };
  `,
})
```

Then run the next selected stage with this eval. This eval must be invoked once
per stage and must not contain a `for`, `while`, or recursive loop over stages.
After it returns, publish/report the stage findings in the normal assistant
turn. If `remainingStages` is greater than `0`, continue by issuing this same
eval again as a new tool call.

Run this short orchestration snippet directly in eval. File-loaded eval remains
preferred for substantive multi-line or multi-file code, but helper files should
not be used merely to wrap this stage loop. If an operation fails, report the
error you actually observed, verbatim, with the operation that produced it.

```
eval({
  code: `
    import { HeadlessRunner } from "@workspace-skills/system-testing/runner";
    import { TestRunner } from "@workspace-skills/system-testing/test-runner";
    import { allTests, nextSelectedStage } from "@workspace-skills/system-testing/stages";
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

    // Spawned test agents inherit YOUR model — read it from your own state.
    const runner = new HeadlessRunner(ctx.contextId, {
      model: (await agent.describe()).config.model,
    });
    const tester = new TestRunner(runner, {
      onTestStart: (t) => console.log("Running: " + t.name + "..."),
      onTestEnd: (t, r) => console.log((r.passed ? "PASS" : "FAIL") + ": " + t.name),
      onTestResult: (_entry, aggregate) => {
        console.log("Stage progress: " + stage.name + " " + aggregate.total + "/" + stage.tests.length);
      },
      testTimeoutMs: 20 * 60 * 1000,
    });

    // Cap concurrency: each test is a full headless agent + channel, and the
    // workers stage adds workerd/DO lifecycle pressure inside each test.
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
      category: stage.category,
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

    return {
      runId: run.runId,
      stage: stage.name,
      stagePosition,
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

## Stage report cards (post one after every stage)

The stage eval no longer posts a prose message. Instead, after each stage eval
returns, post a **stage report card** — a custom message that renders this
stage's full per-test table and per-failure diagnostics, with your prose summary
on top. Run this as a separate eval (the prose must be written by you, not the
deterministic stage eval):

```
eval({
  code: `
    import { reportStage } from "@workspace-skills/system-testing/report";
    await reportStage(chat, scope, {
      prose: "<2-4 sentences: what passed, what failed, any non-fatal tool failures observed, and the most likely cause or investigation needed>",
    });
    return { reported: scope.systemTestingRun.lastStageSummary.name };
  `,
})
```

`reportStage` defaults to the most-recently completed stage
(`scope.systemTestingRun.lastStageSummary`) and bounds the card to that stage's
own tests (so a category split across stages still yields one card per stage).
Pass `{ stageIndex }` to report a specific earlier stage. The card embeds bounded
diagnostics from `summarizeFailures`, so it persists across reload/replay without
depending on live `scope`. Do not skip a stage's card; the cards are the primary
per-stage deliverable.

Tool failures are not the same as task failures. A test can pass after a
subagent hits a tool error and recovers, but the stage report must still mention
the affected test and tool so the top-level agent can investigate and surface
the issue. Full raw messages and snapshots remain in `scope.results.results`;
the report card is only a bounded presentation layer and is not the complete
diagnostic record.

## Inspecting Results

Full test state lives in `scope.results.results`, with compact per-stage
summaries in `scope.systemTestingRun.stageSummaries`. Eval return values are
only progress/control packets; do not use them as the diagnostic record.

Every test result includes full diagnostics. **After running a suite, always
inspect failures in detail from `scope.results.results` and include the evidence
in your answer. Never report only filenames, artifact names, or "files to
inspect"; those are pointers, not diagnosis.**

For a bounded structured packet that is safe to paste into a handoff report:

```typescript
import { summarizeFailures } from "@workspace-skills/system-testing/diagnostics";

return summarizeFailures(scope.results, {
  failures: 12,
  messages: 12,
  invocations: 20,
  debugEvents: 20,
  text: 900,
});
```

Each summary includes the prompt, validation reason, session error, final agent
message, bounded conversation transcript, invocation statuses and errors, debug
events, cleanup errors, participant state, non-fatal tool failures, and a coarse
likely issue. `summarizeFailures()` includes failed tests and passed tests with
tool failures. Use that packet to explain the mismatch or recovered tool error.
If the packet is insufficient, query the specific session further; do not
substitute a list of files.

### Summary

```typescript
for (const r of scope.results.results) {
  const icon = r.result.passed ? "PASS" : "FAIL";
  console.log(`${icon}: ${r.test.name} (${r.execution.duration}ms)`);
  if (!r.result.passed) console.log(`  Reason: ${r.result.reason}`);
}
```

### Full conversation log

Every turn the test agent took is captured — messages, tool calls, thinking, errors:

```typescript
const fail = scope.results.results.find((r) => !r.result.passed);
for (const m of fail.execution.messages) {
  const who = m.senderId === fail.execution.messages[0]?.senderId ? "USER" : "AGENT";
  const type = m.contentType ?? m.kind ?? "text";
  console.log(`[${who}] (${type}) ${m.content?.slice(0, 500)}`);
  if (m.error) console.log(`  ERROR: ${m.error}`);
}
```

### Invocation cards (every tool call + result)

See exactly what the test agent tried — eval calls, their code, return values, errors, timing:

```typescript
if (fail.execution.snapshot) {
  for (const inv of fail.execution.snapshot.invocations) {
    console.log(`  [${inv.status}] ${inv.name}`);
    if (inv.error) console.log(`    Error: ${inv.error}`);
  }
}
```

### Debug events (harness lifecycle)

See if the agent's harness spawned, crashed, stalled, or had warnings:

```typescript
if (fail.execution.snapshot) {
  for (const ev of fail.execution.snapshot.debugEvents) {
    console.log(`  [debug] ${JSON.stringify(ev).slice(0, 200)}`);
  }
}
```

### Cleanup diagnostics

Each headless test closes its session after capturing messages. Cleanup
failures are surfaced instead of swallowed:

```typescript
if (fail.execution.cleanupErrors?.length) {
  console.log("Cleanup errors:");
  for (const err of fail.execution.cleanupErrors) console.log(`  ${err}`);
}
if (fail.execution.snapshot?.cleanupErrors.length) {
  console.log(JSON.stringify(fail.execution.snapshot.cleanupErrors, null, 2));
}
```

Treat cleanup errors as infrastructure failures. They can indicate that the
headless agent was not unsubscribed/retired cleanly, which may otherwise show
up later as recovery or stale-turn artifacts.

### Automatic runtime diagnostics

When a test errors, `execution.diagnostics` is attached automatically. It
contains build provenance for `@workspace-skills/system-testing` and, when a
headless channel was created, a bounded `gad.inspectAgentHealth(...)` report.

```typescript
if (fail.execution.diagnostics) {
  console.log(JSON.stringify(fail.execution.diagnostics, null, 2).slice(0, 4000));
}
```

### Orchestrator failures before tests start

If `tester.runSuite(...)` throws before `scope.results` is set, capture bounded
runtime diagnostics from the orchestrating channel instead of retrying blindly:

```typescript
// In eval, `rpc` is injected (do not import it). `gad`/`build` are reached as
// services: rpc.call("<svc>.<method>", [args]) or services.<svc>.<method>(...).
const channelId = "chat-...";
const branchId = `branch:channel:${channelId}`;

return {
  health: await rpc.call("gad.inspectAgentHealth", [{ channelId, branchId }]),
  build: await rpc.call("build.inspectBuildProvenance", [
    "@workspace-skills/system-testing",
  ]),
};
```

You can also call `await runner.collectDiagnostics({ channelId, error })` to
produce the same bounded packet explicitly.

System-testing runs from a panel and uses that panel's stable `panel.slotId` as
its channel/client identity. Do not key orchestrator channel state on
`rpc.selfId`;
that is the current runtime entity and may change when the panel is recreated.

### Background build failures

Some build failures happen after a successful VCS commit, on the server's
state-triggered background build path. Those failures are not returned by the
commit call itself. Query the build service before retrying or guessing:

```typescript
// `rpc` is injected in eval — do not import it. The eval `rpc.call(method, args)`
// targets the server, so pass just "<svc>.<method>" (no "main" target argument).
return {
  recent: await rpc.call("build.listRecentBuildEvents", []),
  forUnit: await rpc.call("build.listRecentBuildEvents", ["panels/example"]),
  panel: await rpc.call("build.inspectBuildProvenance", ["panels/example"]),
};
```

`build.listRecentBuildEvents` accepts an optional unit name or workspace path,
for example `["panels/example"]`. Events include `build-error` messages and, for
state-triggered builds, a `trigger` with head, state hash, changed paths, and the
verified caller that caused the edit when the server can attribute it. An edit
applied via `vcs.applyEdits(...)` returns the resulting `stateHash` and
`changedPaths`; pass the unit path here for the matching build-event lookup.

### Agent debug port

If a test shows an open turn but no assistant message, tool call, or
`turn.closed` event, inspect the agent debug port before changing prompts or
adding waits:

```typescript
const debug = await chat.callMethod(agentParticipantId, "getDebugState", {});
console.log(JSON.stringify(debug, null, 2).slice(0, 4000));
```

The default AI agent exposes `getDebugState` as a read-only participant method.
It reports dispatcher state, runner phase, persisted pending work, channel
checkpoints, and recent lifecycle events. See
`docs/agent-debug-port.md` for the full response shape and interpretation
guide.

For eval/tool projection mismatches, call the joined suspension diagnostic:

```typescript
const suspensions = await chat.callMethod(agentParticipantId, "inspectMethodSuspensions", {});
console.log(JSON.stringify(suspensions, null, 2).slice(0, 4000));
```

### Participants (who was in the channel)

Check if the agent actually joined, and whether it disconnected:

```typescript
if (fail.execution.snapshot) {
  for (const [id, p] of Object.entries(fail.execution.snapshot.participants)) {
    console.log(`  ${p.name} (${p.type}): ${p.connected ? "connected" : "DISCONNECTED"}`);
  }
}
```

## Available Test Suites

| Suite                     | Tests | What it covers                                                                                                                         |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `smokeTests`              | 4     | Basic sanity: eval, fs, package import, file tools                                                                                     |
| `filesystemTests`         | 9     | All fs operations: read/write, dirs, stats, symlinks, handles                                                                          |
| `vcsTests`                | 6     | GAD workspace status, commit, log, state diff, exact apply-edits, publish status                                                       |
| `panelTests`              | 5     | Open, browser panel create+navigate, screenshot, evaluate, list sources                                                                |
| `workerTests`             | 6     | Create, list, unified RPC DO calls, destroy, env bindings, list sources                                                                |
| `buildTests`              | 4     | Workspace + npm builds, build at GAD state ref, eval imports                                                                           |
| `oauthTests`              | 3     | List providers/connections, error on missing connection                                                                                |
| `workspaceTests`          | 3     | List, active, config                                                                                                                   |
| `notificationTests`       | 2     | Show + dismiss                                                                                                                         |
| `skillTests`              | 4     | Load sandbox, workspace-dev, api-integrations, headless-sessions                                                                       |
| `agentCapabilityTests`    | 6     | Multi-turn, error recovery, large output, dynamic import                                                                               |
| `rpcTests`                | 2     | Cross-service calls                                                                                                                    |
| `edgeCaseTests`           | 3     | Invalid eval args, invalid imports, missing files                                                                                      |
| `agenticRuntimeTests`     | 8     | State args, runtime VCS client, GAD conventions, bounded inspection, test-runner extension, no-stall tool turns                        |
| `interactionSurfaceTests` | 4     | MDX ActionButton, inline UI, action bar, custom messages                                                                               |
| `projectLifecycleTests`   | 4     | Create, fork, commit, open, and inspect real workspace units                                                                           |
| `cdpGadDiagnosticTests`   | 5     | CDP UI mutation, lightweight console/DOM inspection, historical console diagnostics, panel state args, GAD integrity/state diagnostics |
| `harnessResilienceTests`  | 5     | Eval errors, huge returns, visible timeouts, invalid args, post-tool follow-ups                                                        |
| `docsProbeTests`          | 10    | Scenario probes that require agents to apply relevant skills, not summarize docs                                                       |

Use `allTests()` to get all 94 tests combined. For full-suite execution, prefer
the staged-progress pattern above: initialize `testStages(allTests())`, build
feedback choices with `testStageChoices(stages)`, run one selected stage per
eval with a bounded concurrency cap (`1` for `workers`, at most `2` elsewhere),
publish the stage report, then continue until `remainingStages` is `0`. Because
the choices come from `allTests()` and `testStages()`, the feedback form follows
the current test skill exports automatically.

## Expanded Regression Coverage

The suite intentionally includes tests for failure modes that are easy to miss
with ordinary smoke testing:

- state args must update the caller panel immediately from the returned host
  snapshot, while host-published events still update non-callers
- browser-panel workspace edits must go through `edit`/`write`/`vcs.applyEdits`
  (edit-first — they commit + project atomically, no separate commit step);
  external Git remotes use `@natstack/git` with `credentials.gitHttp()`
- GAD raw SQL uses positional `(sql, bindings)` calls
- channel/history inspection must stay bounded enough for agent context
- large eval/tool results must complete visibly without pending invocation
  spinners or silent turns
- the standard agent participant debug method should be discoverable
- rich interaction surfaces must exercise MDX, `inline_ui`,
  `load_action_bar`, and custom messages without hand-writing raw channel rows
- project lifecycle flows must create real projects (scaffolding applies files
  as one `vcs.applyEdits` transition — no separate commit step), fork
  panel and worker sources, open the result, and inspect snapshots/state
- CDP/Playwright automation must be able to mutate browser UI, type/click,
  evaluate DOM state, and take screenshots through runtime panel handles
- panel tests require explicit final fields such as `handle=<panel-id>`,
  `url=<current-url>`, and `bytes=<byte-count>`; do not rely on prose that only
  mentions a panel ID, URL, or byte count indirectly
- historical console diagnostics must expose host-captured general logs and a
  separate error buffer through `handle.cdp.consoleHistory()`
- unit diagnostics must expose persisted worker/DO/extension logs and separate
  error buffers through `workspace.units.diagnostics(name)`
- GAD diagnostic APIs must provide bounded summaries for storage,
  publication, turn, invocation, hash, branch, and file/state probes
- harness failures must surface visibly for thrown evals, huge eval returns,
  timeout-style errors, invalid tool arguments, and post-tool follow-up turns

The `docsProbeTests` suite uses realistic user goals and asks agents to choose
the relevant skills themselves. These tests avoid doc recitation and instead
check concrete decisions, bounded evidence, and clear reports when documented
paths do not work.

For SQLite-backed userland storage, the canonical pattern is `this.sql` inside a Durable Object. See `workers/sample-do/index.ts` for the minimal example and `workers/sample-do/sampleDo.test.ts` for an end-to-end round-trip exercised via `createTestDO`.

## Filtering

```typescript
await tester.runSuite(allTests(), { category: "filesystem" });
await tester.runSuite(allTests(), { name: "fs-write-read" });
```

## How It Works

Each test case:

1. Spawns a fresh headless session (new channel + new AiChatWorker DO)
2. Appends the shared system-test agent prompt from `runner.ts`
3. Sends a short natural-language prompt telling the test agent what goal to accomplish
4. Waits for the agent to become idle (debounce-based turn completion)
5. Captures a full snapshot: messages, invocation diagnostics, debug events, cleanup diagnostics, participants
6. Validates programmatically and returns structured results
7. Closes the session

The test agent is a standard AiChatWorker with full eval + set_title tools and
full-auto approval. The shared system-test prompt tells it that it is testing
the harness, should choose relevant skills itself, should report setup/tool/API
mismatches clearly, should not hunt for unrelated workarounds, and should keep
evidence bounded. Individual test prompts should stay as vague as possible:
state the user-visible goal and required final marker, not the API mechanics,
object shapes, edge cases, or workaround steps the skill docs are supposed to
teach. If an agent fails because docs are missing or misleading, fix the docs or
runtime; do not narrow the test prompt to route around the failure.

## Auto-Start as Initial Panel

See `meta/natstack.yml` for the current testing agent configuration.

## Build Model

**Workspace runtime units are built from the committed context head, in lockstep with your edits.** When fixing bugs in workspace source files (`apps/`, `extensions/`, `packages/`, `panels/`, `workers/`, `skills/`), edit with the `edit`/`write` tools or `vcs.applyEdits` — each edit commits to your context head and projects to disk atomically, so it takes effect for builds immediately with no separate commit step. Do not edit via `fs.writeFile` and expect it to build: the worktree is a disposable projection and the build system reads committed GAD state, so the edit must land on the head.

When a loose system test asks for VCS status, logs, or diffs, use the documented
runtime API shape rather than guessing from filesystem terms:

- `vcs.status()` reports the current context head's unpublished changes vs `main` (a GAD state-diff, not filesystem dirtiness); its optional argument is a materialized VCS head such as `main` or `ctx:...`.
- `vcs.applyEdits({ baseStateHash, edits })` applies an edit to the context head (commits + projects atomically) and returns `stateHash` and `changedPaths`.
- `vcs.diff(leftStateHash, rightStateHash)` compares committed state hashes.
- `vcs.readFile("", "path")` reads from the current context/head.
- `vcs.publishStatus()` reports unpublished context changes without moving `main`.

Do not pass workspace roots, cwd values, or unit paths to `vcs.status` or
`vcs.diff`; those methods are not filesystem-root based.

GAD VCS implementation files live under `src/server/services/vcsService.ts`,
`src/server/gadVcs/`, and the runtime client
`workspace/packages/runtime/src/shared/vcsClient.ts`. Do not look for
`packages/runtime/src/server/vcs/vcs.ts`; that path is not part of this
workspace layout.

For trusted app failures under `apps/`, read `skills/appdev/SKILL.md` before
changing shell, mobile, or terminal app source. App bugs often involve approval
identity, capabilities, native bootstrap, or target-specific build artifacts.

For NatStack application source (`src/server/`, `src/main/`, root
`packages/*`), use a plain checkout under `projects/natstack`. In normal mode
that prepares a branch/patch but does not hot-patch the running server. In
dogfood server mode (`pnpm dev:self:server`), the workspace contains
`meta/dogfood.json`, but host-checkout mirroring is unavailable under GAD VCS.
Treat `projects/natstack` as an external Git project used to
prepare a branch or patch; it does not hot-patch the running server. See
[SELF_IMPROVEMENT.md](SELF_IMPROVEMENT.md) for the full workflow and the
userland detection snippet.

## Environment Compatibility

This skill requires a panel context (it uses the panel's `rpc` and stable `panel.slotId` for the PubSub connection and channel identity). It cannot run headlessly itself — it's the testing _orchestrator_ that spawns headless test sessions.

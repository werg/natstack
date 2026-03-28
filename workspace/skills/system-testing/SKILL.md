---
name: system-testing
description: Automated system testing via headless agentic sessions. Spawns test agents to exercise NatStack services, skills, and runtime, then validates results programmatically. Includes a self-improvement workflow for fixing discovered bugs.
---

# System Testing Skill

Spin up headless agentic sessions to systematically test every NatStack capability — filesystem, database, git, workers, panels, browser panels, build system, OAuth, AI, skills, and more. Collect structured pass/fail results with full diagnostic data for every turn.

## Files

| Document | Content |
|----------|---------|
| runner.ts | `HeadlessRunner` — spawn headless sessions from eval with one line |
| test-runner.ts | `TestRunner` — orchestrate test suites, collect full diagnostics |
| types.ts | `TestCase`, `TestResult`, `TestSuiteResult`, `TestExecutionResult` |
| tests/ | 71 pre-built test cases across 15 categories |
| [SELF_IMPROVEMENT.md](SELF_IMPROVEMENT.md) | Workflow for analyzing failures and pushing fixes |

## Quick Start

```
eval({
  code: `
    import { HeadlessRunner, TestRunner, smokeTests } from "@workspace-skills/system-testing";
    import { contextId } from "@workspace/runtime";

    const runner = new HeadlessRunner(contextId);
    const tester = new TestRunner(runner, {
      onTestStart: (t) => console.log("Running: " + t.name + "..."),
      onTestEnd: (t, r) => console.log((r.passed ? "PASS" : "FAIL") + ": " + t.name),
    });
    const results = await tester.runSuite(smokeTests);
    scope.results = results;
    return { total: results.total, passed: results.passed, failed: results.failed };
  `,
  imports: { "@workspace-skills/system-testing": "latest" },
})
```

## Inspecting Results

Every test result includes full diagnostics. **After running a suite, always inspect failures in detail:**

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
const fail = scope.results.results.find(r => !r.result.passed);
for (const m of fail.execution.messages) {
  const who = m.senderId === fail.execution.messages[0]?.senderId ? "USER" : "AGENT";
  const type = m.contentType ?? m.kind ?? "text";
  console.log(`[${who}] (${type}) ${m.content?.slice(0, 500)}`);
  if (m.error) console.log(`  ERROR: ${m.error}`);
}
```

### Method history (every tool call + result)

See exactly what the test agent tried — eval calls, their code, return values, errors, timing:

```typescript
if (fail.execution.snapshot) {
  for (const mh of fail.execution.snapshot.methodHistory) {
    const dur = mh.duration ? `${mh.duration}ms` : "pending";
    console.log(`  [${mh.status}] ${mh.method} (${dur})`);
    if (mh.error) console.log(`    Error: ${mh.error}`);
  }
}
```

### Debug events (harness lifecycle)

See if the agent's harness spawned, crashed, timed out, or had warnings:

```typescript
if (fail.execution.snapshot) {
  for (const ev of fail.execution.snapshot.debugEvents) {
    console.log(`  [debug] ${JSON.stringify(ev).slice(0, 200)}`);
  }
}
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

| Suite | Tests | What it covers |
|-------|-------|---------------|
| `smokeTests` | 5 | Basic sanity: eval, scope, fs, db, package import |
| `filesystemTests` | 9 | All fs operations: read/write, dirs, stats, symlinks, handles |
| `databaseTests` | 6 | SQLite: CRUD, params, multiple DBs, migration, persistence |
| `gitTests` | 6 | init, branch, diff, log, stash, push |
| `panelTests` | 6 | Open, browser panels, navigate, screenshot, evaluate, list sources |
| `workerTests` | 6 | Create, list, callDO, destroy, env bindings, list sources |
| `buildTests` | 4 | Workspace + npm builds, build at ref, eval imports |
| `oauthTests` | 3 | List providers/connections, error on missing connection |
| `aiTests` | 4 | Generate, stream, tool use, list models |
| `workspaceTests` | 3 | List, active, config |
| `notificationTests` | 2 | Show + dismiss |
| `skillTests` | 4 | Load sandbox, paneldev, api-integrations, headless-sessions |
| `agentCapabilityTests` | 6 | Multi-turn, error recovery, large output, dynamic import |
| `rpcTests` | 2 | Cross-service calls |
| `edgeCaseTests` | 5 | Timeouts, invalid imports, bad SQL, missing files |

Use `allTests()` to get all 71 tests combined.

## Filtering

```typescript
await tester.runSuite(allTests(), { category: "filesystem" });
await tester.runSuite(allTests(), { name: "fs-write-read" });
```

## How It Works

Each test case:
1. Spawns a fresh headless session (new channel + new AiChatWorker DO)
2. Sends a natural-language prompt telling the test agent what to do
3. Waits for the agent to become idle (debounce-based turn completion)
4. Captures a full snapshot: messages, method history, debug events, participants
5. Validates programmatically and returns structured results
6. Closes the session

The test agent is a standard AiChatWorker with full eval + set_title tools and full-auto approval. It has no knowledge of being tested — it just receives a task and does its best.

## Auto-Start as Initial Panel

Add to `natstack.yml` to run tests when a workspace starts:

```yaml
initPanels:
  - source: panels/chat
  - source: panels/chat
    stateArgs:
      initialPrompt: |
        Load the system-testing skill. Run the smoke test suite first. For every failure,
        inspect the full execution: conversation log, method history (every tool call the
        agent made and its result), debug events, and participant state. Identify whether
        the root cause is in the infrastructure (services, RPC methods, error handling) or
        the test. Fix infrastructure bugs first — read SELF_IMPROVEMENT.md for the workflow.
      systemPrompt: |
        You are a NatStack system testing and self-improvement agent. Your workflow:
        1. Import the system-testing skill via eval with imports parameter
        2. Run test suites using HeadlessRunner and TestRunner
        3. For every failure, thoroughly inspect the TestExecutionResult:
           - The full conversation (every message the test agent sent/received)
           - The method history (every eval/tool call, its arguments, return value, errors)
           - The debug events (harness lifecycle: spawn, start, stop, crash)
           - The participant state (did the agent join? did it disconnect?)
        4. Classify root cause: infrastructure bug vs documentation bug vs test bug
        5. Fix infrastructure first — never work around broken APIs in prompts
        6. Read SELF_IMPROVEMENT.md for the detailed fix workflow
      systemPromptMode: append
```

## Environment Compatibility

This skill requires a panel context (for PubSub connection via `rpc` and `db`). It cannot run headlessly itself — it's the testing *orchestrator* that spawns headless test sessions.

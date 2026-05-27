---
name: system-testing
description: Automated system testing via headless agentic sessions. Spawns test agents to exercise NatStack services, skills, and runtime, then validates results programmatically. Includes a self-improvement workflow for fixing discovered bugs.
---

# System Testing Skill

Spin up headless agentic sessions to systematically test every NatStack capability — filesystem, database, git, workers, panels, browser panels, build system, OAuth, skills, and more. Collect structured pass/fail results with full diagnostic data for every turn.

## Files

| Document | Content |
|----------|---------|
| runner.ts | `HeadlessRunner` — spawn headless sessions from eval with one line |
| test-runner.ts | `TestRunner` — orchestrate test suites, collect full diagnostics |
| types.ts | `TestCase`, `TestResult`, `TestSuiteResult`, `TestExecutionResult` |
| tests/ | 66 pre-built test cases across 14 categories |
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

Workspace packages like `@workspace-skills/system-testing` are auto-resolved — the build system builds them on first import. No `imports` parameter needed.

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
| `smokeTests` | 4 | Basic sanity: eval, fs, package import, file tools |
| `filesystemTests` | 9 | All fs operations: read/write, dirs, stats, symlinks, handles |
| `gitTests` | 6 | init, branch, diff, log, stash, push |
| `panelTests` | 6 | Open, browser panels, navigate, screenshot, evaluate, list sources |
| `workerTests` | 6 | Create, list, unified RPC DO calls, destroy, env bindings, list sources |
| `buildTests` | 4 | Workspace + npm builds, build at ref, eval imports |
| `oauthTests` | 3 | List providers/connections, error on missing connection |
| `workspaceTests` | 3 | List, active, config |
| `notificationTests` | 2 | Show + dismiss |
| `skillTests` | 4 | Load sandbox, paneldev, api-integrations, headless-sessions |
| `agentCapabilityTests` | 6 | Multi-turn, error recovery, large output, dynamic import |
| `rpcTests` | 2 | Cross-service calls |
| `edgeCaseTests` | 3 | Invalid eval args, invalid imports, missing files |

Use `allTests()` to get all 57 tests combined.

For SQLite-backed userland storage, the canonical pattern is `this.sql` inside a Durable Object. See `workspace/workers/sample-do/index.ts` for the minimal example and `workspace/workers/sample-do/sampleDo.test.ts` for an end-to-end round-trip exercised via `createTestDO`.

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
4. Captures a full snapshot: messages, invocation diagnostics, debug events, cleanup diagnostics, participants
5. Validates programmatically and returns structured results
6. Closes the session

The test agent is a standard AiChatWorker with full eval + set_title tools and full-auto approval. It has no knowledge of being tested — it just receives a task and does its best.

## Auto-Start as Initial Panel

See `meta/natstack.yml` for the current testing agent configuration.

## Build Model

**Workspace runtime units are built from git, not from the working tree.** When fixing bugs in workspace source files (`apps/`, `extensions/`, `packages/`, `panels/`, `workers/`, `skills/`), you must **commit and push** changes before they take effect. Editing a file alone does nothing — the build system extracts source from git commits.

For trusted app failures under `apps/`, read `skills/appdev/SKILL.md` before
changing shell, mobile, or terminal app source. App bugs often involve approval
identity, capabilities, native bootstrap, or target-specific build artifacts.

For NatStack application source (`src/server/`, `src/main/`, root
`packages/*`), use a plain checkout under `projects/natstack`. In normal mode
that prepares a branch/patch but does not hot-patch the running server. In
dogfood server mode (`pnpm dev:self:server`), the workspace contains
`meta/dogfood.json`; pushes from `projects/natstack` mirror back to the
launching checkout. Server-runtime changes rebuild/restart the standalone
server; docs, desktop shell, mobile app, and workspace runtime-unit changes may
mirror without a server restart. See [SELF_IMPROVEMENT.md](SELF_IMPROVEMENT.md)
for the full workflow and the userland detection snippet.

## Environment Compatibility

This skill requires a panel context (for PubSub connection via `rpc` and `db`). It cannot run headlessly itself — it's the testing *orchestrator* that spawns headless test sessions.

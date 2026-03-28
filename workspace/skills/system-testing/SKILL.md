---
name: system-testing
description: Automated system testing via headless agentic sessions. Spawns test agents to exercise NatStack services, skills, and runtime, then validates results programmatically. Includes a self-improvement workflow for fixing discovered bugs.
---

# System Testing Skill

Spin up headless agentic sessions to systematically test every NatStack capability — filesystem, database, git, workers, panels, browser panels, build system, OAuth, AI, skills, and more. Collect structured pass/fail results with full conversation logs for diagnosis.

## Files

| Document | Content |
|----------|---------|
| runner.ts | `HeadlessRunner` — spawn headless sessions from eval with one line |
| test-runner.ts | `TestRunner` — orchestrate test suites, collect structured results |
| types.ts | `TestCase`, `TestResult`, `TestSuiteResult` interfaces |
| tests/ | 71 pre-built test cases across 15 categories |
| [SELF_IMPROVEMENT.md](SELF_IMPROVEMENT.md) | Workflow for analyzing failures and pushing fixes |

## Quick Start

```typescript
import { HeadlessRunner, TestRunner, smokeTests } from "@workspace-skills/system-testing";

const runner = new HeadlessRunner(contextId);
const tester = new TestRunner(runner);
const results = await tester.runSuite(smokeTests);

console.log(`${results.passed}/${results.total} passed`);
for (const r of results.results.filter(r => !r.result.passed)) {
  console.log(`FAIL: ${r.test.name} — ${r.result.reason}`);
}
```

## Available Test Suites

| Suite | Tests | What it covers |
|-------|-------|---------------|
| `smokeTests` | 5 | Basic sanity: eval, scope, fs, db, skill import |
| `filesystemTests` | 9 | All fs operations: read/write, dirs, stats, symlinks, handles |
| `databaseTests` | 6 | SQLite: CRUD, params, multiple DBs, migration, persistence |
| `gitTests` | 6 | init, branch, diff, log, stash, push |
| `panelTests` | 6 | Open, state args, close, browser panels, navigate, screenshot |
| `workerTests` | 6 | Create, list, callDO, destroy, env bindings, list sources |
| `buildTests` | 4 | Workspace + npm builds, build at ref, eval imports |
| `oauthTests` | 3 | List providers/connections, error on missing connection |
| `aiTests` | 4 | Generate, stream, tool use, abort |
| `workspaceTests` | 3 | List, active, config |
| `notificationTests` | 2 | Show + dismiss |
| `skillTests` | 4 | Load sandbox, paneldev, api-integrations, headless-sessions |
| `agentCapabilityTests` | 6 | Multi-turn, error recovery, large output, dynamic import |
| `rpcTests` | 2 | Expose method, events |
| `edgeCaseTests` | 5 | Timeouts, invalid imports, bad SQL, missing files |

Use `allTests()` to get all 71 tests combined.

## Filtering

```typescript
// Run only filesystem tests
await tester.runSuite(allTests(), { category: "filesystem" });

// Run a specific test by name
await tester.runSuite(allTests(), { name: "fs-write-read" });
```

## Callbacks

```typescript
const tester = new TestRunner(runner, {
  onTestStart: (test) => console.log(`Running: ${test.name}...`),
  onTestEnd: (test, result) => console.log(`  ${result.passed ? "PASS" : "FAIL"}: ${test.name}`),
});
```

## How It Works

Each test case:
1. Spawns a fresh headless session (new channel + new AiChatWorker DO)
2. Sends a natural-language prompt telling the test agent what to do
3. Waits for the agent to complete its turn (debounce-based idle detection)
4. Validates the conversation log programmatically
5. Closes the session (cleanup)

The test agent is a standard AiChatWorker with full eval + set_title tools and full-auto approval. It has no knowledge of being tested — it just receives a task and does its best.

## Auto-Start as Initial Panel

Add to `natstack.yml` to run tests when a workspace starts:

```yaml
initPanels:
  - source: panels/chat
  - source: panels/chat
    stateArgs:
      initialPrompt: |
        Load the system-testing skill and run the full smoke test suite.
        Report results and analyze any failures.
      systemPrompt: |
        You are a NatStack system testing agent. Load the system-testing
        skill via eval imports and run test suites against the runtime.
        For failures, inspect conversation logs, identify root causes,
        and fix bugs following the SELF_IMPROVEMENT.md workflow.
      systemPromptMode: append
```

Or programmatically:
```typescript
import { workspace } from "@workspace/runtime";
await workspace.setInitPanels([
  { source: "panels/chat" },
  { source: "panels/chat", stateArgs: { initialPrompt: "...", systemPrompt: "..." } },
]);
```

## Environment Compatibility

This skill requires a panel context (for PubSub connection via `rpc` and `db`). It cannot run headlessly itself — it's the testing *orchestrator* that spawns headless test sessions.

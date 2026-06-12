---
name: testkit
description: Deterministic in-system E2E testing, orchestration, supervision and profiling for userland code (packages, panels, workers, DOs) via @workspace/testkit. Use for running/writing deterministic tests from eval, watching panels/workers for errors, capturing CPU profiles and heap snapshots of panels or workerd, and driving the Testbench panel. For agentic (LLM-driven) system tests, use the system-testing skill instead — testkit is the deterministic layer underneath it.
---

# Testkit Skill

`@workspace/testkit` is the deterministic in-system testing SDK: a vitest-free
test runner that works inside eval and panels, panel automation over
`panelTree`/CDP, worker/DO orchestration and inspection, supervision
(console/crash/health watching), and profiling for both panels (Chromium CDP)
and workerd isolates (V8 inspector).

**Layering:** testkit = deterministic layer (this skill). system-testing =
agentic layer (spawns headless agent sessions) — it can run testkit suites via
its `deterministic` stage. Reach for testkit when the expected behavior is
exactly specifiable; reach for system-testing when judging behavior needs a
model.

## Eval conventions

- `scope`, `scopes`, `chat` are ambient globals in eval — do not import them.
- Store full run results in `scope` (`scope.testkitRun` by convention) and
  **return only `summarize(result)`** — full results and profile artifacts are
  too large for eval returns.
- Profile artifacts are written to context fs under `/.testkit/profiles/`
  (standard V8 `.cpuprofile` / `.heapsnapshot` — open in speedscope or Chrome
  DevTools). Saved runs live under `/.testkit/runs/`.

## Quick start — run the built-in suites

```
eval({
  code: `
    import { runSuites, summarize } from "@workspace/testkit";
    import { allSuites } from "@workspace/testkit/suites";
    const result = await runSuites(allSuites(), {
      onTestEnd: (r) => console.log(\`\${r.status}: \${r.suite} > \${r.name}\`),
    });
    scope.testkitRun = result;
    return summarize(result);
  `,
})
```

Built-in suites (ports of the former outside Playwright E2E tests):
`panel-lifecycle`, `panel-viewport`, `chat-transcript`, `spectrolite`,
`terminal`. Filter with `runSuites(suites, { filter: { suite: "spectrolite" } })`.

## Writing ad-hoc tests in eval

```
eval({
  code: `
    import { suite, runSuites, summarize, expect, openPanel, waitForText, panelText } from "@workspace/testkit";
    const s = suite("my-feature")
      .test("panel renders the greeting", async (t) => {
        const h = await openPanel("panels/my-app");   // auto-watched by t.supervisor
        t.defer(() => h.close());                      // LIFO cleanup, always runs
        await waitForText(h, "Hello");
        expect(await panelText(h), "greeting").toContain("Hello");
      });
    const result = await runSuites(s);
    scope.testkitRun = result;
    return summarize(result);
  `,
})
```

Key facts:
- `suite(name, { timeoutMs?, failOnSupervision? })`; default test timeout 30s.
- Tests fail automatically if supervision sees console errors or crashes in
  panels the test opened (`failOnSupervision: false` or
  `t.supervisor.unwatchPanel(id)` to opt out — see the spectrolite broken-MDX
  test for the pattern).
- Assertions throw serializable errors: `expect(x, "label").toEqual(...)`,
  `.toContain`, `.toMatch`, `.not.*`, etc.
- Suites are instance-scoped — re-running an eval block never double-registers.

## Panel automation

- `openPanel(source, { stateArgs?, waitLoaded? })` / `withPanel(source, fn)` (auto-close)
- `panelText(h)` / `waitForText(h, text)` — approval-free agentApi snapshot path
- `evalInPanel(h, expression)` — Runtime.evaluate by value (CDP)
- `setViewport(h, { width, height, mobile })` / `audit(h)` — overflow + console health
- `rawCdpSession(h)` — any CDP method
- **Workspace panels** are automated via the `testkit-driver` DO
  (workers/testkit-driver, service `natstack.testkit-driver.v1`) because panel
  callers may only CDP-drive *browser* panels. This is transparent — the first
  use may raise a panel-access approval prompt. Browser panels connect direct.
- Never automate the panel your eval runs in (testkit guards against this).

## Workers and DOs

```
import { listUnits, unitDiagnostics, callDO, ensureWorker, restartUnit } from "@workspace/testkit";
await ensureWorker("workers/my-worker");          // create-if-missing + wait running
await callDO("natstack.my-store.v1", "method", [args]);
await unitDiagnostics("my-worker", { sinceSeq: 0 });  // exact-resume log cursor
```

## Supervision

```
import { supervise } from "@workspace/testkit";
const sup = supervise([panelHandle, "my-worker"]);   // panels and/or unit names
// ... exercise the system ...
const report = await sup.collect();                  // findings since watch start
await sup.assertClean({ allow: [/known noise/] });   // throws with evidence
sup.stop();
```

Inside tests, `t.supervisor` does this automatically for opened panels.
`sup.healthProbe(name, fn, { intervalMs })` adds interval probes.

## Profiling

Panels (Chromium, via the CDP bridge):

```
import { profilePanel, heapSnapshot, listProfiles } from "@workspace/testkit";
const ref = await profilePanel(handle, async () => { /* workload */ });
// ref = { path, kind, target, durationMs, summary: { totalSamples, topFunctions } }
const heap = await heapSnapshot(handle);  // streamed to fs, never inlined
```

Workerd (V8 inspector, approval-gated via the `workerdInspector` service):

```
import { listWorkerdTargets, profileWorkerd, profileDO } from "@workspace/testkit";
const targets = await listWorkerdTargets();   // what workerd actually exposes
const ref = await profileWorkerd("worker-host", async () => { /* workload */ });
const doRef = await profileDO("natstack.gad.workspace.v1", async () => { /* DO calls */ });
```

Caveats:
- First `getEndpoint` per caller raises a one-time `workerd.inspector`
  approval. The inspector is always on (loopback-bound; disable with
  `NATSTACK_DISABLE_WORKERD_INSPECTOR=1`).
- Regular workers share the `worker-host` isolate-loader service — a profile
  of that target may include sibling workers. Per-source DO services are
  precise. Use `listWorkerdTargets()` to see real granularity.
- `.cpuprofile` files load directly in speedscope / Chrome DevTools
  Performance; the Testbench panel renders an inline flamegraph.

## Testbench panel

`openPanel("panels/testbench")` — UI for browsing/running suites with live
per-test status, run history (`/.testkit/runs/`), and a profile viewer with
flamegraphs. It also exposes RPC for agents:

```
const tb = await openPanel("panels/testbench");
const summary = await tb.call.runSuites({ suite: "panel-lifecycle" });
const last = await tb.call.lastRun();
```

## Approvals to expect

| Prompt | When | Scope |
| --- | --- | --- |
| Panel access (CDP/automate) | first driver-DO automation of a workspace panel | per target/requester, grantable |
| `workerd.inspector` | first workerd profiling per caller | per caller, grantable |
| Panel open (structural) | first `openPanel` from a new entity | standard panelTree flow |

Pre-grant by running one small eval and approving the prompts before kicking
off long suites.

## Files

| File | Content |
| --- | --- |
| examples.ts | Copy-paste eval snippets for every flow above |
| @workspace/testkit (workspace/packages/testkit) | The SDK itself |
| workspace/workers/testkit-driver | Driver DO for workspace-panel CDP |
| workspace/panels/testbench | Test runner / profile viewer panel |

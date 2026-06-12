/**
 * Bridge to the deterministic testkit layer (@workspace/testkit).
 *
 * Two ways in:
 *  - runDeterministic(): run testkit suites directly (no agent session) and
 *    get a system-testing-shaped TestSuiteResult — fast, exact, cheap.
 *  - deterministicTestCases(): wrap each testkit suite as an agentic TestCase
 *    whose prompt has the test agent run the suite via eval and report the
 *    summary packet; validate() checks the structured counts. Use this when
 *    the deterministic suites should run inside the standard staged agentic
 *    workflow.
 */
import { runSuites, summarize, type SuiteRunResult } from "@workspace/testkit";
import { allSuites } from "@workspace/testkit/suites";
import type { Suite } from "@workspace/testkit";
import type { TestCase, TestSuiteResult } from "./types.js";

export const DETERMINISTIC_CATEGORY = "deterministic";

/** Run testkit suites in-process and adapt to the system-testing result shape. */
export async function runDeterministic(
  suites: Suite[] = allSuites(),
  opts?: { filter?: { suite?: string; test?: string } }
): Promise<{ suiteResult: TestSuiteResult; raw: SuiteRunResult }> {
  const raw = await runSuites(suites, { filter: opts?.filter });
  const suiteResult: TestSuiteResult = {
    total: raw.total,
    passed: raw.passed,
    failed: raw.failed,
    errored: raw.errored,
    skipped: raw.skipped,
    duration: raw.duration,
    results: raw.results.map((entry) => ({
      test: {
        name: `${entry.suite} > ${entry.name}`,
        category: DETERMINISTIC_CATEGORY,
        description: `testkit deterministic test (${entry.suite})`,
        prompt: "(run in-process via @workspace/testkit — no agent prompt)",
      },
      result: {
        passed: entry.status === "passed",
        reason: entry.error?.message,
        details: entry.supervision ? { supervision: entry.supervision } : undefined,
      },
      execution: { messages: [], duration: entry.durationMs },
    })),
  };
  return { suiteResult, raw };
}

/** Wrap each testkit suite as one agentic TestCase for the staged workflow. */
export function deterministicTestCases(suites: Suite[] = allSuites()): TestCase[] {
  return suites.map((suite) => ({
    name: `testkit:${suite.name}`,
    description: `Run the deterministic testkit suite "${suite.name}" (${suite.tests.length} tests) and report the summary`,
    category: DETERMINISTIC_CATEGORY,
    prompt: [
      `Run the deterministic testkit suite "${suite.name}" with one eval call:`,
      "```",
      'import { runSuites, summarize } from "@workspace/testkit";',
      'import { allSuites } from "@workspace/testkit/suites";',
      `const suites = allSuites().filter((s) => s.name === ${JSON.stringify(suite.name)});`,
      "const result = await runSuites(suites);",
      "scope.testkitRun = result;",
      "return summarize(result);",
      "```",
      "Then reply with exactly the JSON the eval returned (the summary object) in a fenced code block.",
    ].join("\n"),
    validate: (result) => {
      const text = result.messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
      const match = text.match(/\{[\s\S]*"total"[\s\S]*\}/);
      if (!match) {
        return { passed: false, reason: "no testkit summary JSON found in agent reply" };
      }
      try {
        const summary = JSON.parse(match[0]) as ReturnType<typeof summarize>;
        const clean = summary.failed === 0 && summary.errored === 0 && summary.total > 0;
        return {
          passed: clean,
          reason: clean
            ? undefined
            : `${summary.failed} failed / ${summary.errored} errored of ${summary.total}`,
          details: { summary },
        };
      } catch {
        return { passed: false, reason: "testkit summary JSON did not parse" };
      }
    },
  }));
}

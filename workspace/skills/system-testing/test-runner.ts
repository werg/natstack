import type { TestCase, TestSuiteResult, TestExecutionResult, TestResult } from "./types.js";
import type { HeadlessRunner } from "./runner.js";
import type { ChatMessage } from "@workspace/agentic-core";

export class TestRunner {
  constructor(
    private runner: HeadlessRunner,
    private opts?: { onTestStart?: (test: TestCase) => void; onTestEnd?: (test: TestCase, result: TestResult) => void }
  ) {}

  async runSuite(tests: TestCase[], filter?: { category?: string; name?: string }): Promise<TestSuiteResult> {
    const filtered = tests.filter(t => {
      if (filter?.category && t.category !== filter.category) return false;
      if (filter?.name && !t.name.includes(filter.name)) return false;
      return true;
    });

    const startTime = Date.now();
    const results: TestSuiteResult["results"] = [];
    let passed = 0, failed = 0, errored = 0;

    for (const test of filtered) {
      this.opts?.onTestStart?.(test);
      const { result, execution } = await this.runOne(test);
      results.push({
        test: { name: test.name, category: test.category, description: test.description },
        result,
        execution,
      });
      if (execution.error) errored++;
      else if (result.passed) passed++;
      else failed++;
      this.opts?.onTestEnd?.(test, result);
    }

    return {
      total: filtered.length,
      passed,
      failed,
      errored,
      skipped: tests.length - filtered.length,
      duration: Date.now() - startTime,
      results,
    };
  }

  async runOne(test: TestCase): Promise<{ result: TestResult; execution: TestExecutionResult }> {
    const startTime = Date.now();
    let session;
    try {
      session = await this.runner.spawn({
        systemPrompt: test.systemPrompt,
      });

      const timeout = test.timeout ?? 60_000;
      await session.sendAndWait(test.prompt, { timeout });

      const messages = [...session.messages] as ChatMessage[];
      const duration = Date.now() - startTime;
      const execution: TestExecutionResult = { messages, duration };
      const result = test.validate(execution);
      return { result, execution };
    } catch (err) {
      const duration = Date.now() - startTime;
      const messages = session ? ([...session.messages] as ChatMessage[]) : [];
      const execution: TestExecutionResult = {
        messages,
        duration,
        error: err instanceof Error ? err.message : String(err),
      };
      return {
        result: { passed: false, reason: `Error: ${execution.error}` },
        execution,
      };
    } finally {
      try { await session?.close(); } catch { /* best-effort cleanup */ }
    }
  }
}

import type { TestCase, TestSuiteResult, TestExecutionResult, TestResult, TestSuiteResultEntry } from "./types.js";
import type { HeadlessRunner } from "./runner.js";
import type { ChatMessage } from "@workspace/agentic-core";
import type { SessionSnapshot } from "@workspace/agentic-session";

type MaybePromise<T> = T | Promise<T>;
type RunSuiteFilter = { category?: string; name?: string; concurrency?: number };
const DEFAULT_PARALLEL_CONCURRENCY = 24;

export class TestRunner {
  constructor(
    private runner: HeadlessRunner,
    private opts?: {
      onTestStart?: (test: TestCase) => void;
      onTestEnd?: (test: TestCase, result: TestResult, execution: TestExecutionResult) => void;
      onTestResult?: (entry: TestSuiteResultEntry, aggregate: TestSuiteResult) => MaybePromise<void>;
      concurrency?: number;
      testTimeoutMs?: number;
    }
  ) {
    if (!runner) {
      throw new Error("TestRunner requires a HeadlessRunner instance. Usage: new TestRunner(new HeadlessRunner(contextId))");
    }
  }

  /** Alias for runSuite */
  run = this.runSuite.bind(this);
  /** Alias for runSuite */
  runTests = this.runSuite.bind(this);
  /** Alias for runSuite with an explicit concurrency cap */
  runSuiteParallel = (tests: TestCase[], opts?: RunSuiteFilter): Promise<TestSuiteResult> => {
    return this.runSuite(tests, {
      ...opts,
      concurrency: opts?.concurrency ?? this.opts?.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY,
    });
  };

  async runSuite(tests: TestCase[], filter?: RunSuiteFilter): Promise<TestSuiteResult> {
    const filtered = tests.filter(t => {
      if (filter?.category && t.category !== filter.category) return false;
      if (filter?.name && !t.name.includes(filter.name)) return false;
      return true;
    });

    const startTime = Date.now();
    const results: Array<TestSuiteResultEntry | undefined> = new Array(filtered.length);
    const concurrency = this.normalizeConcurrency(filter?.concurrency ?? this.opts?.concurrency ?? 1, filtered.length);
    let nextIndex = 0;

    const runAt = async (index: number): Promise<void> => {
      const test = filtered[index]!;
      this.opts?.onTestStart?.(test);
      const { result, execution } = await this.runOne(test);
      const entry: TestSuiteResultEntry = {
        test: { name: test.name, category: test.category, description: test.description, prompt: test.prompt },
        result,
        execution,
      };
      results[index] = entry;
      this.opts?.onTestEnd?.(test, result, execution);
      if (this.opts?.onTestResult) {
        await this.opts.onTestResult(entry, this.buildSuiteResult(tests.length, filtered.length, results, startTime));
      }
    };

    const worker = async (): Promise<void> => {
      while (nextIndex < filtered.length) {
        const index = nextIndex++;
        await runAt(index);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return this.buildSuiteResult(tests.length, filtered.length, results, startTime);
  }

  private buildSuiteResult(
    sourceTotal: number,
    filteredTotal: number,
    entries: Array<TestSuiteResultEntry | undefined>,
    startTime: number,
  ): TestSuiteResult {
    const results = entries.filter((entry): entry is TestSuiteResultEntry => Boolean(entry));
    let passed = 0, failed = 0, errored = 0;
    for (const entry of results) {
      if (entry.execution.error) errored++;
      else if (entry.result.passed) passed++;
      else failed++;
    }
    return {
      total: results.length,
      passed,
      failed,
      errored,
      skipped: sourceTotal - filteredTotal,
      duration: Date.now() - startTime,
      results,
    };
  }

  private normalizeConcurrency(value: number, total: number): number {
    if (total <= 0) return 1;
    if (!Number.isFinite(value) || value < 1) return 1;
    return Math.min(total, Math.max(1, Math.floor(value)));
  }

  async runOne(test: TestCase): Promise<{ result: TestResult; execution: TestExecutionResult }> {
    const startTime = Date.now();
    let session;
    let outcome: { result: TestResult; execution: TestExecutionResult } | undefined;
    try {
      session = await this.runner.spawn();

      await this.withTimeout(
        session.sendAndWait(test.prompt),
        this.opts?.testTimeoutMs ?? 120_000,
        `Timed out waiting for agent to finish test "${test.name}"`,
      );

      const messages = [...session.messages] as ChatMessage[];
      const snapshot = session.snapshot();
      const duration = Date.now() - startTime;
      const execution: TestExecutionResult = { messages, duration, snapshot };
      const result = test.validate(execution);
      outcome = { result, execution };
    } catch (err) {
      const duration = Date.now() - startTime;
      const messages = session ? ([...session.messages] as ChatMessage[]) : [];
      let snapshot: SessionSnapshot | undefined;
      try {
        snapshot = session?.snapshot();
      } catch (snapshotErr) {
        console.warn("[system-testing] Failed to snapshot failed headless session:", snapshotErr);
      }
      const execution: TestExecutionResult = {
        messages,
        duration,
        error: err instanceof Error ? err.message : String(err),
        snapshot,
      };
      execution.diagnostics = await this.runner.collectDiagnostics({
        channelId: session?.channelId,
        error: err,
      });
      outcome = {
        result: { passed: false, reason: `Error: ${execution.error}` },
        execution,
      };
    } finally {
      try {
        await session?.close();
      } catch (cleanupErr) {
        const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        console.warn("[system-testing] Failed to close headless session:", cleanupErr);
        if (outcome) {
          outcome.execution.cleanupErrors = [
            ...(outcome.execution.cleanupErrors ?? []),
            `close: ${message}`,
          ];
        }
      }
      let cleanupErrors: NonNullable<SessionSnapshot["cleanupErrors"]> = [];
      try {
        cleanupErrors = session?.snapshot().cleanupErrors ?? [];
      } catch (snapshotErr) {
        console.warn("[system-testing] Failed to snapshot headless cleanup diagnostics:", snapshotErr);
      }
      if (cleanupErrors.length > 0 && outcome) {
        const messages = cleanupErrors.map((error) => `${error.phase}: ${error.message}`);
        outcome.execution.cleanupErrors = [
          ...(outcome.execution.cleanupErrors ?? []),
          ...messages,
        ];
        outcome.execution.error ??= `Headless cleanup failed: ${messages.join("; ")}`;
        outcome.execution.snapshot = session?.snapshot();
        if (outcome.result.passed) {
          outcome.result = {
            passed: false,
            reason: `Headless cleanup failed: ${messages.join("; ")}`,
            details: { cleanupErrors: messages },
          };
        } else {
          outcome.result = {
            ...outcome.result,
            details: {
              ...(outcome.result.details ?? {}),
              cleanupErrors: messages,
            },
          };
        }
      }
    }
    if (!outcome) {
      throw new Error("Test runner finished without producing a result");
    }
    return outcome;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

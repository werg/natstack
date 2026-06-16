import type {
  TestCase,
  TestSuiteResult,
  TestExecutionResult,
  TestResult,
  TestSuiteResultEntry,
  ToolFailureSummary,
} from "./types.js";
import type { HeadlessRunner } from "./runner.js";
import type { ChatMessage } from "@workspace/agentic-core";
import type { SessionSnapshot } from "@workspace/agentic-session";

type MaybePromise<T> = T | Promise<T>;
type RunSuiteFilter = { category?: string; name?: string; concurrency?: number };
const DEFAULT_PARALLEL_CONCURRENCY = 4;

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
    let toolFailureCount = 0, testsWithToolFailures = 0;
    for (const entry of results) {
      if (entry.execution.error) errored++;
      else if (entry.result.passed) passed++;
      else failed++;
      const entryToolFailures = entry.execution.toolFailures?.length ?? 0;
      toolFailureCount += entryToolFailures;
      if (entryToolFailures > 0) testsWithToolFailures++;
    }
    return {
      total: results.length,
      passed,
      failed,
      errored,
      toolFailureCount,
      testsWithToolFailures,
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
      execution.toolFailures = collectToolFailures(execution);
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
      const errorMessage = formatExecutionError(err, messages, snapshot);
      const execution: TestExecutionResult = {
        messages,
        duration,
        error: errorMessage,
        snapshot,
      };
      execution.toolFailures = collectToolFailures(execution);
      try {
        execution.diagnostics = await this.runner.collectDiagnostics({
          channelId: session?.channelId,
          error: new Error(errorMessage),
        });
      } catch (diagnosticErr) {
        execution.diagnostics = {
          generatedAt: new Date().toISOString(),
          diagnosticCollectionError:
            diagnosticErr instanceof Error ? diagnosticErr.message : String(diagnosticErr),
        };
      }
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

function formatExecutionError(
  err: unknown,
  messages: readonly ChatMessage[],
  snapshot?: SessionSnapshot
): string {
  const base = err instanceof Error ? err.message : String(err);
  if (!/^Timed out waiting for agent to finish test/.test(base)) return base;
  const details = timeoutDiagnosticDetails(messages, snapshot);
  return details.length > 0 ? `${base}. ${details.join(" ")}` : base;
}

function timeoutDiagnosticDetails(
  messages: readonly ChatMessage[],
  snapshot?: SessionSnapshot
): string[] {
  const details: string[] = [];
  const pendingInvocations = (snapshot?.invocations ?? []).filter(
    (invocation) => !isSettledInvocationStatus(invocation.status)
  );
  if (pendingInvocations.length > 0) {
    details.push(
      `Pending invocations: ${pendingInvocations
        .slice(0, 5)
        .map((invocation) => `${invocation.name}:${invocation.status || "unknown"}`)
        .join(", ")}${pendingInvocations.length > 5 ? ` (+${pendingInvocations.length - 5} more)` : ""}.`
    );
  }
  const lastLifecycle = [...messages].reverse().find((message) => message.lifecycle);
  if (lastLifecycle?.lifecycle) {
    const reason = lastLifecycle.lifecycle.reason ? ` reason=${lastLifecycle.lifecycle.reason}` : "";
    details.push(`Last lifecycle: ${lastLifecycle.lifecycle.status}${reason} "${lastLifecycle.lifecycle.title}".`);
  }
  const lastDiagnostic = [...messages].reverse().find((message) => message.diagnostic || message.error);
  if (lastDiagnostic) {
    const code = lastDiagnostic.diagnostic?.code ? ` code=${lastDiagnostic.diagnostic.code}` : "";
    const title = lastDiagnostic.diagnostic?.title ?? lastDiagnostic.error ?? lastDiagnostic.content;
    details.push(`Last diagnostic:${code} "${String(title).slice(0, 200)}".`);
  }
  return details;
}

function isSettledInvocationStatus(status: string): boolean {
  return ["complete", "completed", "error", "failed", "cancelled", "abandoned"].includes(status);
}

interface InvocationLike {
  id?: unknown;
  name?: unknown;
  method?: unknown;
  status?: unknown;
  terminalOutcome?: unknown;
  terminalReasonCode?: unknown;
  error?: unknown;
  result?: unknown;
  execution?: {
    status?: unknown;
    terminalOutcome?: unknown;
    terminalReasonCode?: unknown;
    description?: unknown;
    error?: unknown;
    result?: unknown;
    isError?: unknown;
  };
}

function collectToolFailures(execution: TestExecutionResult): ToolFailureSummary[] {
  const failures: ToolFailureSummary[] = [];
  const seen = new Set<string>();

  const add = (summary: ToolFailureSummary) => {
    const key = summary.id
      ? `id:${summary.id}`
      : [summary.name, summary.status, summary.error, summary.resultSummary, summary.source].join("\0");
    if (seen.has(key)) return;
    seen.add(key);
    failures.push(summary);
  };

  for (const message of execution.messages) {
    if (message.contentType !== "invocation") continue;
    const payload = ((message as { invocation?: unknown }).invocation ?? parseJson(message.content)) as
      | InvocationLike
      | undefined;
    const summary = summarizeToolFailure(payload, "message", (message as { error?: unknown }).error);
    if (summary) add(summary);
  }

  for (const invocation of execution.snapshot?.invocations ?? []) {
    const summary = summarizeToolFailure(invocation as InvocationLike, "snapshot");
    if (summary) add(summary);
  }

  return failures;
}

function summarizeToolFailure(
  invocation: InvocationLike | undefined,
  source: ToolFailureSummary["source"],
  messageError?: unknown
): ToolFailureSummary | null {
  if (!invocation || typeof invocation !== "object") return null;
  const exec = isRecord(invocation.execution) ? invocation.execution : {};
  const status = asString(exec.status) ?? asString(invocation.status);
  const terminalOutcome = asString(exec.terminalOutcome) ?? asString(invocation.terminalOutcome);
  const terminalReasonCode =
    asString(exec.terminalReasonCode) ?? asString(invocation.terminalReasonCode);
  const isError = exec.isError === true;
  const hasFailureStatus = status === "error" || status === "failed";
  const hasFailureOutcome = /error|fail/i.test(terminalOutcome ?? "");
  const rawError =
    invocation.error ??
    exec.error ??
    messageError ??
    (isError ? exec.result ?? exec.description : undefined);

  if (!isError && !hasFailureStatus && !hasFailureOutcome && rawError === undefined) return null;

  const rawResult = invocation.result ?? exec.result;
  const name = asString(invocation.name) ?? asString(invocation.method) ?? "(unknown)";
  return {
    id: asString(invocation.id),
    name,
    status,
    terminalOutcome,
    terminalReasonCode,
    error: summarizeError(rawError),
    resultSummary: rawResult === undefined ? undefined : summarizeValue(rawResult, 240),
    source,
  };
}

function summarizeError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (isRecord(value) && typeof value["error"] === "string") return clip(value["error"], 240);
  if (value instanceof Error) return clip(value.message, 240);
  return summarizeValue(value, 240);
}

function summarizeValue(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : safeJson(value);
  return clip(text, limit);
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

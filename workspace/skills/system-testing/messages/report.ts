/**
 * Stage report card — publish a `system-testing.stage-report` custom message
 * after each test category completes.
 *
 * Runtime-safe: this module must NOT value-import `stage-report.tsx` (that would
 * pull React/Radix into the skill runtime). It shares only the type-only
 * `StageReportState` via `import type`.
 */

import type { ChatSandboxValue } from "@workspace/agentic-core";
import { summarizeEntry } from "../diagnostics.js";
import type { TestSuiteResult, TestSuiteResultEntry } from "../types.js";
import type {
  StageReportCounts,
  StageReportState,
  StageTestRow,
  StageTestStatus,
} from "./report-types.js";

// Bounds for the per-test diagnostic embedded in every row. Kept modest so the
// persisted card state stays reasonable even for larger stages.
const PER_TEST_LIMITS = { messages: 10, invocations: 16, debugEvents: 12, text: 500 } as const;

export type { StageReportState } from "./report-types.js";

export const STAGE_REPORT_TYPE = "system-testing.stage-report";

// Workspace-root-relative (the panel fs root is the context's workspace root —
// no "workspace/" prefix, same convention as action-bar files).
const STAGE_REPORT_PATH = "skills/system-testing/messages/stage-report.tsx";

/** Radix is resolved through the sandbox import system, not the skill's runtime deps. */
const STAGE_REPORT_IMPORTS: Record<string, string> = {
  "@radix-ui/themes": "npm:^3.2.1",
  "@radix-ui/react-icons": "npm:^1.3.2",
};

/**
 * A stage as stored on the run state. The init eval compacts `tests` to an
 * array of name strings, but tolerate full `{ name }` objects too.
 */
interface RunStage {
  index: number;
  name: string;
  category: string;
  tests: Array<string | { name: string }>;
}

function stageTestName(test: string | { name: string }): string {
  return typeof test === "string" ? test : test.name;
}

interface RunStageSummary {
  index: number;
  name: string;
  category?: string;
}

/** Minimal shape we read off `scope.systemTestingRun`. */
interface SystemTestingRun {
  runId: string;
  results?: TestSuiteResult;
  stages?: RunStage[];
  lastStageSummary?: RunStageSummary;
}

/** Title-case a machine category, e.g. "filesystem" -> "Filesystem". */
function titleForCategory(category: string): string {
  if (!category) return "Stage";
  return category
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusFor(entry: TestSuiteResultEntry): StageTestStatus {
  if (entry.execution.error) return "errored";
  return entry.result.passed ? "passed" : "failed";
}

function reasonFor(entry: TestSuiteResultEntry): string | undefined {
  if (entry.execution.error) return entry.execution.error;
  if (!entry.result.passed) return entry.result.reason;
  return undefined;
}

/**
 * Register (or refresh) the stage-report renderer. Idempotent per run: when a
 * `scope` + `runId` are supplied it registers at most once per run (avoiding
 * recompile churn) while still picking up a republished renderer on the next
 * run. Pass no scope/runId to force a registration.
 */
export async function ensureStageReportType(
  chat: ChatSandboxValue,
  scope?: Record<string, unknown>,
  runId?: string,
): Promise<void> {
  const marker = "__stageReportRegisteredRunId";
  if (scope && runId && scope[marker] === runId) return;
  await chat.registerMessageType({
    typeId: STAGE_REPORT_TYPE,
    displayMode: "row",
    source: { type: "file", path: STAGE_REPORT_PATH },
    imports: STAGE_REPORT_IMPORTS,
  });
  if (scope && runId) scope[marker] = runId;
}

/**
 * Build the stage-report state for a single completed stage from the aggregate
 * run on `scope.systemTestingRun`, register the renderer if needed, and publish
 * the card. Returns the published message id.
 *
 * Defaults to the most-recently completed stage (`run.lastStageSummary`). Pass
 * `stageIndex` to report a specific stage. The stage's own test set (not its
 * category) bounds the report, so a category split across multiple stages still
 * yields one card per stage.
 */
export async function reportStage(
  chat: ChatSandboxValue,
  scope: Record<string, unknown>,
  args: { prose: string; stageIndex?: number; generatedAt?: string },
): Promise<{ messageId: string }> {
  const { prose } = args;
  const run = scope?.["systemTestingRun"] as SystemTestingRun | undefined;
  if (!run || typeof run !== "object") {
    throw new Error("reportStage: no scope.systemTestingRun — run the init eval first.");
  }
  const aggregate = run.results;
  if (!aggregate || !Array.isArray(aggregate.results)) {
    throw new Error("reportStage: scope.systemTestingRun.results is missing or malformed.");
  }

  const stageIndex = args.stageIndex ?? run.lastStageSummary?.index;
  if (stageIndex === undefined) {
    throw new Error("reportStage: no completed stage to report (missing lastStageSummary).");
  }
  const stage = run.stages?.find((s) => s.index === stageIndex);
  const category = stage?.category ?? run.lastStageSummary?.category ?? "";
  const title = stage?.name ?? category ?? `Stage ${stageIndex}`;

  // Bound to this stage's own tests (categories may span multiple stages).
  const stageTestNames = stage ? new Set(stage.tests.map(stageTestName)) : null;
  const entries = aggregate.results.filter((entry) =>
    stageTestNames ? stageTestNames.has(entry.test.name) : entry.test.category === category,
  );
  if (entries.length === 0) {
    throw new Error(`reportStage: no test results found for stage "${title}".`);
  }

  const tests: StageTestRow[] = entries.map((entry) => ({
    name: entry.test.name,
    description: entry.test.description,
    status: statusFor(entry),
    passed: entry.result.passed,
    durationMs: entry.execution.duration ?? 0,
    reason: reasonFor(entry),
    toolFailures: entry.execution.toolFailures,
    toolFailureCount: entry.execution.toolFailures?.length ?? 0,
    detail: summarizeEntry(entry, PER_TEST_LIMITS),
  }));

  const counts: StageReportCounts = {
    total: tests.length,
    passed: tests.filter((t) => t.status === "passed").length,
    failed: tests.filter((t) => t.status === "failed").length,
    errored: tests.filter((t) => t.status === "errored").length,
    toolFailureCount: tests.reduce((sum, test) => sum + (test.toolFailureCount ?? 0), 0),
    testsWithToolFailures: tests.filter((test) => (test.toolFailureCount ?? 0) > 0).length,
    skipped: 0,
    durationMs: entries.reduce((sum, entry) => sum + (entry.execution.duration ?? 0), 0),
  };

  const state: StageReportState = {
    runId: run.runId,
    category,
    title: title || titleForCategory(category),
    prose: prose ?? "",
    counts,
    tests,
    generatedAt: args.generatedAt,
  };

  await ensureStageReportType(chat, scope, run.runId);
  const { messageId } = await chat.publishCustomMessage({
    typeId: STAGE_REPORT_TYPE,
    displayMode: "row",
    initialState: state,
  });

  return { messageId };
}

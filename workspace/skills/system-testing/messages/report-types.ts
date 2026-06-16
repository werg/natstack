/**
 * Shared state shape for the `system-testing.stage-report` custom message.
 *
 * Type-only: imported via `import type` by both the runtime helper (`report.ts`)
 * and the panel-sandbox renderer (`stage-report.tsx`). Keeping it free of value
 * exports ensures `report.ts` never drags React/Radix into the skill runtime.
 */

import type { FailureDiagnostic } from "../diagnostics.js";
import type { ToolFailureSummary } from "../types.js";

export type StageTestStatus = "passed" | "failed" | "errored";

export interface StageTestRow {
  name: string;
  description: string;
  status: StageTestStatus;
  passed: boolean;
  durationMs: number;
  /** Validation reason (failures) or session error summary, when present. */
  reason?: string;
  /** Non-fatal failed tool calls observed while running this test. */
  toolFailures?: ToolFailureSummary[];
  toolFailureCount?: number;
  /** Bounded per-test diagnostic (transcript, tool calls, etc.) for drill-down. */
  detail: FailureDiagnostic;
}

export interface StageReportCounts {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  toolFailureCount?: number;
  testsWithToolFailures?: number;
  skipped: number;
  durationMs: number;
}

export interface StageReportState {
  runId: string;
  /** Machine category, e.g. "filesystem". */
  category: string;
  /** Human title, e.g. "Filesystem". */
  title: string;
  /** Agent-written prose summary of the stage (plain text / light markdown). */
  prose: string;
  counts: StageReportCounts;
  /** One row per test (passing and failing), each carrying its drill-down detail. */
  tests: StageTestRow[];
  /** ISO timestamp stamped by the caller, if available. */
  generatedAt?: string;
}

export type { FailureDiagnostic };

import type { ChatMessage } from "@workspace/agentic-core";
import type { SessionSnapshot } from "@workspace/agentic-session";

export interface ToolFailureSummary {
  id?: string;
  name: string;
  status?: string;
  terminalOutcome?: string;
  terminalReasonCode?: string;
  error?: string;
  resultSummary?: string;
  source: "message" | "snapshot";
}

export interface TestCase {
  name: string;
  description: string;
  category: string;
  /** Natural language task prompt sent to the test agent */
  prompt: string;
  /** Validate the test execution result */
  validate: (result: TestExecutionResult) => TestResult;
}

export interface TestExecutionResult {
  /** Full conversation messages */
  messages: ChatMessage[];
  /** Wall-clock duration in ms */
  duration: number;
  /** Transport/session-level error (if the session itself failed) */
  error?: string;
  /** Cleanup errors from closing the headless session or retiring its agent */
  cleanupErrors?: string[];
  /** Full diagnostic snapshot from the session (invocations, debug events, participants) */
  snapshot?: SessionSnapshot;
  /** Runtime/GAD diagnostics collected automatically when a test errors. */
  diagnostics?: Record<string, unknown>;
  /** Non-fatal tool-call failures observed during the turn. */
  toolFailures?: ToolFailureSummary[];
}

export interface TestResult {
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface TestSuiteResultEntry {
  test: { name: string; category: string; description: string; prompt: string };
  result: TestResult;
  execution: TestExecutionResult;
}

export interface TestSuiteResult {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  /** Total failed tool calls observed, independent from pass/fail status. */
  toolFailureCount?: number;
  /** Number of tests that observed at least one failed tool call. */
  testsWithToolFailures?: number;
  skipped: number;
  duration: number;
  results: TestSuiteResultEntry[];
}

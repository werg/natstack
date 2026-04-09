import type { ChatMessage } from "@workspace/agentic-core";
import type { SessionSnapshot } from "@workspace/agentic-session";

export interface TestCase {
  name: string;
  description: string;
  category: string;
  /** Natural language task prompt sent to the test agent */
  prompt: string;
  /** Timeout in ms (default: no timeout — waits until agent disconnects or goes idle) */
  timeout?: number;
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
  /** Full diagnostic snapshot from the session (method history, debug events, participants) */
  snapshot?: SessionSnapshot;
}

export interface TestResult {
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface TestSuiteResult {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  duration: number;
  results: Array<{
    test: { name: string; category: string; description: string; prompt: string };
    result: TestResult;
    execution: TestExecutionResult;
  }>;
}

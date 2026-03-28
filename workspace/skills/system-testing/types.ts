import type { ChatMessage } from "@workspace/agentic-core";

export interface TestCase {
  name: string;
  description: string;
  category: string;
  /** Natural language task prompt sent to the test agent */
  prompt: string;
  /** Override the test agent's system prompt */
  systemPrompt?: string;
  /** Timeout in ms (default 60000) */
  timeout?: number;
  /** Validate the test execution result */
  validate: (result: TestExecutionResult) => TestResult;
}

export interface TestExecutionResult {
  messages: ChatMessage[];
  duration: number;
  error?: string;
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
    test: { name: string; category: string; description: string };
    result: TestResult;
    execution: TestExecutionResult;
  }>;
}

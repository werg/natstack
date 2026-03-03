/**
 * Test runner tools for pubsub RPC.
 *
 * Implements: run_tests
 * Delegates to the main process test runner service via RPC.
 */

import type { MethodDefinition } from "@workspace/agentic-messaging";
import {
  RunTestsArgsSchema,
  type RunTestsArgs,
} from "@workspace/agentic-messaging/tool-schemas";
import { rpc, contextId } from "@workspace/runtime";

interface TestResult {
  summary: string;
  passed: number;
  failed: number;
  total: number;
  details: Array<{
    file: string;
    status: "pass" | "fail" | "skip";
    duration?: number;
    errors?: string[];
  }>;
}

/**
 * run_tests - Run vitest tests via main process RPC
 */
export async function runTests(args: RunTestsArgs): Promise<string> {
  const result = await rpc.call<TestResult>(
    "main",
    "test.run",
    contextId,
    args.target,
    args.file,
    args.test_name,
  );

  const lines: string[] = [result.summary];

  for (const detail of result.details) {
    const icon = detail.status === "pass" ? "PASS" : detail.status === "fail" ? "FAIL" : "SKIP";
    const duration = detail.duration ? ` (${detail.duration}ms)` : "";
    lines.push(`  ${icon} ${detail.file}${duration}`);

    if (detail.errors) {
      for (const err of detail.errors) {
        lines.push(`    ${err}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Create method definitions for test tools.
 */
export function createTestToolMethodDefinitions(): Record<string, MethodDefinition> {
  return {
    run_tests: {
      description:
        "Run vitest tests on a workspace panel or package. " +
        "Returns pass/fail summary with error details. " +
        "Tests run in Node.js with panel runtime globals stubbed for panels.",
      parameters: RunTestsArgsSchema,
      execute: runTests,
    },
  };
}

/**
 * Test Runner Service — programmatic vitest execution for context folder code.
 *
 * Runs vitest from the main project root (which has node_modules) and uses
 * file-path filters to target context folder test files. This mirrors how
 * TypeCheckService works: files from context, resolution from main.
 */

import * as path from "path";
import * as fs from "fs";
import { resolveWithinContext } from "./contextPaths.js";
import type { ContextFolderManager } from "../contextFolderManager.js";

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

export interface TestRunnerOptions {
  contextFolderManager: ContextFolderManager;
  /** Directory with node_modules for vitest resolution (typically the NatStack project root) */
  workspaceRoot: string;
  /** Absolute path to testSetup.ts (panel globals stubs for vitest) */
  panelTestSetupPath: string;
}

export async function handleTestCall(
  options: TestRunnerOptions,
  method: string,
  args: unknown[],
): Promise<TestResult> {
  const { contextFolderManager, workspaceRoot, panelTestSetupPath } = options;
  if (method !== "run") {
    throw new Error(`Unknown test method: ${method}`);
  }

  const contextId = args[0] as string;
  const target = args[1] as string; // e.g. "panels/my-app"
  const fileFilter = args[2] as string | undefined;
  const testName = args[3] as string | undefined;

  const contextRoot = await contextFolderManager.ensureContextFolder(contextId);
  const targetPath = resolveWithinContext(contextRoot, target);

  // Validate target directory exists before invoking vitest
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target directory does not exist: ${target}`);
  }
  if (!fs.statSync(targetPath).isDirectory()) {
    throw new Error(`Target must be a directory: ${target}`);
  }

  const isPanel = target.startsWith("panels/");

  // Build file filter pattern
  let testPattern: string;
  if (fileFilter) {
    testPattern = resolveWithinContext(targetPath, fileFilter);
  } else {
    testPattern = path.join(targetPath, "**/*.test.{ts,tsx}");
  }

  // Safely compile test name filter
  let testNamePattern: string | undefined;
  if (testName) {
    testNamePattern = testName;
  }

  // Validate panel setup file exists before invoking vitest
  const setupFiles: string[] = [];
  if (isPanel) {
    if (!fs.existsSync(panelTestSetupPath)) {
      throw new Error(
        `Panel test setup file not found: ${panelTestSetupPath}. ` +
        "Ensure the NatStack source tree is available.",
      );
    }
    setupFiles.push(panelTestSetupPath);
  }

  // Dynamic import vitest to avoid bundling it when not needed
  const { startVitest } = await import("vitest/node");

  const vitest = await startVitest("run" as any, [testPattern], {
    root: workspaceRoot,
    // Override default exclude — root vitest.config.ts excludes workspace/.contexts
    exclude: ["**/node_modules/**", "dist"],
    setupFiles,
    testNamePattern,
    // Suppress console noise
    reporters: ["default"],
    silent: true,
  });

  if (!vitest) {
    return {
      summary: "Vitest failed to start",
      passed: 0,
      failed: 0,
      total: 0,
      details: [],
    };
  }

  const files = vitest.state.getFiles();

  let passed = 0;
  let failed = 0;
  const details: TestResult["details"] = [];

  for (const file of files) {
    const relativePath = path.relative(contextRoot, file.filepath);
    const fileErrors: string[] = [];

    const tasks = file.tasks ?? [];
    for (const task of tasks) {
      if (task.result?.state === "pass") passed++;
      else if (task.result?.state === "fail") {
        failed++;
        const err = task.result?.errors?.[0];
        if (err) {
          fileErrors.push(`${task.name}: ${err.message ?? String(err)}`);
        }
      }
    }

    const fileStatus: "pass" | "fail" | "skip" =
      file.result?.state === "fail" ? "fail"
      : file.result?.state === "pass" ? "pass"
      : "skip";

    details.push({
      file: relativePath,
      status: fileStatus,
      duration: file.result?.duration,
      errors: fileErrors.length > 0 ? fileErrors : undefined,
    });
  }

  const total = passed + failed;

  // Distinguish "no tests found" from "all tests passed" to surface bad paths/filters
  if (files.length === 0) {
    await vitest.close();
    return {
      summary: `No test files found matching: ${target}${fileFilter ? "/" + fileFilter : ""}`,
      passed: 0,
      failed: 0,
      total: 0,
      details: [],
    };
  }

  const summary = failed > 0
    ? `${failed} of ${total} test${total !== 1 ? "s" : ""} failed`
    : `${total} test${total !== 1 ? "s" : ""} passed`;

  await vitest.close();

  return { summary, passed, failed, total, details };
}

import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const edgeCaseTests: TestCase[] = [
  {
    name: "eval-timeout",
    description: "Handle eval timeout for long-running code",
    category: "edge-cases",
    prompt: "Run code that sleeps for 30 seconds with a 2-second timeout. Tell me how the timeout was handled.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasTimeout = lower.includes("timeout") || lower.includes("timed out") || lower.includes("exceeded") ||
        lower.includes("killed") || lower.includes("terminated") || lower.includes("limit") || lower.includes("error");
      return {
        passed: hasTimeout,
        reason: hasTimeout ? undefined : `Expected timeout handling description, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "invalid-import",
    description: "Graceful error for importing a nonexistent package",
    category: "edge-cases",
    prompt: "Try to import a package called 'nonexistent-package-xyz'. Tell me what error you got.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasError = lower.includes("error") || lower.includes("not found") || lower.includes("cannot find") ||
        lower.includes("failed") || lower.includes("resolve") || lower.includes("no such");
      return {
        passed: hasError,
        reason: hasError ? undefined : `Expected import error message, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "malformed-sql",
    description: "Graceful error for invalid SQL syntax",
    category: "edge-cases",
    prompt: "Open a database and run invalid SQL: 'SELET * FORM nowhere'. Tell me the error message.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasError = lower.includes("error") || lower.includes("syntax") || lower.includes("near") ||
        lower.includes("invalid") || lower.includes("parse") || lower.includes("selet");
      return {
        passed: hasError,
        reason: hasError ? undefined : `Expected SQL syntax error, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "fs-not-found",
    description: "Graceful error for reading a nonexistent file",
    category: "edge-cases",
    prompt: "Try to read a file that doesn't exist: /tmp/definitely-not-here-12345.txt. Tell me the error.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasError = lower.includes("enoent") || lower.includes("not found") || lower.includes("no such file") ||
        lower.includes("does not exist") || lower.includes("error") || lower.includes("not exist");
      return {
        passed: hasError,
        reason: hasError ? undefined : `Expected ENOENT or not-found error, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "double-close",
    description: "Closing a database twice does not crash",
    category: "edge-cases",
    prompt: "Open a database, close it, then try to close it again. Tell me what happens.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasResult = lower.includes("close") || lower.includes("error") || lower.includes("already") ||
        lower.includes("ignored") || lower.includes("no-op") || lower.includes("second") || lower.includes("twice");
      return {
        passed: hasResult,
        reason: hasResult ? undefined : `Expected double-close behavior description, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

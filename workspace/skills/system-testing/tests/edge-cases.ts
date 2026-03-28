import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const edgeCaseTests: TestCase[] = [
  {
    name: "eval-timeout",
    description: "Handle a timeout for long-running code",
    category: "edge-cases",
    prompt: "Run some code with a very short timeout so it times out. Tell me how the timeout was handled.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasTimeout = lower.includes("timeout") || lower.includes("timed out") || lower.includes("exceeded") ||
        lower.includes("limit") || lower.includes("error") || lower.includes("kill");
      return {
        passed: hasTimeout,
        reason: hasTimeout ? undefined : `Expected timeout handling, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "invalid-import",
    description: "Graceful error for importing something that doesn't exist",
    category: "edge-cases",
    prompt: "Try to import a package that doesn't exist. Tell me what error you got.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasError = lower.includes("error") || lower.includes("not found") || lower.includes("cannot find") ||
        lower.includes("failed") || lower.includes("resolve");
      return {
        passed: hasError,
        reason: hasError ? undefined : `Expected import error, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "malformed-sql",
    description: "Graceful error for invalid SQL syntax",
    category: "edge-cases",
    prompt: "Open a database and run some intentionally invalid SQL. Tell me the error.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasError = lower.includes("error") || lower.includes("syntax") || lower.includes("invalid") ||
        lower.includes("near") || lower.includes("parse");
      return {
        passed: hasError,
        reason: hasError ? undefined : `Expected SQL error, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "fs-not-found",
    description: "Graceful error for reading a nonexistent file",
    category: "edge-cases",
    prompt: "Try to read a file that doesn't exist. Tell me the error.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasError = lower.includes("enoent") || lower.includes("not found") || lower.includes("no such") ||
        lower.includes("does not exist") || lower.includes("error") || lower.includes("not exist");
      return {
        passed: hasError,
        reason: hasError ? undefined : `Expected file-not-found error, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "double-close",
    description: "Closing a database twice does not crash",
    category: "edge-cases",
    prompt: "Open a database, close it, then try to close it again. Tell me what happens.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasResult = lower.includes("close") || lower.includes("error") || lower.includes("already") ||
        lower.includes("twice") || lower.includes("second") || lower.includes("no-op");
      return {
        passed: hasResult,
        reason: hasResult ? undefined : `Expected double-close result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

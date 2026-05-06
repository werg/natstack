import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const edgeCaseTests: TestCase[] = [
  {
    name: "eval-extra-argument",
    description: "Reject unsupported eval arguments clearly",
    category: "edge-cases",
    prompt: "Call eval with an unsupported extra argument named bogusOption, then explain the validation error and retry correctly without that argument.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasValidation = lower.includes("validation") || lower.includes("additional properties") ||
        lower.includes("unsupported") || lower.includes("extra argument");
      const retried = lower.includes("retry") || lower.includes("without") || lower.includes("correct");
      return {
        passed: hasValidation && retried,
        reason: hasValidation && retried ? undefined : `Expected validation handling and a retry, got: ${msg.slice(0, 200)}`,
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
];

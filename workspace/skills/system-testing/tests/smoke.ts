import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const smokeTests: TestCase[] = [
  {
    name: "eval-return-value",
    description: "Agent computes a value and reports it",
    category: "smoke",
    prompt: "Compute something and tell me the result.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasResult = lower.includes("result") || lower.includes("answer") || /\d+/.test(msg);
      return {
        passed: hasResult,
        reason: hasResult ? undefined : `Expected a computed result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "fs-write-read",
    description: "Agent writes a file and reads it back",
    category: "smoke",
    prompt: "Write some text to a file and read it back to verify. Tell me what you wrote and what you read.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasWriteRead = lower.includes("wrote") || lower.includes("read") || lower.includes("content") || lower.includes("match");
      return {
        passed: hasWriteRead,
        reason: hasWriteRead ? undefined : `Expected write/read confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "db-crud",
    description: "Agent performs basic database CRUD operations",
    category: "smoke",
    prompt: "Create a database, set up a table, insert some data, and query it back to verify. Tell me what you stored and retrieved.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasData = lower.includes("insert") || lower.includes("stor") || lower.includes("retriev") || lower.includes("query") || lower.includes("data") || lower.includes("row");
      return {
        passed: hasData,
        reason: hasData ? undefined : `Expected store/retrieve confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "build-service",
    description: "Agent imports a workspace package and inspects exports",
    category: "smoke",
    prompt: "Import a workspace package and tell me what it exports.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasExports = lower.includes("export") || lower.includes("function") || lower.includes("module") || lower.includes("import");
      return {
        passed: hasExports,
        reason: hasExports ? undefined : `Expected export information, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

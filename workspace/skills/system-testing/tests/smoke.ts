import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const smokeTests: TestCase[] = [
  {
    name: "eval-return-value",
    description: "Agent computes a value and reports it",
    category: "smoke",
    prompt: "Compute 6 times 7 and tell me the result.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const has42 = msg.includes("42");
      return {
        passed: has42,
        reason: has42 ? undefined : `Expected "42" in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "scope-persistence",
    description: "Scope variables persist across eval calls",
    category: "smoke",
    prompt: "Set scope.answer to 42, then in a separate eval verify it persisted. Tell me the value.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const has42 = msg.includes("42");
      return {
        passed: has42,
        reason: has42 ? undefined : `Expected "42" from persisted scope, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "fs-write-read",
    description: "Agent writes a file and reads it back",
    category: "smoke",
    prompt: "Write 'hello world' to a file called smoke-test.txt, then read it back and tell me the contents.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasContent = msg.toLowerCase().includes("hello world");
      return {
        passed: hasContent,
        reason: hasContent ? undefined : `Expected "hello world" in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "db-crud",
    description: "Agent performs basic database CRUD operations",
    category: "smoke",
    prompt: "Open a database called smoke-db, create a table called items with columns id and name, insert a row with name 'test', query it back, and tell me the result.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasTest = msg.toLowerCase().includes("test");
      return {
        passed: hasTest,
        reason: hasTest ? undefined : `Expected "test" from DB query in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "build-service",
    description: "Agent imports a workspace package and inspects exports",
    category: "smoke",
    prompt: "Import @workspace/agentic-core and tell me what it exports.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasExports = lower.includes("export") || lower.includes("session") || lower.includes("manager") || lower.includes("emitter");
      return {
        passed: hasExports,
        reason: hasExports ? undefined : `Expected export information from @workspace/agentic-core, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

import type { TestCase } from "../types.js";
import { completedToolNames, findLastAgentMessage, incompleteToolCalls } from "./_helpers.js";

export const smokeTests: TestCase[] = [
  {
    name: "eval-return-value",
    description: "Agent computes a value and reports it",
    category: "smoke",
    prompt: "Compute the factorial of 5 and tell me the result.",
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
    name: "build-service",
    description: "Agent imports a workspace package and inspects exports",
    category: "smoke",
    prompt: "Import a workspace package and tell me what it exports.",
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
  {
    name: "file-search-read-tools",
    description: "Agent exercises write, find, grep, and read through the default file-tool surface",
    category: "smoke",
    prompt: [
      "Exercise the built-in file tools only; do not use eval or shell for this task.",
      "1. Write `tmp/agentic-file-tools/entity.ts` with these exact lines:",
      "   const before = true;",
      "   export const marker = createEntity('agentic-file-tools-smoke');",
      "   const after = true;",
      "2. Write `tmp/agentic-file-tools/notes.md` containing `createEntity('wrong-extension')`.",
      "3. Use find in `tmp/agentic-file-tools` with pattern `**/*.ts`.",
      "4. Use grep for pattern `createEntity` in `tmp/agentic-file-tools` with glob `**/*.ts`, limit 100, context 1.",
      "5. Use read on `tmp/agentic-file-tools/entity.ts` with offset 2 and limit 1.",
      "Finish with one concise sentence containing FIND_OK, GREP_OK, READ_OK, and agentic-file-tools-smoke.",
    ].join("\n"),
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const completed = completedToolNames(result);
      const missing = ["write", "find", "grep", "read"].filter((name) => !completed.has(name));
      if (missing.length > 0) {
        return {
          passed: false,
          reason: `Expected completed tool calls for ${missing.join(", ")}. Completed: ${[...completed].join(", ") || "(none)"}`,
        };
      }
      const incomplete = incompleteToolCalls(result);
      if (incomplete.length > 0) {
        return {
          passed: false,
          reason: `Expected no pending/error tool calls, got: ${incomplete.map((c) => `${c.name}:${c.execution?.status ?? "unknown"}`).join(", ")}`,
        };
      }
      const hasMarkers =
        lower.includes("find_ok") &&
        lower.includes("grep_ok") &&
        lower.includes("read_ok") &&
        lower.includes("agentic-file-tools-smoke");
      return {
        passed: hasMarkers,
        reason: hasMarkers ? undefined : `Expected FIND_OK, GREP_OK, READ_OK, and marker in response, got: ${msg.slice(0, 300)}`,
      };
    },
  },
];

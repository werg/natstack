import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const agentCapabilityTests: TestCase[] = [
  {
    name: "multi-turn",
    description: "Agent stores a value and confirms readiness for follow-up",
    category: "agent-capabilities",
    prompt: "First, store a secret number (pick any) in scope. Then tell me you're ready. I'll ask for it in a follow-up.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasReady = lower.includes("ready") || lower.includes("stored") || lower.includes("done") || lower.includes("set");
      return {
        passed: hasReady,
        reason: hasReady ? undefined : `Expected agent to confirm readiness, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "error-recovery",
    description: "Agent recovers from a thrown error and retries successfully",
    category: "agent-capabilities",
    prompt: "Run code that throws: throw new Error('test crash'). Then explain what happened and try again with code that works.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasError = lower.includes("error") || lower.includes("crash") || lower.includes("threw");
      const hasRecovery = lower.includes("success") || lower.includes("work") || lower.includes("result") || lower.includes("recover");
      return {
        passed: hasError && hasRecovery,
        reason: (hasError && hasRecovery) ? undefined : `Expected error acknowledgment and recovery, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "large-output",
    description: "Agent generates a large array and reports the count",
    category: "agent-capabilities",
    prompt: "Generate an array of 100 objects with sequential IDs and return it. Tell me the count.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const has100 = msg.includes("100");
      return {
        passed: has100,
        reason: has100 ? undefined : `Expected "100" count in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "dynamic-import",
    description: "Dynamically import zod and validate an email",
    category: "agent-capabilities",
    prompt: "Import the 'zod' package and create a schema that validates email addresses. Test it with 'test@example.com' and tell me the result.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasEmail = msg.includes("test@example.com");
      const lower = msg.toLowerCase();
      const hasValidation = lower.includes("valid") || lower.includes("pass") || lower.includes("success") || lower.includes("parsed");
      return {
        passed: hasEmail || hasValidation,
        reason: (hasEmail || hasValidation) ? undefined : `Expected email validation result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "console-streaming",
    description: "Console output is captured and reported",
    category: "agent-capabilities",
    prompt: "Write code that console.logs 5 numbered lines. Tell me what the console output was.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasConsole = lower.includes("console") || lower.includes("log") || lower.includes("output") || lower.includes("line");
      return {
        passed: hasConsole,
        reason: hasConsole ? undefined : `Expected console output description, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "concurrent-scope",
    description: "Multiple scope assignments persist independently",
    category: "agent-capabilities",
    prompt: "In three separate code executions: set scope.a=1, scope.b=2, scope.c=3. Then read all three and confirm they're all set.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const has1 = msg.includes("1");
      const has2 = msg.includes("2");
      const has3 = msg.includes("3");
      return {
        passed: has1 && has2 && has3,
        reason: (has1 && has2 && has3) ? undefined : `Expected values 1, 2, and 3, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const agentCapabilityTests: TestCase[] = [
  {
    name: "multi-turn",
    description: "Agent stores something in scope and retrieves it later",
    category: "agent-capabilities",
    prompt: "Store something in scope and then retrieve it in a separate step. Tell me what you stored and got back.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasStore = lower.includes("stored") || lower.includes("set") || lower.includes("retriev") || lower.includes("value") || lower.includes("scope");
      return {
        passed: hasStore,
        reason: hasStore ? undefined : `Expected scope store/retrieve confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "error-recovery",
    description: "Agent recovers from a thrown error and retries successfully",
    category: "agent-capabilities",
    prompt: "Run some code that will fail, then recover and run something that succeeds. Tell me about both outcomes.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasError = lower.includes("error") || lower.includes("fail") || lower.includes("threw") || lower.includes("exception");
      const hasRecovery = lower.includes("success") || lower.includes("work") || lower.includes("result") || lower.includes("recover") || lower.includes("succeed");
      return {
        passed: hasError && hasRecovery,
        reason: (hasError && hasRecovery) ? undefined : `Expected error and recovery, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "large-output",
    description: "Agent generates a large data structure and reports on it",
    category: "agent-capabilities",
    prompt: "Generate a large array of objects and tell me how many you created.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasNumber = /\d{2,}/.test(msg);
      return {
        passed: hasNumber,
        reason: hasNumber ? undefined : `Expected a count in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "dynamic-import",
    description: "Dynamically import an external package and use it",
    category: "agent-capabilities",
    prompt: "Import an external package and use it for something useful. Tell me what you imported and what happened.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasImport = lower.includes("import") || lower.includes("package") || lower.includes("module") || lower.includes("instal");
      return {
        passed: hasImport,
        reason: hasImport ? undefined : `Expected external package usage, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "console-streaming",
    description: "Console output is captured and reported",
    category: "agent-capabilities",
    prompt: "Run some code that logs to the console, then tell me what the output was.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasConsole = lower.includes("console") || lower.includes("log") || lower.includes("output") || lower.includes("print");
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
    prompt: "Store several different values in scope across separate code executions, then read them all back. Confirm they all persisted.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasPersist = lower.includes("persist") || lower.includes("all") || lower.includes("confirm") ||
        lower.includes("value") || lower.includes("scope") || lower.includes("stored");
      return {
        passed: hasPersist,
        reason: hasPersist ? undefined : `Expected scope persistence confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

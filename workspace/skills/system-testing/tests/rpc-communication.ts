import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const rpcTests: TestCase[] = [
  {
    name: "cross-service-call",
    description: "Call a service and report the result",
    category: "rpc-communication",
    prompt: "Call a service via RPC and report the result.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasResult = lower.includes("service") || lower.includes("rpc") || lower.includes("result") ||
        lower.includes("response") || lower.includes("workspace") || lower.includes("config");
      return {
        passed: hasResult,
        reason: hasResult ? undefined : `Expected service call result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "worker-rpc",
    description: "List worker sources via RPC",
    category: "rpc-communication",
    prompt: "List worker sources via RPC. Tell me what sources exist.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasSources = lower.includes("source") || lower.includes("worker") || lower.includes("rpc") || lower.includes("available");
      return {
        passed: hasSources,
        reason: hasSources ? undefined : `Expected worker sources listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

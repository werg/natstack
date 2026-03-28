import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const rpcTests: TestCase[] = [
  {
    name: "cross-service-call",
    description: "Call the workspace info service for workspace config",
    category: "rpc-communication",
    prompt: "Call the workspace info service to get the current workspace config. Tell me the workspace ID.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasConfig = lower.includes("workspace") || lower.includes("id") || lower.includes("config");
      return {
        passed: hasConfig,
        reason: hasConfig ? undefined : `Expected workspace ID from config, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "worker-rpc",
    description: "List worker sources via RPC",
    category: "rpc-communication",
    prompt: "List the available worker sources via RPC. Tell me what sources exist.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasSources = lower.includes("source") || lower.includes("worker") || lower.includes("hello") || lower.includes("agent");
      return {
        passed: hasSources,
        reason: hasSources ? undefined : `Expected worker sources listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

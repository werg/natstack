import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const workspaceTests: TestCase[] = [
  {
    name: "list-workspaces",
    description: "List all workspaces",
    category: "workspace",
    prompt: "List the available workspaces. Tell me their names.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasWorkspace = lower.includes("workspace") || lower.includes("name") || lower.includes("list");
      return {
        passed: hasWorkspace,
        reason: hasWorkspace ? undefined : `Expected workspace names, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "get-active",
    description: "Get the current workspace info",
    category: "workspace",
    prompt: "Get the currently active workspace and tell me about it.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasActive = lower.includes("workspace") || lower.includes("active") || lower.includes("current") ||
        lower.includes("name") || lower.includes("id");
      return {
        passed: hasActive,
        reason: hasActive ? undefined : `Expected active workspace info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "get-config",
    description: "Get workspace configuration",
    category: "workspace",
    prompt: "Get the workspace configuration. Tell me what's configured.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasConfig = lower.includes("config") || lower.includes("workspace") || lower.includes("panel") ||
        lower.includes("id") || lower.includes("setting");
      return {
        passed: hasConfig,
        reason: hasConfig ? undefined : `Expected workspace config, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

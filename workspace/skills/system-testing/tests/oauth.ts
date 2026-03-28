import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const oauthTests: TestCase[] = [
  {
    name: "list-providers",
    description: "List configured OAuth providers",
    category: "oauth",
    prompt: "List the configured OAuth providers. Tell me what's available.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasProviders = lower.includes("provider") || lower.includes("oauth") ||
        lower.includes("none") || lower.includes("available") || lower.includes("configured");
      return {
        passed: hasProviders,
        reason: hasProviders ? undefined : `Expected OAuth provider listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "list-connections",
    description: "Check for active OAuth connections",
    category: "oauth",
    prompt: "Check for active OAuth connections. Tell me what accounts are connected, or if there are none.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasConnections = lower.includes("connection") || lower.includes("account") || lower.includes("connected") ||
        lower.includes("none") || lower.includes("no ") || lower.includes("oauth");
      return {
        passed: hasConnections,
        reason: hasConnections ? undefined : `Expected connections listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "get-token-error",
    description: "Get an error when requesting a token without a connection",
    category: "oauth",
    prompt: "Try to get an OAuth token for a provider that has no active connection. Tell me the error.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasError = lower.includes("error") || lower.includes("no connection") || lower.includes("not connected") ||
        lower.includes("not found") || lower.includes("fail") || lower.includes("no token") ||
        lower.includes("null") || lower.includes("authorize");
      return {
        passed: hasError,
        reason: hasError ? undefined : `Expected error about missing connection, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

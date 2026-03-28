import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const aiTests: TestCase[] = [
  {
    name: "generate-text",
    description: "Generate a short AI response",
    category: "ai",
    prompt: "Use the AI client to generate a short text response. Tell me what it said.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasResponse = lower.includes("response") || lower.includes("said") || lower.includes("generated") ||
        lower.includes("output") || lower.includes("replied") || lower.includes("text");
      return {
        passed: hasResponse,
        reason: hasResponse ? undefined : `Expected AI-generated response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "stream-text",
    description: "Stream an AI response and collect the full output",
    category: "ai",
    prompt: "Use the AI client to stream a response and collect all the chunks. Tell me the full output.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasStream = lower.includes("stream") || lower.includes("chunk") || lower.includes("output") ||
        lower.includes("collected") || lower.includes("response") || lower.includes("text");
      return {
        passed: hasStream,
        reason: hasStream ? undefined : `Expected streamed response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "tool-use",
    description: "AI uses a custom tool during generation",
    category: "ai",
    prompt: "Use the AI client with a custom tool definition and get it to use the tool. Tell me whether it invoked the tool and what happened.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasTool = lower.includes("tool") || lower.includes("invok") || lower.includes("called") || lower.includes("function");
      return {
        passed: hasTool,
        reason: hasTool ? undefined : `Expected tool use info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "list-models",
    description: "List available AI models",
    category: "ai",
    prompt: "List the available AI models. Tell me what's configured.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasModels = lower.includes("model") || lower.includes("available") || lower.includes("configured") ||
        lower.includes("ai") || lower.includes("role");
      return {
        passed: hasModels,
        reason: hasModels ? undefined : `Expected AI models listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const aiTests: TestCase[] = [
  {
    name: "generate-text",
    description: "Generate a short AI response",
    category: "ai",
    prompt: "Use the AI client to generate a short response to 'Say hello in one word'. Tell me what it said.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasResponse = lower.includes("hello") || lower.includes("hi") || lower.includes("hey") ||
        lower.includes("greetings") || lower.includes("response") || lower.includes("said") || lower.includes("generated");
      return {
        passed: hasResponse,
        reason: hasResponse ? undefined : `Expected AI-generated greeting, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "stream-text",
    description: "Stream an AI response and collect the full output",
    category: "ai",
    prompt: "Use the AI client to stream a response to 'Count from 1 to 5'. Collect the full output and tell me.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const has1 = msg.includes("1");
      const has5 = msg.includes("5");
      return {
        passed: has1 && has5,
        reason: (has1 && has5) ? undefined : `Expected numbers 1 through 5, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "tool-use",
    description: "AI uses a custom tool during generation",
    category: "ai",
    prompt: "Use the AI client with a tool definition for 'get_weather' that returns 'sunny'. Ask it about the weather and tell me if it used the tool.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasTool = lower.includes("sunny") || lower.includes("weather") || lower.includes("tool") || lower.includes("get_weather");
      return {
        passed: hasTool,
        reason: hasTool ? undefined : `Expected tool use with "sunny" or "weather", got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "list-models",
    description: "List available AI models and roles",
    category: "ai",
    prompt: "List the available AI models/roles. Tell me what models are configured.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasModels = lower.includes("model") || lower.includes("role") || lower.includes("ai") ||
        lower.includes("claude") || lower.includes("gpt") || lower.includes("available") || lower.includes("configured");
      return {
        passed: hasModels,
        reason: hasModels ? undefined : `Expected AI models/roles listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

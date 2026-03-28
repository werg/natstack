import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const skillTests: TestCase[] = [
  {
    name: "load-sandbox",
    description: "Load the sandbox skill and describe its APIs",
    category: "skills",
    prompt: "Load the sandbox skill and tell me what tools and APIs it documents.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasSkill = lower.includes("sandbox") || lower.includes("api") || lower.includes("tool") ||
        lower.includes("eval") || lower.includes("fs") || lower.includes("db") || lower.includes("skill");
      return {
        passed: hasSkill,
        reason: hasSkill ? undefined : `Expected sandbox skill API description, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "load-paneldev",
    description: "Load the paneldev skill and describe project types",
    category: "skills",
    prompt: "Load the paneldev skill and tell me what project types can be scaffolded.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasSkill = lower.includes("panel") || lower.includes("scaffold") || lower.includes("project") ||
        lower.includes("template") || lower.includes("react") || lower.includes("svelte") || lower.includes("type");
      return {
        passed: hasSkill,
        reason: hasSkill ? undefined : `Expected paneldev project types, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "load-api-integrations",
    description: "Load the api-integrations skill and list providers",
    category: "skills",
    prompt: "Load the api-integrations skill and tell me what OAuth providers are supported.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasSkill = lower.includes("oauth") || lower.includes("provider") || lower.includes("integration") ||
        lower.includes("github") || lower.includes("google") || lower.includes("api");
      return {
        passed: hasSkill,
        reason: hasSkill ? undefined : `Expected OAuth provider listing from skill, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "load-headless-sessions",
    description: "Load the headless-sessions skill and learn how to create sessions",
    category: "skills",
    prompt: "Load the headless-sessions skill and tell me how to create a headless session.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasSkill = lower.includes("headless") || lower.includes("session") || lower.includes("create") || lower.includes("agentic");
      return {
        passed: hasSkill,
        reason: hasSkill ? undefined : `Expected headless session creation instructions, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

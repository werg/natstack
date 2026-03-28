import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const skillTests: TestCase[] = [
  {
    name: "load-sandbox",
    description: "Load the sandbox skill and describe what it offers",
    category: "skills",
    prompt: "Load the sandbox skill and describe what it offers.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasSkill = lower.includes("sandbox") || lower.includes("api") || lower.includes("tool") ||
        lower.includes("eval") || lower.includes("skill");
      return {
        passed: hasSkill,
        reason: hasSkill ? undefined : `Expected sandbox skill description, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "load-paneldev",
    description: "Load the paneldev skill and describe what projects it can create",
    category: "skills",
    prompt: "Load the paneldev skill and describe what kinds of projects it can create.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasSkill = lower.includes("panel") || lower.includes("project") || lower.includes("scaffold") ||
        lower.includes("template") || lower.includes("type") || lower.includes("create");
      return {
        passed: hasSkill,
        reason: hasSkill ? undefined : `Expected paneldev project types, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "load-api-integrations",
    description: "Load the api-integrations skill and list what it supports",
    category: "skills",
    prompt: "Load the api-integrations skill and tell me what integrations it supports.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasSkill = lower.includes("oauth") || lower.includes("provider") || lower.includes("integration") ||
        lower.includes("api") || lower.includes("service");
      return {
        passed: hasSkill,
        reason: hasSkill ? undefined : `Expected integration listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "load-headless-sessions",
    description: "Load the headless-sessions skill and describe its capabilities",
    category: "skills",
    prompt: "Load the headless-sessions skill and describe what it can do.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasSkill = lower.includes("headless") || lower.includes("session") || lower.includes("create") || lower.includes("agentic");
      return {
        passed: hasSkill,
        reason: hasSkill ? undefined : `Expected headless session capabilities, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

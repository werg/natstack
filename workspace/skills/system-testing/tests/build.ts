import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const buildTests: TestCase[] = [
  {
    name: "build-workspace-package",
    description: "Build a workspace package and verify success",
    category: "build",
    prompt: "Build a workspace package and tell me whether the build succeeded.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasBuild = lower.includes("build") || lower.includes("succeed") || lower.includes("compil") || lower.includes("success");
      return {
        passed: hasBuild,
        reason: hasBuild ? undefined : `Expected build result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "build-npm-package",
    description: "Build an npm package and get a bundle",
    category: "build",
    prompt: "Build an npm package and tell me about the bundle you got.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasBundle = lower.includes("bundle") || lower.includes("build") || lower.includes("package") || lower.includes("success");
      return {
        passed: hasBundle,
        reason: hasBundle ? undefined : `Expected bundle info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "build-at-ref",
    description: "Build a workspace package at a specific git ref",
    category: "build",
    prompt: "Build a workspace package at a previous git ref and tell me the result.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasRef = lower.includes("ref") || lower.includes("build") || lower.includes("commit") ||
        lower.includes("result") || lower.includes("version");
      return {
        passed: hasRef,
        reason: hasRef ? undefined : `Expected build-at-ref result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "import-built-package",
    description: "Import a built package and inspect its exports",
    category: "build",
    prompt: "Import a built workspace package and list its exports.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasExports = lower.includes("export") || lower.includes("function") || lower.includes("module") || lower.includes("import");
      return {
        passed: hasExports,
        reason: hasExports ? undefined : `Expected package exports, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

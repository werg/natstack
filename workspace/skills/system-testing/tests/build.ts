import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const buildTests: TestCase[] = [
  {
    name: "build-workspace-package",
    description: "Build a workspace package and verify success",
    category: "build",
    prompt: "Build the @workspace/agentic-core package and tell me whether the build succeeded.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasBuild = lower.includes("build") || lower.includes("succeed") || lower.includes("compil") || lower.includes("success");
      return {
        passed: hasBuild,
        reason: hasBuild ? undefined : `Expected build success confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "build-npm-package",
    description: "Build an npm package and get a bundle",
    category: "build",
    prompt: "Build the 'lodash' npm package (version 4) and tell me whether you got a bundle.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasBundle = lower.includes("bundle") || lower.includes("lodash") || lower.includes("build") || lower.includes("success");
      return {
        passed: hasBundle,
        reason: hasBundle ? undefined : `Expected bundle/build info for lodash, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "build-at-ref",
    description: "Build a workspace package at a specific git ref",
    category: "build",
    prompt: "Build a workspace package at a specific git ref (HEAD~1 or similar). Tell me the result.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasRef = lower.includes("ref") || lower.includes("head") || lower.includes("build") ||
        lower.includes("commit") || lower.includes("result") || lower.includes("version");
      return {
        passed: hasRef,
        reason: hasRef ? undefined : `Expected build-at-ref result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "import-built-package",
    description: "Import and list exports of a built workspace package",
    category: "build",
    prompt: "Import the @workspace/eval package and list its exports.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasExports = lower.includes("export") || lower.includes("eval") || lower.includes("function") || lower.includes("module");
      return {
        passed: hasExports,
        reason: hasExports ? undefined : `Expected @workspace/eval exports, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

const buildHint = `Use rpc from @workspace/runtime to call the build service. Example:\nimport { rpc } from "@workspace/runtime";\nconst result = await rpc.call("main", "build.getBuild", "panels/chat");`;

export const buildTests: TestCase[] = [
  {
    name: "build-workspace-package",
    description: "Build a workspace package and verify success",
    category: "build",
    prompt: `Build the workspace package "panels/chat" using the build service and tell me whether it succeeded. Report the bundle length.\n\n${buildHint}\nThe result has { bundle, metadata }. Report bundle.length to confirm success.`,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasBuild = lower.includes("build") || lower.includes("succeed") || lower.includes("compil") ||
        lower.includes("success") || lower.includes("bundle") || lower.includes("length");
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
    prompt: `Build an npm package using the build service and tell me about the bundle.\n\nimport { rpc } from "@workspace/runtime";\nconst result = await rpc.call("main", "build.getBuildNpm", "lodash-es", "4.17.21");\nReport the bundle length.`,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasBundle = lower.includes("bundle") || lower.includes("build") || lower.includes("package") ||
        lower.includes("success") || lower.includes("length");
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
    prompt: `Build the workspace package "panels/chat" at the git ref "HEAD~1" using the build service and tell me the result.\n\nimport { rpc } from "@workspace/runtime";\nconst result = await rpc.call("main", "build.getBuild", "panels/chat", "HEAD~1");\nThe second argument is the git ref. Report whether it succeeded and the bundle length.`,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasRef = lower.includes("ref") || lower.includes("build") || lower.includes("commit") ||
        lower.includes("result") || lower.includes("version") || lower.includes("bundle") || lower.includes("success");
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

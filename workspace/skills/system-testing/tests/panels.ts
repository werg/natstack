import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const panelTests: TestCase[] = [
  {
    name: "create-panel",
    description: "Open a new chat panel",
    category: "panels",
    prompt: "Open a new chat panel. Tell me the result — was it created successfully?",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasPanel = lower.includes("panel") || lower.includes("chat") || lower.includes("opened") || lower.includes("created");
      return {
        passed: hasPanel,
        reason: hasPanel ? undefined : `Expected panel creation confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "browser-panel",
    description: "Create a browser panel pointing to a URL",
    category: "panels",
    prompt: "Create a browser panel pointing to https://example.com. Tell me about the panel that was created.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasBrowser = lower.includes("browser") || lower.includes("example.com") || lower.includes("panel");
      return {
        passed: hasBrowser,
        reason: hasBrowser ? undefined : `Expected browser panel info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "browser-navigate",
    description: "Navigate a browser panel to a new URL",
    category: "panels",
    prompt: "Create a browser panel for https://example.com, then navigate it to https://example.org. Tell me the current URL after navigation.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasNav = lower.includes("example.org") || lower.includes("navigat");
      return {
        passed: hasNav,
        reason: hasNav ? undefined : `Expected "example.org" or navigation confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "browser-screenshot",
    description: "Take a screenshot of a browser panel",
    category: "panels",
    prompt: "Create a browser panel for https://example.com and take a screenshot. Tell me the image dimensions or format.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasScreenshot = lower.includes("screenshot") || lower.includes("image") || lower.includes("png") ||
        lower.includes("pixel") || lower.includes("dimension") || lower.includes("width") || lower.includes("height");
      return {
        passed: hasScreenshot,
        reason: hasScreenshot ? undefined : `Expected screenshot/image info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "browser-evaluate",
    description: "Evaluate JavaScript in a browser panel",
    category: "panels",
    prompt: "Create a browser panel for https://example.com and evaluate document.title on the page. Tell me the title.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasTitle = lower.includes("example") || lower.includes("title");
      return {
        passed: hasTitle,
        reason: hasTitle ? undefined : `Expected page title from example.com, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "panel-list-sources",
    description: "List available panel sources from the build system",
    category: "panels",
    prompt: "List all available panel sources from the build system. Tell me what panels exist.",
    timeout: 30_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasPanels = lower.includes("panel") || lower.includes("chat") || lower.includes("source") || lower.includes("build");
      return {
        passed: hasPanels,
        reason: hasPanels ? undefined : `Expected panel source listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const panelTests: TestCase[] = [
  {
    name: "create-panel",
    description: "Open a new panel",
    category: "panels",
    prompt: "Open a new panel. Tell me whether it was created successfully.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasPanel = lower.includes("panel") || lower.includes("opened") || lower.includes("created");
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
    prompt: "Open a browser panel to a website. Tell me about the panel that was created.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasBrowser = lower.includes("browser") || lower.includes("panel") || lower.includes("url") || lower.includes("http");
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
    prompt: "Open a browser panel, then navigate it to a different URL. Tell me the URL before and after.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasNav = lower.includes("navigat") || lower.includes("url") || lower.includes("http");
      return {
        passed: hasNav,
        reason: hasNav ? undefined : `Expected navigation confirmation, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "browser-screenshot",
    description: "Take a screenshot of a browser panel",
    category: "panels",
    prompt: "Open a browser panel to a webpage and take a screenshot. Tell me about the image you captured.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasScreenshot = lower.includes("screenshot") || lower.includes("image") || lower.includes("png") ||
        lower.includes("pixel") || lower.includes("dimension") || lower.includes("capture");
      return {
        passed: hasScreenshot,
        reason: hasScreenshot ? undefined : `Expected screenshot info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "browser-evaluate",
    description: "Evaluate JavaScript in a browser panel",
    category: "panels",
    prompt: "Open a browser panel and evaluate some JavaScript on the page. Tell me what it returned.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasEval = lower.includes("return") || lower.includes("result") || lower.includes("evaluat") || lower.includes("title") || lower.includes("document");
      return {
        passed: hasEval,
        reason: hasEval ? undefined : `Expected JS evaluation result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "panel-list-sources",
    description: "List available panel sources from the build system",
    category: "panels",
    prompt: "List the available panel sources. Tell me what panels can be opened.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      if (!msg) return { passed: false, reason: "No agent response received" };
      const lower = msg.toLowerCase();
      const hasPanels = lower.includes("panel") || lower.includes("source") || lower.includes("available") || lower.includes("chat");
      return {
        passed: hasPanels,
        reason: hasPanels ? undefined : `Expected panel source listing, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];

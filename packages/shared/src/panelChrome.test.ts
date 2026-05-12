import { describe, expect, it } from "vitest";
import {
  browserUrlFromPanelSource,
  buildPanelChromeState,
  formatRepoChip,
  isBrowserPanelSource,
  parseAddressInput,
  panelSourceFromBrowserUrl,
} from "./panelChrome.js";
import type { Panel } from "./types.js";

function makePanel(source: string): Panel {
  return {
    id: "panel-1",
    title: "Panel",
    children: [],
    selectedChildId: null,
    snapshot: {
      source,
      contextId: "ctx-1",
      options: {},
    },
    artifacts: { buildState: "ready" },
  };
}

describe("panelChrome", () => {
  it("recognizes browser panel sources", () => {
    expect(isBrowserPanelSource("browser:https://example.com")).toBe(true);
    expect(browserUrlFromPanelSource("browser:https://example.com")).toBe("https://example.com");
    expect(panelSourceFromBrowserUrl("https://example.com")).toBe("browser:https://example.com");
    expect(isBrowserPanelSource("panels/chat")).toBe(false);
  });

  it("parses address input into panel sources, urls, or searches", () => {
    expect(parseAddressInput("panels/chat")).toEqual({ type: "panel-source", source: "panels/chat" });
    expect(parseAddressInput("example.com")).toEqual({ type: "browser-url", url: "https://example.com" });
    expect(parseAddressInput("https://example.com/path")).toEqual({ type: "browser-url", url: "https://example.com/path" });
    expect(parseAddressInput("hello world")).toEqual({ type: "search", query: "hello world" });
  });

  it("builds browser and panel chrome state", () => {
    expect(buildPanelChromeState({
      panel: makePanel("browser:https://example.com"),
      navigation: { url: "https://example.com/docs", canGoBack: true, isLoading: true },
    })).toMatchObject({
      kind: "browser",
      displayAddress: "https://example.com/docs",
      editableAddress: "https://example.com/docs",
      canGoBack: true,
      isLoading: true,
    });

    expect(buildPanelChromeState({
      panel: makePanel("panels/chat"),
      repo: { repoPath: "panels/chat", branch: "main", commit: "abcdef1234567890", dirty: true },
    })).toMatchObject({
      kind: "panel",
      displayAddress: "panels/chat",
      repo: { branch: "main", dirty: true },
    });
  });

  it("formats repo metadata compactly", () => {
    expect(formatRepoChip({ repoPath: "panels/chat", branch: "main", commit: "abcdef123", dirty: true }))
      .toBe("panels/chat @ main @ abcdef1 @ dirty");
  });
});

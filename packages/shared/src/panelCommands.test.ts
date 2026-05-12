import { describe, expect, it } from "vitest";
import {
  applySearchTemplate,
  canonicalizeBrowserHistoryUrl,
  getAddressNavigationModeFromModifiers,
  getAvailablePanelCommands,
  getBrowserNavigationIntentForAddressAction,
  getBrowserNavigationIntentForCommand,
} from "./panelCommands.js";

describe("panelCommands", () => {
  it("maps address submit modifiers to navigation modes", () => {
    expect(getAddressNavigationModeFromModifiers({})).toBe("current");
    expect(getAddressNavigationModeFromModifiers({ shiftKey: true })).toBe("child");
    expect(getAddressNavigationModeFromModifiers({ metaKey: true })).toBe("root");
    expect(getAddressNavigationModeFromModifiers({ ctrlKey: true })).toBe("root");
    expect(getAddressNavigationModeFromModifiers({ altKey: true, shiftKey: true })).toBe("external");
  });

  it("applies configurable search templates", () => {
    expect(applySearchTemplate("hello world")).toBe("https://www.google.com/search?q=hello%20world");
    expect(applySearchTemplate("hello world", "https://search.example/?term=%s"))
      .toBe("https://search.example/?term=hello%20world");
    expect(applySearchTemplate("hello world", "https://search.example/"))
      .toBe("https://search.example/?q=hello%20world");
  });

  it("centralizes browser history canonicalization and intent semantics", () => {
    expect(canonicalizeBrowserHistoryUrl("HTTPS://Example.COM:443/docs#section")).toBe("https://example.com/docs");
    expect(canonicalizeBrowserHistoryUrl("natstack://panel")).toBeNull();

    expect(getBrowserNavigationIntentForCommand("back")).toEqual({ transition: "back_forward", typed: false });
    expect(getBrowserNavigationIntentForCommand("force-reload-view")).toEqual({ transition: "reload", typed: false });
    expect(getBrowserNavigationIntentForCommand("archive")).toBeNull();

    expect(getBrowserNavigationIntentForAddressAction({
      type: "navigate-url",
      url: "https://example.com",
      recordAsTyped: true,
    })).toEqual({ transition: "typed", typed: true });
    expect(getBrowserNavigationIntentForAddressAction({
      type: "navigate-url",
      url: "https://example.com",
    })).toBeNull();
    expect(getBrowserNavigationIntentForAddressAction({
      type: "keyword-search",
      engineId: 1,
      query: "docs",
      template: "https://example.com/search?q=%s",
      recordAsTyped: true,
    })).toEqual({ transition: "keyword_generated", typed: true });
  });

  it("filters unavailable commands from context menus", () => {
    const commands = getAvailablePanelCommands({
      chrome: {
        panelId: "panel-1",
        title: "Panel",
        kind: "panel",
        source: "panels/app",
        contextId: "ctx",
        displayAddress: "panels/app",
        editableAddress: "panels/app",
        isLoading: false,
        canGoBack: false,
        canGoForward: true,
      },
    });

    expect(commands.map((command) => command.id)).toContain("forward");
    expect(commands.map((command) => command.id)).not.toContain("back");
    expect(commands.map((command) => command.id)).not.toContain("open-external");
  });
});

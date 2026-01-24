import { describe, it, expect } from "vitest";
import { parseNsUrl, buildNsUrl, type NsAction } from "../nsProtocol.js";
import { parseNsAboutUrl, buildNsAboutUrl } from "../nsAboutProtocol.js";
import { parseNsFocusUrl, buildNsFocusUrl } from "../nsFocusProtocol.js";

describe("ns:// protocol", () => {
  describe("parseNsUrl", () => {
    it("parses simple source", () => {
      const result = parseNsUrl("ns:///panels/editor");
      expect(result.source).toBe("panels/editor");
      expect(result.action).toBe("navigate");
      expect(result.gitRef).toBeUndefined();
      expect(result.templateSpec).toBeUndefined();
      expect(result.repoArgs).toBeUndefined();
    });

    it("parses with action=child", () => {
      const result = parseNsUrl("ns:///panels/editor?action=child");
      expect(result.source).toBe("panels/editor");
      expect(result.action).toBe("child");
    });

    it("parses with action=navigate (explicit)", () => {
      const result = parseNsUrl("ns:///panels/editor?action=navigate");
      expect(result.source).toBe("panels/editor");
      expect(result.action).toBe("navigate");
    });

    it("parses with gitRef", () => {
      const result = parseNsUrl("ns:///panels/editor?gitRef=main");
      expect(result.source).toBe("panels/editor");
      expect(result.gitRef).toBe("main");
    });

    it("parses with templateSpec", () => {
      const result = parseNsUrl("ns:///panels/editor?templateSpec=contexts/default");
      expect(result.source).toBe("panels/editor");
      expect(result.templateSpec).toBe("contexts/default");
    });

    it("parses with repoArgs JSON", () => {
      const repoArgs = { workspace: "repos/app" };
      const url = `ns:///panels/editor?repoArgs=${encodeURIComponent(JSON.stringify(repoArgs))}`;
      const result = parseNsUrl(url);
      expect(result.source).toBe("panels/editor");
      expect(result.repoArgs).toEqual(repoArgs);
    });

    it("parses with all options", () => {
      const repoArgs = { workspace: "repos/app" };
      const url = `ns:///panels/editor?action=child&templateSpec=contexts/custom&gitRef=main&repoArgs=${encodeURIComponent(JSON.stringify(repoArgs))}`;
      const result = parseNsUrl(url);
      expect(result.source).toBe("panels/editor");
      expect(result.action).toBe("child");
      expect(result.templateSpec).toBe("contexts/custom");
      expect(result.gitRef).toBe("main");
      expect(result.repoArgs).toEqual(repoArgs);
    });

    it("parses source with encoded characters", () => {
      const result = parseNsUrl("ns:///panels/my%20editor");
      expect(result.source).toBe("panels/my editor");
    });

    it("parses worker source", () => {
      const result = parseNsUrl("ns:///workers/background-task");
      expect(result.source).toBe("workers/background-task");
      expect(result.action).toBe("navigate");
    });

    it("rejects invalid protocol", () => {
      expect(() => parseNsUrl("http://example.com")).toThrow("Invalid ns URL protocol");
    });

    it("rejects missing source", () => {
      expect(() => parseNsUrl("ns:///")).toThrow("missing source path");
    });

    it("rejects invalid action", () => {
      expect(() => parseNsUrl("ns:///panels/editor?action=invalid")).toThrow("Invalid ns URL action");
    });

    it("rejects malformed repoArgs JSON", () => {
      expect(() => parseNsUrl("ns:///panels/editor?repoArgs=not-json")).toThrow("Invalid JSON");
    });

    it("parses with focus=true", () => {
      const result = parseNsUrl("ns:///panels/editor?focus=true");
      expect(result.source).toBe("panels/editor");
      expect(result.focus).toBe(true);
    });

    it("returns focus undefined when not present", () => {
      const result = parseNsUrl("ns:///panels/editor");
      expect(result.focus).toBeUndefined();
    });

    it("returns focus undefined for focus=false", () => {
      const result = parseNsUrl("ns:///panels/editor?focus=false");
      expect(result.focus).toBeUndefined();
    });
  });

  describe("buildNsUrl", () => {
    it("builds simple URL", () => {
      const url = buildNsUrl("panels/editor");
      expect(url).toBe("ns:///panels/editor");
    });

    it("builds URL with action=child", () => {
      const url = buildNsUrl("panels/editor", { action: "child" });
      expect(url).toBe("ns:///panels/editor?action=child");
    });

    it("omits action=navigate (default)", () => {
      const url = buildNsUrl("panels/editor", { action: "navigate" });
      expect(url).toBe("ns:///panels/editor");
    });

    it("builds URL with gitRef", () => {
      const url = buildNsUrl("panels/editor", { gitRef: "main" });
      expect(url).toBe("ns:///panels/editor?gitRef=main");
    });

    it("builds URL with templateSpec", () => {
      const url = buildNsUrl("panels/editor", { templateSpec: "contexts/default" });
      expect(url).toBe("ns:///panels/editor?templateSpec=contexts%2Fdefault");
    });

    it("builds URL with repoArgs", () => {
      const url = buildNsUrl("panels/editor", { repoArgs: { workspace: "repos/app" } });
      expect(url).toContain("repoArgs=");
      // Verify round-trip
      const parsed = parseNsUrl(url);
      expect(parsed.repoArgs).toEqual({ workspace: "repos/app" });
    });

    it("builds URL with all options", () => {
      const url = buildNsUrl("panels/editor", {
        action: "child",
        templateSpec: "contexts/custom",
        gitRef: "main",
        repoArgs: { workspace: "repos/app" },
      });
      const parsed = parseNsUrl(url);
      expect(parsed.source).toBe("panels/editor");
      expect(parsed.action).toBe("child");
      expect(parsed.templateSpec).toBe("contexts/custom");
      expect(parsed.gitRef).toBe("main");
      expect(parsed.repoArgs).toEqual({ workspace: "repos/app" });
    });

    it("encodes source with special characters", () => {
      const url = buildNsUrl("panels/my editor");
      expect(url).toBe("ns:///panels/my%20editor");
    });

    it("preserves slashes in source", () => {
      const url = buildNsUrl("panels/deep/nested/path");
      expect(url).toBe("ns:///panels/deep/nested/path");
    });

    it("builds URL with focus=true", () => {
      const url = buildNsUrl("panels/editor", { focus: true });
      expect(url).toBe("ns:///panels/editor?focus=true");
    });

    it("omits focus when false", () => {
      const url = buildNsUrl("panels/editor", { focus: false });
      expect(url).toBe("ns:///panels/editor");
    });

    it("omits focus when undefined", () => {
      const url = buildNsUrl("panels/editor", { focus: undefined });
      expect(url).toBe("ns:///panels/editor");
    });
  });

  describe("round-trip", () => {
    it("parseNsUrl(buildNsUrl(...)) returns original values", () => {
      const options = {
        action: "child" as NsAction,
        templateSpec: "contexts/default",
        gitRef: "feature/test",
        repoArgs: { workspace: { repo: "repos/app", ref: "v1.0.0" } },
        focus: true,
      };
      const url = buildNsUrl("panels/editor", options);
      const parsed = parseNsUrl(url);
      expect(parsed.source).toBe("panels/editor");
      expect(parsed.action).toBe("child");
      expect(parsed.templateSpec).toBe("contexts/default");
      expect(parsed.gitRef).toBe("feature/test");
      expect(parsed.repoArgs).toEqual({ workspace: { repo: "repos/app", ref: "v1.0.0" } });
      expect(parsed.focus).toBe(true);
    });
  });
});

describe("ns-about:// protocol", () => {
  describe("parseNsAboutUrl", () => {
    it("parses settings page", () => {
      const result = parseNsAboutUrl("ns-about://model-provider-config");
      expect(result.page).toBe("model-provider-config");
    });

    it("parses about page", () => {
      const result = parseNsAboutUrl("ns-about://about");
      expect(result.page).toBe("about");
    });

    it("parses help page", () => {
      const result = parseNsAboutUrl("ns-about://help");
      expect(result.page).toBe("help");
    });

    it("parses keyboard-shortcuts page", () => {
      const result = parseNsAboutUrl("ns-about://keyboard-shortcuts");
      expect(result.page).toBe("keyboard-shortcuts");
    });

    it("rejects invalid protocol", () => {
      expect(() => parseNsAboutUrl("http://settings")).toThrow("Invalid ns-about URL protocol");
    });

    it("rejects missing page", () => {
      expect(() => parseNsAboutUrl("ns-about://")).toThrow("missing page");
    });

    it("rejects invalid page", () => {
      expect(() => parseNsAboutUrl("ns-about://invalid-page")).toThrow("Invalid ns-about page");
    });
  });

  describe("buildNsAboutUrl", () => {
    it("builds model-provider-config URL", () => {
      const url = buildNsAboutUrl("model-provider-config");
      expect(url).toBe("ns-about://model-provider-config");
    });

    it("builds about URL", () => {
      const url = buildNsAboutUrl("about");
      expect(url).toBe("ns-about://about");
    });

    it("rejects invalid page", () => {
      expect(() => buildNsAboutUrl("invalid" as any)).toThrow("Invalid about page");
    });
  });

  describe("round-trip", () => {
    it("parseNsAboutUrl(buildNsAboutUrl(...)) returns original page", () => {
      const url = buildNsAboutUrl("keyboard-shortcuts");
      const parsed = parseNsAboutUrl(url);
      expect(parsed.page).toBe("keyboard-shortcuts");
    });
  });
});

describe("ns-focus:// protocol", () => {
  describe("parseNsFocusUrl", () => {
    it("parses simple panel ID", () => {
      const result = parseNsFocusUrl("ns-focus:///tree/root/editor-abc");
      expect(result.panelId).toBe("tree/root/editor-abc");
    });

    it("parses nested panel ID", () => {
      const result = parseNsFocusUrl("ns-focus:///tree/root/child-1/child-2");
      expect(result.panelId).toBe("tree/root/child-1/child-2");
    });

    it("parses encoded panel ID", () => {
      const result = parseNsFocusUrl("ns-focus:///tree/root/panel%20with%20spaces");
      expect(result.panelId).toBe("tree/root/panel with spaces");
    });

    it("rejects invalid protocol", () => {
      expect(() => parseNsFocusUrl("http://tree/root")).toThrow("Invalid ns-focus URL protocol");
    });

    it("rejects missing panel ID", () => {
      expect(() => parseNsFocusUrl("ns-focus:///")).toThrow("missing panel ID");
    });
  });

  describe("buildNsFocusUrl", () => {
    it("builds URL with simple panel ID", () => {
      const url = buildNsFocusUrl("tree/root/editor-abc");
      expect(url).toBe("ns-focus:///tree/root/editor-abc");
    });

    it("builds URL with nested panel ID", () => {
      const url = buildNsFocusUrl("tree/root/child-1/child-2");
      expect(url).toBe("ns-focus:///tree/root/child-1/child-2");
    });

    it("encodes special characters but preserves slashes", () => {
      const url = buildNsFocusUrl("tree/root/panel with spaces");
      expect(url).toBe("ns-focus:///tree/root/panel%20with%20spaces");
    });
  });

  describe("round-trip", () => {
    it("parseNsFocusUrl(buildNsFocusUrl(...)) returns original panel ID", () => {
      const panelId = "tree/root/child-1/my-panel";
      const url = buildNsFocusUrl(panelId);
      const parsed = parseNsFocusUrl(url);
      expect(parsed.panelId).toBe(panelId);
    });

    it("handles special characters in round-trip", () => {
      const panelId = "tree/root/panel with spaces & special=chars";
      const url = buildNsFocusUrl(panelId);
      const parsed = parseNsFocusUrl(url);
      expect(parsed.panelId).toBe(panelId);
    });
  });
});

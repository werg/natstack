import { describe, it, expect } from "vitest";
import { buildNsLink, buildAboutLink, buildFocusLink } from "../nsLinks.js";

describe("nsLinks", () => {
  describe("buildNsLink", () => {
    it("builds simple URL", () => {
      const url = buildNsLink("panels/editor");
      expect(url).toBe("ns:///panels/editor");
    });

    it("builds URL with action=child", () => {
      const url = buildNsLink("panels/editor", { action: "child" });
      expect(url).toBe("ns:///panels/editor?action=child");
    });

    it("omits action=navigate (default)", () => {
      const url = buildNsLink("panels/editor", { action: "navigate" });
      expect(url).toBe("ns:///panels/editor");
    });

    it("builds URL with contextId", () => {
      const url = buildNsLink("panels/editor", { contextId: "abc" });
      expect(url).toBe("ns:///panels/editor?contextId=abc");
    });

    it("builds URL with contextId=true", () => {
      const url = buildNsLink("panels/editor", { contextId: true });
      expect(url).toBe("ns:///panels/editor?contextId=true");
    });

    it("builds URL with gitRef", () => {
      const url = buildNsLink("panels/editor", { gitRef: "main" });
      expect(url).toBe("ns:///panels/editor?gitRef=main");
    });

    it("builds URL with repoArgs", () => {
      const url = buildNsLink("panels/editor", { repoArgs: { workspace: "repos/app" } });
      expect(url).toContain("repoArgs=");
      expect(url).toContain("panels/editor");
    });

    it("builds URL with ephemeral flag", () => {
      const url = buildNsLink("panels/editor", { ephemeral: true });
      expect(url).toBe("ns:///panels/editor?ephemeral=true");
    });

    it("builds URL with focus=true", () => {
      const url = buildNsLink("panels/editor", { focus: true });
      expect(url).toBe("ns:///panels/editor?focus=true");
    });

    it("omits focus when false", () => {
      const url = buildNsLink("panels/editor", { focus: false });
      expect(url).toBe("ns:///panels/editor");
    });

    it("omits focus when undefined", () => {
      const url = buildNsLink("panels/editor", { focus: undefined });
      expect(url).toBe("ns:///panels/editor");
    });

    it("builds URL with all options", () => {
      const url = buildNsLink("panels/editor", {
        action: "child",
        contextId: "abc",
        gitRef: "main",
        repoArgs: { workspace: "repos/app" },
        ephemeral: true,
        focus: true,
      });
      expect(url).toContain("action=child");
      expect(url).toContain("contextId=abc");
      expect(url).toContain("gitRef=main");
      expect(url).toContain("repoArgs=");
      expect(url).toContain("ephemeral=true");
      expect(url).toContain("focus=true");
    });

    it("encodes source with special characters", () => {
      const url = buildNsLink("panels/my editor");
      expect(url).toBe("ns:///panels/my%20editor");
    });

    it("preserves slashes in source", () => {
      const url = buildNsLink("panels/deep/nested/path");
      expect(url).toBe("ns:///panels/deep/nested/path");
    });

    it("builds worker URL", () => {
      const url = buildNsLink("workers/background-task");
      expect(url).toBe("ns:///workers/background-task");
    });
  });

  describe("buildAboutLink", () => {
    it("builds model-provider-config URL", () => {
      const url = buildAboutLink("model-provider-config");
      expect(url).toBe("ns-about://model-provider-config");
    });

    it("builds about URL", () => {
      const url = buildAboutLink("about");
      expect(url).toBe("ns-about://about");
    });

    it("builds help URL", () => {
      const url = buildAboutLink("help");
      expect(url).toBe("ns-about://help");
    });

    it("builds keyboard-shortcuts URL", () => {
      const url = buildAboutLink("keyboard-shortcuts");
      expect(url).toBe("ns-about://keyboard-shortcuts");
    });

    it("rejects invalid page", () => {
      expect(() => buildAboutLink("invalid" as any)).toThrow("Invalid about page");
    });
  });

  describe("buildFocusLink", () => {
    it("builds URL with simple panel ID", () => {
      const url = buildFocusLink("tree/root/editor-abc");
      expect(url).toBe("ns-focus:///tree/root/editor-abc");
    });

    it("builds URL with nested panel ID", () => {
      const url = buildFocusLink("tree/root/child-1/child-2");
      expect(url).toBe("ns-focus:///tree/root/child-1/child-2");
    });

    it("encodes special characters but preserves slashes", () => {
      const url = buildFocusLink("tree/root/panel with spaces");
      expect(url).toBe("ns-focus:///tree/root/panel%20with%20spaces");
    });
  });
});

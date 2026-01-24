import { describe, it, expect } from "vitest";
import {
  parseContextId,
  isValidContextId,
  createContextId,
  generateInstanceId,
  deriveInstanceIdFromPanelId,
  validateContextIdMode,
  getTemplateSpecHashFromContextId,
  createUnsafeContextId,
  isUnsafeNoContextId,
} from "../contextId.js";

describe("contextId", () => {
  describe("createContextId", () => {
    it("creates valid context ID with safe mode", () => {
      const contextId = createContextId("safe", "a1b2c3d4e5f67890", "default");
      expect(contextId).toBe("safe_tpl_a1b2c3d4e5f6_default");
    });

    it("truncates hash to 12 characters", () => {
      const contextId = createContextId("safe", "abcdef123456789abcdef", "instance");
      expect(contextId).toBe("safe_tpl_abcdef123456_instance");
    });

    it("lowercases hash", () => {
      const contextId = createContextId("safe", "ABCDEF123456789", "instance");
      expect(contextId).toBe("safe_tpl_abcdef123456_instance");
    });

    it("allows underscores in instance ID", () => {
      const contextId = createContextId("safe", "a1b2c3d4e5f67890", "my_panel_name");
      expect(contextId).toBe("safe_tpl_a1b2c3d4e5f6_my_panel_name");
    });

    it("allows hyphens in instance ID", () => {
      const contextId = createContextId("safe", "a1b2c3d4e5f67890", "my-panel-name");
      expect(contextId).toBe("safe_tpl_a1b2c3d4e5f6_my-panel-name");
    });

    it("allows tildes in instance ID", () => {
      const contextId = createContextId("safe", "a1b2c3d4e5f67890", "tree~root~panel");
      expect(contextId).toBe("safe_tpl_a1b2c3d4e5f6_tree~root~panel");
    });

    it("throws on empty instance ID", () => {
      expect(() => createContextId("safe", "a1b2c3d4e5f67890", "")).toThrow("Instance ID cannot be empty");
    });

    it("throws on invalid hash format", () => {
      expect(() => createContextId("safe", "short", "instance")).toThrow("Invalid template spec hash");
    });

    it("throws on invalid characters in instance ID", () => {
      expect(() => createContextId("safe", "a1b2c3d4e5f67890", "invalid/id")).toThrow("Invalid instance ID");
      expect(() => createContextId("safe", "a1b2c3d4e5f67890", "has spaces")).toThrow("Invalid instance ID");
    });
  });

  describe("createUnsafeContextId", () => {
    it("creates unsafe no-context ID", () => {
      const contextId = createUnsafeContextId("panels~terminal");
      expect(contextId).toBe("unsafe_noctx_panels~terminal");
    });

    it("sanitizes invalid characters", () => {
      const contextId = createUnsafeContextId("panels/terminal");
      expect(contextId).toBe("unsafe_noctx_panels_terminal");
    });

    it("allows underscores, hyphens, and tildes", () => {
      const contextId = createUnsafeContextId("my_panel-name~suffix");
      expect(contextId).toBe("unsafe_noctx_my_panel-name~suffix");
    });

    it("throws on empty instance ID after sanitization", () => {
      expect(() => createUnsafeContextId("")).toThrow("Instance ID cannot be empty");
    });
  });

  describe("isUnsafeNoContextId", () => {
    it("returns true for unsafe_noctx_ IDs", () => {
      expect(isUnsafeNoContextId("unsafe_noctx_panels~terminal")).toBe(true);
      expect(isUnsafeNoContextId("unsafe_noctx_test")).toBe(true);
    });

    it("returns false for other ID formats", () => {
      expect(isUnsafeNoContextId("safe_tpl_a1b2c3d4e5f6_test")).toBe(false);
      expect(isUnsafeNoContextId("invalid")).toBe(false);
      expect(isUnsafeNoContextId("")).toBe(false);
    });
  });

  describe("parseContextId", () => {
    it("parses valid safe template context ID", () => {
      const parsed = parseContextId("safe_tpl_a1b2c3d4e5f6_default");
      expect(parsed).toEqual({
        mode: "safe",
        templateSpecHash: "a1b2c3d4e5f6",
        instanceId: "default",
      });
    });

    it("parses valid unsafe no-context ID", () => {
      const parsed = parseContextId("unsafe_noctx_panels~terminal");
      expect(parsed).toEqual({
        mode: "unsafe",
        templateSpecHash: null,
        instanceId: "panels~terminal",
      });
    });

    it("parses instance ID with underscores", () => {
      const parsed = parseContextId("safe_tpl_a1b2c3d4e5f6_panel_with_underscores");
      expect(parsed).toEqual({
        mode: "safe",
        templateSpecHash: "a1b2c3d4e5f6",
        instanceId: "panel_with_underscores",
      });
    });

    it("parses instance ID with tildes", () => {
      const parsed = parseContextId("safe_tpl_a1b2c3d4e5f6_tree~root~panel");
      expect(parsed).toEqual({
        mode: "safe",
        templateSpecHash: "a1b2c3d4e5f6",
        instanceId: "tree~root~panel",
      });
    });

    it("parses unsafe no-context ID with underscores", () => {
      const parsed = parseContextId("unsafe_noctx_my_panel_name");
      expect(parsed).toEqual({
        mode: "unsafe",
        templateSpecHash: null,
        instanceId: "my_panel_name",
      });
    });

    it("returns null for invalid format", () => {
      expect(parseContextId("invalid")).toBeNull();
      expect(parseContextId("safe_auto_someid")).toBeNull();
      expect(parseContextId("safe_named_someid")).toBeNull();
      expect(parseContextId("")).toBeNull();
    });

    it("returns null for incomplete context ID", () => {
      expect(parseContextId("safe_tpl_a1b2c3d4e5f6")).toBeNull();
      expect(parseContextId("safe_tpl_")).toBeNull();
      expect(parseContextId("unsafe_noctx_")).toBeNull();
    });
  });

  describe("isValidContextId", () => {
    it("returns true for valid safe template context IDs", () => {
      expect(isValidContextId("safe_tpl_a1b2c3d4e5f6_default")).toBe(true);
    });

    it("returns true for valid unsafe no-context IDs", () => {
      expect(isValidContextId("unsafe_noctx_panels~terminal")).toBe(true);
      expect(isValidContextId("unsafe_noctx_test")).toBe(true);
    });

    it("returns false for invalid context IDs", () => {
      expect(isValidContextId("invalid")).toBe(false);
      expect(isValidContextId("safe_auto_test")).toBe(false);
      expect(isValidContextId("")).toBe(false);
    });
  });

  describe("deriveInstanceIdFromPanelId", () => {
    it("replaces slashes with tildes", () => {
      expect(deriveInstanceIdFromPanelId("tree/root/panel")).toBe("tree~root~panel");
    });

    it("handles no slashes", () => {
      expect(deriveInstanceIdFromPanelId("simple-panel")).toBe("simple-panel");
    });

    it("handles multiple consecutive slashes", () => {
      expect(deriveInstanceIdFromPanelId("a//b")).toBe("a~~b");
    });
  });

  describe("generateInstanceId", () => {
    it("generates unique IDs", () => {
      const id1 = generateInstanceId();
      const id2 = generateInstanceId();
      expect(id1).not.toBe(id2);
    });

    it("adds prefix when provided", () => {
      const id = generateInstanceId("test");
      expect(id).toMatch(/^test-/);
    });

    it("generates valid format", () => {
      const id = generateInstanceId();
      // Should be alphanumeric with hyphens (timestamp-random)
      expect(id).toMatch(/^[a-z0-9]+-[a-f0-9]+$/);
    });
  });

  describe("validateContextIdMode", () => {
    it("does not throw for matching mode", () => {
      expect(() => validateContextIdMode("safe_tpl_a1b2c3d4e5f6_test", "safe")).not.toThrow();
      expect(() => validateContextIdMode("unsafe_noctx_panels~terminal", "unsafe")).not.toThrow();
    });

    it("throws for mismatched mode", () => {
      expect(() => validateContextIdMode("safe_tpl_a1b2c3d4e5f6_test", "unsafe")).toThrow("Context mode mismatch");
      expect(() => validateContextIdMode("unsafe_noctx_test", "safe")).toThrow("Context mode mismatch");
    });

    it("throws for invalid context ID format", () => {
      expect(() => validateContextIdMode("invalid_format", "safe")).toThrow("Invalid context ID format");
    });
  });

  describe("getTemplateSpecHashFromContextId", () => {
    it("extracts hash from valid template context ID", () => {
      expect(getTemplateSpecHashFromContextId("safe_tpl_a1b2c3d4e5f6_test")).toBe("a1b2c3d4e5f6");
    });

    it("returns null for unsafe no-context IDs (no template)", () => {
      expect(getTemplateSpecHashFromContextId("unsafe_noctx_panels~terminal")).toBeNull();
    });

    it("returns null for invalid context ID", () => {
      expect(getTemplateSpecHashFromContextId("invalid")).toBeNull();
      expect(getTemplateSpecHashFromContextId("")).toBeNull();
    });
  });
});

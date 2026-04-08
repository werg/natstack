/**
 * Tests for the Pi-based AIHandler wiring.
 *
 * The full streamText path requires a real Pi session, which can't be mocked
 * meaningfully at the unit level. These tests cover the public surface that
 * aiService.ts depends on and confirm construction with no providers does not
 * throw.
 */

import { describe, it, expect } from "vitest";
import { AIHandler } from "../aiHandler.js";

describe("AIHandler (Pi-native)", () => {
  describe("construction", () => {
    it("constructs with no providers and no workspace path", () => {
      expect(() => new AIHandler()).not.toThrow();
    });

    it("constructs with a workspace path", () => {
      expect(() => new AIHandler("/tmp/workspace")).not.toThrow();
    });
  });

  describe("getAvailableRoles", () => {
    it("returns empty record before initialize() is called", () => {
      const handler = new AIHandler();
      const roles = handler.getAvailableRoles();
      expect(typeof roles).toBe("object");
      expect(Object.keys(roles).length).toBe(0);
    });
  });

  describe("resolveModelId", () => {
    it("returns the input id verbatim before initialize()", () => {
      const handler = new AIHandler();
      expect(handler.resolveModelId("anthropic:claude-sonnet-4")).toBe(
        "anthropic:claude-sonnet-4",
      );
    });
  });

  describe("cancelStream", () => {
    it("does not throw when cancelling a non-existent stream", () => {
      const handler = new AIHandler();
      expect(() => handler.cancelStream("no-such-stream")).not.toThrow();
    });
  });
});

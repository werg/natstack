/**
 * Tests for AIHandler — Pi-native runtime entrypoint.
 *
 * The handler now wraps Pi (`@mariozechner/pi-coding-agent`); we can't easily
 * exercise the full streamText path without spinning up a real Pi session, so
 * these tests focus on the public surface that aiService.ts uses.
 */

vi.mock("@natstack/dev-log", () => ({
  createDevLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock("../errors.js", () => ({
  createAIError: vi.fn((code: string, message: string) => {
    const err = new Error(message);
    (err as any).code = code;
    (err as any).retryable = false;
    return err;
  }),
}));

vi.mock("../constants.js", () => ({
  MAX_STREAM_DURATION_MS: 600_000,
}));

import { AIHandler } from "./aiHandler.js";

describe("AIHandler", () => {
  let handler: AIHandler;

  beforeEach(() => {
    handler = new AIHandler();
  });

  describe("construction", () => {
    it("constructs without throwing when no providers are configured", () => {
      expect(() => new AIHandler()).not.toThrow();
    });

    it("constructs with a workspace path", () => {
      expect(() => new AIHandler("/tmp/workspace")).not.toThrow();
    });
  });

  describe("resolveModelId", () => {
    it("returns the input model id unchanged when no role resolver is configured", () => {
      // No initialize() call → no modelRoleResolver
      expect(handler.resolveModelId("anthropic:claude-sonnet-4")).toBe("anthropic:claude-sonnet-4");
    });
  });

  describe("cancelStream", () => {
    it("does not throw when cancelling a non-existent stream", () => {
      expect(() => handler.cancelStream("no-such-stream")).not.toThrow();
    });
  });

  describe("getAvailableRoles", () => {
    it("returns empty object when no model role resolver is set", () => {
      const roles = handler.getAvailableRoles();
      expect(roles).toBeDefined();
      expect(typeof roles).toBe("object");
      expect(Object.keys(roles).length).toBe(0);
    });
  });
});

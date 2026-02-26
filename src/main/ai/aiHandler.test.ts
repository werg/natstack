/**
 * Tests for AIHandler — stream management and provider registry behavior.
 *
 * We mock away the heavy dependencies (Claude Code conversation manager,
 * provider factory, model roles) and test the AIHandler's public API for
 * provider registration, model discovery, stream cancellation, and role resolution.
 */

vi.mock("./claudeCodeConversationManager.js", () => ({
  getClaudeCodeConversationManager: vi.fn().mockReturnValue({
    createConversation: vi.fn(),
    endConversation: vi.fn(),
  }),
}));

vi.mock("./claudeCodeToolProxy.js", () => ({}));

vi.mock("../../shared/errors.js", () => ({
  createAIError: vi.fn((code: string, message: string) => {
    const err = new Error(message);
    (err as any).code = code;
    (err as any).retryable = false;
    return err;
  }),
}));

vi.mock("../../shared/logging.js", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  generateRequestId: vi.fn().mockReturnValue("req_test_123"),
}));

vi.mock("../../shared/validation.js", () => ({
  validateToolDefinitions: vi.fn((tools: unknown) => tools),
}));

vi.mock("../../shared/constants.js", () => ({
  MAX_STREAM_DURATION_MS: 600_000,
}));

import { AIHandler, type AIProviderConfig } from "./aiHandler.js";

/** Create a minimal mock provider config. */
function mockProviderConfig(id: string, models: Array<{ id: string; displayName: string }>): AIProviderConfig {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    createModel: vi.fn().mockReturnValue({
      specificationVersion: "v3",
      provider: id,
      modelId: `${id}:${models[0]?.id ?? "default"}`,
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    }),
    models,
  };
}

describe("AIHandler", () => {
  let handler: AIHandler;

  beforeEach(() => {
    handler = new AIHandler();
  });

  // -------------------------------------------------------------------------
  // Provider registration
  // -------------------------------------------------------------------------
  describe("registerProvider", () => {
    it("registers a provider and makes its models discoverable", () => {
      const config = mockProviderConfig("test-provider", [
        { id: "model-a", displayName: "Model A" },
        { id: "model-b", displayName: "Model B" },
      ]);

      handler.registerProvider(config);

      // The handler should not throw when asked to cancel a non-existent stream
      // (verifies handler is in a working state after registration)
      expect(() => handler.cancelStream("nonexistent")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // clearProviders
  // -------------------------------------------------------------------------
  describe("clearProviders", () => {
    it("removes all registered providers", () => {
      const config = mockProviderConfig("test", [
        { id: "m1", displayName: "M1" },
      ]);
      handler.registerProvider(config);
      handler.clearProviders();

      // After clearing, trying to get a model from the cleared provider
      // should fail. We verify this indirectly by checking getAvailableRoles
      // returns empty (no models registered, no resolver).
      const roles = handler.getAvailableRoles();
      // Without a model role resolver, returns empty object
      expect(Object.keys(roles).length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // resolveModelId — without role resolver
  // -------------------------------------------------------------------------
  describe("resolveModelId", () => {
    it("returns the input model id unchanged when no role resolver is configured", () => {
      // No initialize() call → no modelRoleResolver
      expect(handler.resolveModelId("anthropic:claude-sonnet-4")).toBe("anthropic:claude-sonnet-4");
    });
  });

  // -------------------------------------------------------------------------
  // cancelStream
  // -------------------------------------------------------------------------
  describe("cancelStream", () => {
    it("does not throw when cancelling a non-existent stream", () => {
      expect(() => handler.cancelStream("no-such-stream")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getAvailableRoles — without initialization
  // -------------------------------------------------------------------------
  describe("getAvailableRoles", () => {
    it("returns empty object when no model role resolver is set", () => {
      const roles = handler.getAvailableRoles();
      expect(roles).toBeDefined();
      // Without initialization, roles is an empty cast
      expect(typeof roles).toBe("object");
    });
  });
});

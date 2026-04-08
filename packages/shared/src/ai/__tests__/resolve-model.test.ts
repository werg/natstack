/**
 * Tests for resolveModelToPi — model string parsing + Pi model resolution.
 */

import { describe, it, expect } from "vitest";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { resolveModelToPi } from "../resolve-model.js";

describe("resolveModelToPi", () => {
  const auth = AuthStorage.inMemory();

  it("resolves a known anthropic model to a Pi Model object", () => {
    const result = resolveModelToPi("anthropic:claude-sonnet-4-5-20250929", auth);
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(result.model).toBeDefined();
    expect(result.model.provider).toBe("anthropic");
  });

  it("resolves a known openai model to a Pi Model object", () => {
    const result = resolveModelToPi("openai:gpt-4o", auth);
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.model).toBeDefined();
    expect(result.model.provider).toBe("openai");
  });

  it("throws when the input has no colon", () => {
    expect(() => resolveModelToPi("claude-sonnet", auth)).toThrow(
      /Model string must be "provider:model"/,
    );
  });

  it("throws when the provider half is empty", () => {
    expect(() => resolveModelToPi(":model-id", auth)).toThrow(
      /Model string must be "provider:model"/,
    );
  });

  it("throws when the model half is empty", () => {
    expect(() => resolveModelToPi("anthropic:", auth)).toThrow(
      /Model string must be "provider:model"/,
    );
  });

  it("throws when the provider is unknown", () => {
    expect(() => resolveModelToPi("unknown-provider:some-model", auth)).toThrow(
      /Unknown model/,
    );
  });

  it("throws when the model id is unknown for a known provider", () => {
    expect(() => resolveModelToPi("anthropic:not-a-real-model-12345", auth)).toThrow(
      /Unknown model/,
    );
  });
});

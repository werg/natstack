import {
  ModelRoleResolver,
  isStandardRole,
  createModelRoleResolver,
} from "./modelRoles.js";

describe("isStandardRole", () => {
  it("returns true for standard roles", () => {
    expect(isStandardRole("smart")).toBe(true);
    expect(isStandardRole("coding")).toBe(true);
    expect(isStandardRole("fast")).toBe(true);
    expect(isStandardRole("cheap")).toBe(true);
  });

  it("returns false for non-standard roles", () => {
    expect(isStandardRole("unknown")).toBe(false);
    expect(isStandardRole("")).toBe(false);
    expect(isStandardRole("SMART")).toBe(false);
  });
});

describe("ModelRoleResolver", () => {
  it("resolves default models when no config is provided", () => {
    const resolver = new ModelRoleResolver();
    expect(resolver.resolve("smart")).toBe("anthropic:claude-opus-4-6");
    expect(resolver.resolve("coding")).toBe("anthropic:claude-sonnet-4-5-20250929");
    expect(resolver.resolve("fast")).toBe("groq:llama-3.3-70b-versatile");
    expect(resolver.resolve("cheap")).toBe("groq:llama-3.1-8b-instant");
  });

  it("resolveSpec returns full ResolvedModelSpec", () => {
    const resolver = new ModelRoleResolver();
    const spec = resolver.resolveSpec("smart");
    expect(spec).toEqual({
      modelId: "anthropic:claude-opus-4-6",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("falls back from coding to smart when coding is not configured but smart is", () => {
    const resolver = new ModelRoleResolver({
      smart: "openai:gpt-4o",
    });
    // coding is not configured, should fall back to smart's config
    expect(resolver.resolve("coding")).toBe("openai:gpt-4o");
  });

  it("falls back from fast to cheap and vice versa", () => {
    const resolver = new ModelRoleResolver({
      cheap: "groq:custom-model",
    });
    // fast is not configured, should fall back to cheap
    expect(resolver.resolve("fast")).toBe("groq:custom-model");
  });

  it("getModelSpec parses a direct provider:model string", () => {
    const resolver = new ModelRoleResolver();
    const spec = resolver.getModelSpec("openai:gpt-4o");
    expect(spec).toEqual({
      modelId: "openai:gpt-4o",
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("getModelSpec defaults to anthropic provider for unknown format", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver = new ModelRoleResolver();
    const spec = resolver.getModelSpec("some-model-name");
    expect(spec).toEqual({
      modelId: "anthropic:some-model-name",
      provider: "anthropic",
      model: "some-model-name",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("without provider prefix")
    );
    warnSpy.mockRestore();
  });

  it("getAllRoles returns all standard roles with resolved model IDs", () => {
    const resolver = new ModelRoleResolver();
    const roles = resolver.getAllRoles();
    expect(roles).toEqual({
      smart: "anthropic:claude-opus-4-6",
      coding: "anthropic:claude-sonnet-4-5-20250929",
      fast: "groq:llama-3.3-70b-versatile",
      cheap: "groq:llama-3.1-8b-instant",
    });
  });

  it("getAllRoles includes custom roles from config", () => {
    const resolver = new ModelRoleResolver({
      summarizer: "openai:gpt-4o-mini",
    });
    const roles = resolver.getAllRoles();
    expect(roles.summarizer).toBe("openai:gpt-4o-mini");
    // Standard roles should still be present (defaults)
    expect(roles.smart).toBe("anthropic:claude-opus-4-6");
  });

  it("updateConfig changes resolved models", () => {
    const resolver = new ModelRoleResolver();
    expect(resolver.resolve("smart")).toBe("anthropic:claude-opus-4-6");

    resolver.updateConfig({ smart: "openai:o1" });
    expect(resolver.resolve("smart")).toBe("openai:o1");
  });

  it("resolves ModelConfig objects with params", () => {
    const resolver = new ModelRoleResolver({
      smart: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        temperature: 0.5,
        maxTokens: 4096,
      },
    });
    const spec = resolver.resolveSpec("smart");
    expect(spec).not.toBeNull();
    expect(spec!.modelId).toBe("anthropic:claude-opus-4-6");
    expect(spec!.params).toEqual({
      temperature: 0.5,
      maxTokens: 4096,
    });
  });
});

describe("createModelRoleResolver", () => {
  it("creates a resolver with the given config", () => {
    const resolver = createModelRoleResolver({ smart: "openai:gpt-4o" });
    expect(resolver.resolve("smart")).toBe("openai:gpt-4o");
  });

  it("creates a resolver with defaults when no config is provided", () => {
    const resolver = createModelRoleResolver();
    expect(resolver.resolve("smart")).toBe("anthropic:claude-opus-4-6");
  });
});

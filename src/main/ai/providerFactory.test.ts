/**
 * Tests for providerFactory.ts — pure utility functions.
 */

import {
  findExecutable,
  isSupportedProvider,
  getSupportedProviders,
  getProviderEnvVars,
  getProviderDisplayName,
  hasProviderApiKey,
  usesCliAuth,
  getDefaultModelsForProvider,
} from "./providerFactory.js";
import type { SupportedProvider } from "../workspace/types.js";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// Avoid pulling in heavy workspace loader / electron paths
vi.mock("../paths.js", () => ({
  getActiveWorkspace: vi.fn().mockReturnValue(undefined),
}));

import { execSync } from "child_process";

describe("providerFactory", () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  // -------------------------------------------------------------------------
  // isSupportedProvider
  // -------------------------------------------------------------------------
  describe("isSupportedProvider", () => {
    it("returns true for known providers", () => {
      expect(isSupportedProvider("anthropic")).toBe(true);
      expect(isSupportedProvider("openai")).toBe(true);
      expect(isSupportedProvider("google")).toBe(true);
      expect(isSupportedProvider("groq")).toBe(true);
      expect(isSupportedProvider("claude-code")).toBe(true);
      expect(isSupportedProvider("codex-cli")).toBe(true);
    });

    it("returns false for unknown provider ids", () => {
      expect(isSupportedProvider("unknown")).toBe(false);
      expect(isSupportedProvider("")).toBe(false);
      expect(isSupportedProvider("ANTHROPIC")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getSupportedProviders
  // -------------------------------------------------------------------------
  describe("getSupportedProviders", () => {
    it("returns an array containing all expected provider ids", () => {
      const providers = getSupportedProviders();
      expect(Array.isArray(providers)).toBe(true);
      expect(providers).toContain("anthropic");
      expect(providers).toContain("openai");
      expect(providers).toContain("google");
      expect(providers).toContain("groq");
      expect(providers).toContain("openrouter");
      expect(providers).toContain("mistral");
      expect(providers).toContain("together");
      expect(providers).toContain("replicate");
      expect(providers).toContain("perplexity");
      expect(providers).toContain("claude-code");
      expect(providers).toContain("codex-cli");
    });
  });

  // -------------------------------------------------------------------------
  // getProviderDisplayName
  // -------------------------------------------------------------------------
  describe("getProviderDisplayName", () => {
    it("returns correct display names for providers", () => {
      expect(getProviderDisplayName("anthropic")).toBe("Anthropic");
      expect(getProviderDisplayName("openai")).toBe("OpenAI");
      expect(getProviderDisplayName("google")).toBe("Google");
      expect(getProviderDisplayName("groq")).toBe("Groq");
      expect(getProviderDisplayName("openrouter")).toBe("OpenRouter");
      expect(getProviderDisplayName("mistral")).toBe("Mistral");
      expect(getProviderDisplayName("together")).toBe("Together AI");
      expect(getProviderDisplayName("replicate")).toBe("Replicate");
      expect(getProviderDisplayName("perplexity")).toBe("Perplexity");
      expect(getProviderDisplayName("claude-code")).toBe("Claude Code");
      expect(getProviderDisplayName("codex-cli")).toBe("Codex CLI");
    });
  });

  // -------------------------------------------------------------------------
  // hasProviderApiKey
  // -------------------------------------------------------------------------
  describe("hasProviderApiKey", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore env
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
    });

    it("returns true when the provider env var is set", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test-123";
      expect(hasProviderApiKey("anthropic")).toBe(true);
    });

    it("returns false when the provider env var is not set", () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(hasProviderApiKey("anthropic")).toBe(false);
    });

    it("returns false for CLI-auth providers (empty env var name)", () => {
      // claude-code and codex-cli have empty string env vars,
      // so process.env[""] is always undefined
      expect(hasProviderApiKey("claude-code")).toBe(false);
      expect(hasProviderApiKey("codex-cli")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // usesCliAuth
  // -------------------------------------------------------------------------
  describe("usesCliAuth", () => {
    it("returns true for claude-code and codex-cli", () => {
      expect(usesCliAuth("claude-code")).toBe(true);
      expect(usesCliAuth("codex-cli")).toBe(true);
    });

    it("returns false for API-key providers", () => {
      expect(usesCliAuth("anthropic")).toBe(false);
      expect(usesCliAuth("openai")).toBe(false);
      expect(usesCliAuth("google")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getDefaultModelsForProvider
  // -------------------------------------------------------------------------
  describe("getDefaultModelsForProvider", () => {
    it("returns non-empty model arrays for known providers", () => {
      const knownProviders: SupportedProvider[] = [
        "anthropic", "openai", "google", "groq", "openrouter",
        "mistral", "together", "replicate", "perplexity", "claude-code", "codex-cli",
      ];
      for (const id of knownProviders) {
        const models = getDefaultModelsForProvider(id);
        expect(models.length).toBeGreaterThan(0);
        // Every model should have an id and displayName
        for (const m of models) {
          expect(typeof m.id).toBe("string");
          expect(typeof m.displayName).toBe("string");
        }
      }
    });

    it("returns empty array for unknown provider", () => {
      // Cast to bypass type check — we want runtime behavior for unknown id
      const models = getDefaultModelsForProvider("nonexistent" as SupportedProvider);
      expect(models).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getProviderEnvVars
  // -------------------------------------------------------------------------
  describe("getProviderEnvVars", () => {
    it("returns a mapping containing expected env var names", () => {
      const envVars = getProviderEnvVars();
      expect(envVars.anthropic).toBe("ANTHROPIC_API_KEY");
      expect(envVars.openai).toBe("OPENAI_API_KEY");
      expect(envVars.google).toBe("GOOGLE_API_KEY");
      expect(envVars.groq).toBe("GROQ_API_KEY");
      expect(envVars.openrouter).toBe("OPENROUTER_API_KEY");
      expect(envVars.mistral).toBe("MISTRAL_API_KEY");
      expect(envVars.together).toBe("TOGETHER_API_KEY");
      expect(envVars.replicate).toBe("REPLICATE_API_KEY");
      expect(envVars.perplexity).toBe("PERPLEXITY_API_KEY");
      // CLI-auth providers have empty string env var
      expect(envVars["claude-code"]).toBe("");
      expect(envVars["codex-cli"]).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // findExecutable
  // -------------------------------------------------------------------------
  describe("findExecutable", () => {
    it("returns the trimmed path when the command succeeds", () => {
      vi.mocked(execSync).mockReturnValue("/usr/bin/claude\n");
      const result = findExecutable("claude");
      expect(result).toBe("/usr/bin/claude");
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("claude"),
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });

    it("returns the first line when multiple paths are returned (Windows where)", () => {
      vi.mocked(execSync).mockReturnValue("C:\\Program Files\\claude.exe\r\nC:\\Users\\bin\\claude.exe\r\n");
      const result = findExecutable("claude");
      expect(result).toBe("C:\\Program Files\\claude.exe");
    });

    it("returns undefined when the command throws (not found)", () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("not found");
      });
      const result = findExecutable("nonexistent");
      expect(result).toBeUndefined();
    });
  });
});

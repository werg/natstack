import { describe, expect, it, vi } from "vitest";
import { createAuthService } from "../authService.js";

describe("main authService", () => {
  it("maps server provider status into the renderer-facing auth provider shape", async () => {
    const call = vi.fn(async (service: string, method: string) => {
      expect(service).toBe("auth");
      expect(method).toBe("listProviders");
      return [
        {
          provider: "openai-codex",
          displayName: "OpenAI Codex",
          kind: "oauth",
          status: "connected",
        },
        {
          provider: "anthropic",
          displayName: "Anthropic",
          kind: "env-var",
          status: "missing",
          envVar: "ANTHROPIC_API_KEY",
        },
      ];
    });

    const service = createAuthService({
      serverClient: { call } as never,
    });

    const providers = await service.handler(
      { callerId: "shell", callerKind: "shell" },
      "listProviders",
      [],
    );

    expect(providers).toEqual([
      {
        id: "openai-codex",
        name: "OpenAI Codex",
        kind: "oauth",
        status: "connected",
      },
      {
        id: "anthropic",
        name: "Anthropic",
        kind: "env",
        status: "unconfigured",
        envVar: "ANTHROPIC_API_KEY",
      },
    ]);
  });

  it("rethrows OAuth login failures so the renderer can surface them", async () => {
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "auth" && method === "startOAuthLogin") {
        return {
          flowId: "flow-123",
          authUrl: "https://example.test/authorize",
        };
      }
      throw new Error(`Unexpected call: ${service}.${method}`);
    });
    const openBrowser = vi.fn(async () => {
      throw new Error("browser failed");
    });

    const service = createAuthService({
      serverClient: { call } as never,
      openBrowser,
    });

    await expect(
      service.handler(
        { callerId: "shell", callerKind: "shell" },
        "startOAuthLogin",
        ["openai-codex"],
      ),
    ).rejects.toThrow("browser failed");
  });
});

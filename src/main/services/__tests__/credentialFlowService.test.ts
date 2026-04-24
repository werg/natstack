import { describe, expect, it, vi } from "vitest";
import { createCredentialFlowService } from "../credentialFlowService.js";

describe("main credentialFlowService", () => {
  it("maps server provider status into the renderer-facing provider shape", async () => {
    const call = vi.fn(async (service: string, method: string) => {
      expect(service).toBe("credentials");
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
        {
          provider: "github",
          displayName: "GitHub",
          kind: "oauth",
          status: "connected",
        },
      ];
    });

    const service = createCredentialFlowService({
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

  it("returns a failed connect result when the browser launch fails", async () => {
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "credentials" && method === "beginConsent") {
        return {
          nonce: "flow-123",
          authorizeUrl: "https://example.test/authorize",
        };
      }
      throw new Error(`Unexpected call: ${service}.${method}`);
    });
    const openBrowser = vi.fn(async () => {
      throw new Error("browser failed");
    });

    const service = createCredentialFlowService({
      serverClient: { call } as never,
      openBrowser,
    });

    await expect(
      service.handler(
        { callerId: "shell", callerKind: "shell" },
        "connect",
        ["openai-codex"],
      ),
    ).resolves.toEqual({
      success: false,
      error: "browser failed",
    });
  });

  it("completes the Codex loopback flow using the expected callback path", async () => {
    let redirectUri = "";
    const call = vi.fn(async (service: string, method: string, args: unknown[]) => {
      if (service !== "credentials") {
        throw new Error(`Unexpected service: ${service}`);
      }

      if (method === "beginConsent") {
        const params = args[0] as { redirectUri: string };
        redirectUri = params.redirectUri;
        return {
          nonce: "flow-123",
          authorizeUrl: "https://example.test/authorize",
        };
      }

      if (method === "completeConsent") {
        expect(args[0]).toEqual({ nonce: "flow-123", code: "callback-code" });
        return { connectionId: "conn-1", apiBase: ["https://api.openai.com"] };
      }

      throw new Error(`Unexpected call: ${service}.${method}`);
    });

    const service = createCredentialFlowService({
      serverClient: { call } as never,
      resolveLoopbackBinding: (providerId) => {
        expect(providerId).toBe("openai-codex");
        return {
          host: "127.0.0.1",
          port: 0,
          callbackPath: "/auth/callback",
        };
      },
      openBrowser: async () => {
        expect(redirectUri).toContain("/auth/callback");
        const response = await fetch(`${redirectUri}?code=callback-code`);
        expect(response.status).toBe(200);
      },
    });

    await expect(
      service.handler(
        { callerId: "shell", callerKind: "shell" },
        "connect",
        ["openai-codex"],
      ),
    ).resolves.toEqual({ success: true });
  });
});

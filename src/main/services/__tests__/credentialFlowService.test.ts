import { describe, expect, it, vi } from "vitest";
import { createCredentialFlowService } from "../credentialFlowService.js";

const codexProvider = {
  id: "openai-codex",
  displayName: "ChatGPT",
  apiBase: ["https://api.openai.com", "https://chatgpt.com/backend-api"],
  flows: [
    {
      type: "loopback-pkce",
      clientId: "client-id",
      authorizeUrl: "https://example.test/authorize",
      tokenUrl: "https://example.test/token",
      loopback: { host: "127.0.0.1", port: 0, callbackPath: "/auth/callback" },
    },
  ],
};

describe("main credentialFlowService", () => {
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
        [codexProvider],
      ),
    ).resolves.toEqual({
      success: false,
      error: "browser failed",
    });
  });

  it("completes the provider-supplied loopback flow using the expected callback path", async () => {
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
        [codexProvider],
      ),
    ).resolves.toEqual({ success: true });
  });
});

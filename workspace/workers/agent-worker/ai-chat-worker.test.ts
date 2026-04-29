import { describe, expect, it } from "vitest";

import { createTestDO } from "@workspace/runtime/worker/test-utils";

import { AiChatWorker } from "./ai-chat-worker.js";

class TestAiChatWorker extends AiChatWorker {
  model(): string {
    return this.getModel();
  }

  setupProps(providerId: string): Record<string, unknown> | null {
    return this.getModelCredentialSetupProps(providerId);
  }

  tokenClaims(providerId: string, providerUserId: string): Record<string, unknown> {
    return this.getModelCredentialTokenClaims(providerId, {
      id: "cred-1",
      accountIdentity: { providerUserId },
    });
  }
}

describe("AiChatWorker model credential defaults", () => {
  it("wires the default OpenAI Codex model through URL-bound credential OAuth setup", async () => {
    const { instance } = await createTestDO(TestAiChatWorker);
    const worker = instance as TestAiChatWorker;

    expect(worker.model()).toBe("openai-codex:gpt-5.5");

    const setup = worker.setupProps("openai-codex");
    expect(setup).toMatchObject({
      credentialLabel: "ChatGPT Codex model credential",
      accountIdentityJwtClaimRoot: "https://api.openai.com/auth",
      accountIdentityJwtClaimField: "chatgpt_account_id",
      loopback: {
        host: "localhost",
        port: 1455,
        callbackPath: "/auth/callback",
      },
      oauth: {
        authorizeUrl: "https://auth.openai.com/oauth/authorize",
        tokenUrl: "https://auth.openai.com/oauth/token",
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        scopes: ["openid", "profile", "email", "offline_access"],
      },
    });

    expect(worker.tokenClaims("openai-codex", "acct-1")).toEqual({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    });
    expect(worker.setupProps("other-provider")).toBeNull();
    expect(worker.tokenClaims("other-provider", "acct-1")).toEqual({});
  });
});

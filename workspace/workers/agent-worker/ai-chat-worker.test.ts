import { describe, expect, it, vi } from "vitest";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { TurnSnapshot } from "@natstack/harness";
import { AgentWorkerBase } from "@workspace/agentic-do";

import { AiChatWorker } from "./ai-chat-worker.js";

type AgentSettingsResult = {
  model: { value: string; source: string };
  thinkingLevel: { value: string; source: string };
  approvalLevel: { value: number; source: string };
  respondPolicy: { value: string; source: string };
  respondFrom: { value: string[]; source: string };
};

class TestAiChatWorker extends AiChatWorker {
  rpcCall = vi.fn(async () => ({ id: "cred-1" }));

  protected override get rpc(): never {
    return { call: this.rpcCall } as never;
  }

  protected override async refreshRoster(_channelId: string): Promise<void> {
    // Keep tests focused on settings behavior.
  }

  model(): string {
    return this.getModel("ch-1");
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

  modelBaseUrl(): string {
    return (this as unknown as { getModelBaseUrl(channelId: string): string }).getModelBaseUrl(
      "ch-1"
    );
  }

  prepare(channelId: string, snapshot: TurnSnapshot): Promise<TurnSnapshot | void> {
    return this.prepareNextTurnHook(channelId, snapshot);
  }

  insertSubscriptionConfig(channelId: string, config: Record<string, unknown>): void {
    (
      this as unknown as {
        sql: {
          exec: (query: string, ...params: unknown[]) => unknown;
        };
      }
    ).sql.exec(
      `INSERT OR REPLACE INTO subscriptions (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      Date.now(),
      JSON.stringify(config),
      `participant:${channelId}`
    );
  }
}

class ApiKeyAiChatWorker extends TestAiChatWorker {
  protected override getModelCredentialSetupProps(
    providerId: string
  ): Record<string, unknown> | null {
    if (providerId !== "openai-codex") return null;
    return {
      credentialLabel: "Test API key",
      flow: {
        type: "api-key",
        title: "Test API key",
        fields: [{ name: "apiKey", label: "API key", type: "secret", required: true }],
        materialTemplate: {
          type: "bearer-token",
          valueTemplate: "{apiKey}",
        },
      },
      credential: {
        injection: {
          type: "header",
          name: "x-api-key",
          valueTemplate: "{apiKey}",
        },
      },
    };
  }
}

describe("AiChatWorker model credential defaults", () => {
  it("inherits the base agent schema version so base-table migrations run", () => {
    expect(AiChatWorker.schemaVersion).toBe(AgentWorkerBase.schemaVersion);
  });

  it("wires the default OpenAI Codex model through URL-bound credential OAuth setup", async () => {
    const { instance } = await createTestDO(TestAiChatWorker);
    const worker = instance as TestAiChatWorker;

    expect(worker.model()).toBe("openai-codex:gpt-5.5");
    expect(worker.modelBaseUrl()).toBe("https://chatgpt.com/backend-api");

    const setup = worker.setupProps("openai-codex");
    expect(setup).toMatchObject({
      credentialLabel: "ChatGPT Codex model credential",
      accountIdentityJwtClaimRoot: "https://api.openai.com/auth",
      accountIdentityJwtClaimField: "chatgpt_account_id",
      redirectPolicy: "loopback-required",
      redirect: {
        type: "loopback",
        host: "localhost",
        port: 1455,
        callbackPath: "/auth/callback",
      },
      clientLoopbackRedirect: {
        type: "client-loopback",
        host: "localhost",
        port: 1455,
        callbackPath: "/auth/callback",
      },
      flow: {
        type: "oauth2-auth-code-pkce",
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

    await worker.onMethodCall("ch-1", "call-1", "connectModelCredential", {
      providerId: "openai-codex",
      browserOpenMode: "external",
      browserHandoffCallerId: "panel-1",
      browserHandoffCallerKind: "panel",
    });
    expect(worker.rpcCall).toHaveBeenCalledWith("main", "credentials.connect", [
      expect.objectContaining({
        spec: expect.objectContaining({
          browser: "external",
          flow: expect.objectContaining({
            type: "oauth2-auth-code-pkce",
          }),
          credential: expect.objectContaining({
            audience: [{ url: "https://chatgpt.com/backend-api", match: "path-prefix" }],
          }),
          redirect: {
            type: "client-loopback",
            host: "localhost",
            port: 1455,
            callbackPath: "/auth/callback",
          },
        }),
        handoffTarget: {
          callerId: "panel-1",
          callerKind: "panel",
        },
      }),
    ]);

    await worker.onMethodCall("ch-1", "call-internal", "connectModelCredential", {
      providerId: "openai-codex",
      browserOpenMode: "internal",
      browserHandoffCallerId: "panel-1",
      browserHandoffCallerKind: "panel",
    });
    expect(worker.rpcCall).toHaveBeenLastCalledWith("main", "credentials.connect", [
      expect.objectContaining({
        spec: expect.objectContaining({
          browser: "internal",
          redirect: {
            type: "loopback",
            host: "localhost",
            port: 1455,
            callbackPath: "/auth/callback",
          },
        }),
      }),
    ]);

    await worker.onMethodCall("ch-1", "call-2", "connectModelCredential", {
      providerId: "openai-codex",
      browserOpenMode: "external",
      browserHandoffCallerId: "panel-1",
      browserHandoffCallerKind: "panel",
      browserHandoffPlatform: "mobile",
    });
    expect(worker.rpcCall).toHaveBeenLastCalledWith("main", "credentials.connect", [
      expect.objectContaining({
        spec: expect.objectContaining({
          redirect: {
            type: "client-loopback",
            host: "localhost",
            port: 1455,
            callbackPath: "/auth/callback",
          },
        }),
      }),
    ]);
  });

  it("passes API-key credential specs through credentials.connect", async () => {
    const { instance } = await createTestDO(ApiKeyAiChatWorker);
    const worker = instance as ApiKeyAiChatWorker;

    await worker.onMethodCall("ch-1", "call-api-key", "connectModelCredential", {
      providerId: "openai-codex",
    });

    expect(worker.rpcCall).toHaveBeenCalledWith("main", "credentials.connect", [
      expect.objectContaining({
        flow: {
          type: "api-key",
          title: "Test API key",
          fields: [{ name: "apiKey", label: "API key", type: "secret", required: true }],
          materialTemplate: {
            type: "bearer-token",
            valueTemplate: "{apiKey}",
          },
        },
        credential: expect.objectContaining({
          label: "Test API key",
          audience: [{ url: "https://chatgpt.com/backend-api", match: "path-prefix" }],
          injection: {
            type: "header",
            name: "x-api-key",
            valueTemplate: "{apiKey}",
          },
          metadata: expect.objectContaining({
            modelProviderId: "openai-codex",
          }),
        }),
      }),
    ]);
  });

  it("reports effective live settings with default, config, and state provenance", async () => {
    const { instance } = await createTestDO(TestAiChatWorker);
    const worker = instance as TestAiChatWorker;

    expect(
      (await worker.onMethodCall("ch-1", "call-default", "getAgentSettings", {})).result
    ).toMatchObject({
      model: { value: "openai-codex:gpt-5.5", source: "default" },
      thinkingLevel: { value: "medium", source: "default" },
      approvalLevel: { value: 2, source: "default" },
      respondPolicy: { value: "all", source: "default" },
      respondFrom: { value: [], source: "default" },
    });

    worker.insertSubscriptionConfig("ch-config", {
      model: "openai-codex:gpt-5.5",
      thinkingLevel: "low",
      approvalLevel: 1,
      respondPolicy: "from-participants",
      respondFrom: ["user-1"],
    });

    expect(
      (await worker.onMethodCall("ch-config", "call-config", "getAgentSettings", {})).result
    ).toMatchObject({
      model: { value: "openai-codex:gpt-5.5", source: "config" },
      thinkingLevel: { value: "low", source: "config" },
      approvalLevel: { value: 1, source: "config" },
      respondPolicy: { value: "from-participants", source: "config" },
      respondFrom: { value: ["user-1"], source: "config" },
    });

    await worker.onMethodCall("ch-config", "call-thinking", "setThinkingLevel", { level: "high" });
    await worker.onMethodCall("ch-config", "call-approval", "setApprovalLevel", { level: 0 });
    await worker.onMethodCall("ch-config", "call-policy", "setRespondPolicy", {
      policy: "mentioned",
    });

    const settings = (await worker.onMethodCall("ch-config", "call-state", "getAgentSettings", {}))
      .result as AgentSettingsResult;
    expect(settings).toMatchObject({
      model: { value: "openai-codex:gpt-5.5", source: "config" },
      thinkingLevel: { value: "high", source: "state" },
      approvalLevel: { value: 0, source: "state" },
      respondPolicy: { value: "mentioned", source: "state" },
      respondFrom: { value: [], source: "state" },
    });
  });

  it("re-reads live settings during prepareNextTurnHook", async () => {
    const { instance } = await createTestDO(TestAiChatWorker);
    const worker = instance as TestAiChatWorker;
    const snapshot = {
      sessionLeafId: null,
      messages: [],
      systemPrompt: "",
      model: {},
      thinkingLevel: "medium",
      tools: [],
      activeToolNames: new Set<string>(),
    } as unknown as TurnSnapshot;

    expect(await worker.prepare("ch-1", snapshot)).toBeUndefined();

    await worker.onMethodCall("ch-1", "call-thinking", "setThinkingLevel", { level: "high" });
    await expect(worker.prepare("ch-1", snapshot)).resolves.toBeUndefined();
    expect(
      (await worker.onMethodCall("ch-1", "call-settings", "getAgentSettings", {})).result
    ).toMatchObject({
      thinkingLevel: { value: "high", source: "state" },
    });
  });
});

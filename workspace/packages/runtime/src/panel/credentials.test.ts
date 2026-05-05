import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RpcCaller } from "@natstack/rpc";
import type { StoredCredentialSummary } from "../shared/credentials.js";

const mocks = vi.hoisted(() => ({
  createLoopbackCallback: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock("./oauth.js", () => ({
  createLoopbackCallback: mocks.createLoopbackCallback,
}));

vi.mock("./browser.js", () => ({
  openExternal: mocks.openExternal,
}));

import { connectWithOAuthPkce, initPanelCredentials } from "./credentials.js";

const storedCredential: StoredCredentialSummary = {
  id: "cred-1",
  label: "Example",
  accountIdentity: { providerUserId: "user-1" },
  audience: [{ url: "https://api.example.com/", match: "origin" }],
  injection: {
    type: "header",
    name: "authorization",
    valueTemplate: "Bearer {token}",
  },
  scopes: ["scope-1"],
  metadata: {},
};

describe("panel credential OAuth helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createLoopbackCallback.mockResolvedValue({
      redirectUri: "http://127.0.0.1:12345/oauth/callback",
      expectState: vi.fn().mockResolvedValue(undefined),
      waitForCallback: vi.fn().mockResolvedValue({
        code: "code-1",
        state: "state-1",
        url: "http://127.0.0.1:12345/oauth/callback?code=code-1&state=state-1",
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });
    mocks.openExternal.mockResolvedValue({ approvalDecision: "session" });
  });

  it("owns the full browser-backed PKCE credential flow", async () => {
    const callMock = vi.fn(async (_targetId: string, method: string, ...args: unknown[]): Promise<unknown> => {
      if (method === "credentials.beginCreateWithOAuthPkce") {
        return {
          nonce: "nonce-1",
          state: "state-1",
          authorizeUrl: "https://auth.example.com/oauth/authorize?state=state-1",
        };
      }
      if (method === "credentials.completeCreateWithOAuthPkce") {
        return storedCredential;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const rpc = {
      call: callMock as RpcCaller["call"],
    } satisfies RpcCaller;
    initPanelCredentials(rpc);

    await expect(connectWithOAuthPkce({
      oauth: {
        authorizeUrl: "https://auth.example.com/oauth/authorize",
        tokenUrl: "https://auth.example.com/oauth/token",
        clientId: "client-1",
        scopes: ["scope-1"],
      },
      credential: {
        label: "Example",
        audience: [{ url: "https://api.example.com/", match: "origin" }],
        injection: {
          type: "header",
          name: "authorization",
          valueTemplate: "Bearer {token}",
        },
        scopes: ["scope-1"],
      },
    })).resolves.toEqual(storedCredential);

    expect(mocks.createLoopbackCallback).toHaveBeenCalledWith(undefined);
    const callback = await mocks.createLoopbackCallback.mock.results[0]?.value;
    expect(callback.expectState).toHaveBeenCalledWith("state-1");
    expect(mocks.openExternal).toHaveBeenCalledWith(
      "https://auth.example.com/oauth/authorize?state=state-1",
      { expectedRedirectUri: "http://127.0.0.1:12345/oauth/callback" },
    );
    expect(callMock).toHaveBeenCalledWith(
      "main",
      "credentials.beginCreateWithOAuthPkce",
      expect.objectContaining({ redirectUri: "http://127.0.0.1:12345/oauth/callback" }),
    );
    expect(callMock).toHaveBeenCalledWith("main", "credentials.completeCreateWithOAuthPkce", {
      nonce: "nonce-1",
      code: "code-1",
      state: "state-1",
      approvalDecision: "session",
    });
    expect(callback.close).toHaveBeenCalled();
  });
});

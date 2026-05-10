import { Linking } from "react-native";
import { consumePendingFlow } from "./authCallbackRegistry";
import {
  buildMobileOAuthRedirectUri,
  connectMobileOAuthCredential,
  waitForMobileOAuthCode,
} from "./mobileCredentialOAuth";

const mockOpenURL = jest.fn(() => Promise.resolve());

beforeEach(() => {
  (Linking as unknown as { openURL: typeof mockOpenURL }).openURL = mockOpenURL;
});

afterEach(() => {
  jest.useRealTimers();
  mockOpenURL.mockClear();
});

describe("mobileCredentialOAuth", () => {
  it("builds snugenv universal-link redirect URIs", () => {
    expect(buildMobileOAuthRedirectUri("openai-codex")).toBe(
      "https://auth.snugenv.com/oauth/callback/openai-codex",
    );
    expect(() => buildMobileOAuthRedirectUri("../bad")).toThrow(/Invalid OAuth provider id/);
  });

  it("waits for the deep-link callback matching the OAuth state", async () => {
    jest.useFakeTimers();
    const authorizeUrl = "https://auth.example.test/oauth?state=state-1";
    const pending = waitForMobileOAuthCode(authorizeUrl, "state-1");

    expect(mockOpenURL).toHaveBeenCalledWith(authorizeUrl);
    const entry = consumePendingFlow("state-1");
    expect(entry).toBeTruthy();
    entry!.resolve({ code: "code-1", state: "state-1" });

    await expect(pending).resolves.toBe("code-1");
  });

  it("rejects authorize URLs that do not carry the expected state", async () => {
    await expect(
      waitForMobileOAuthCode("https://auth.example.test/oauth?state=wrong", "state-1", 1),
    ).rejects.toThrow(/OAuth state mismatch/);
    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  it("delegates credential OAuth connection to the server with public redirect by default", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const shellClient = {
      transport: {
        call: jest.fn(async (_target: string, method: string, ...args: unknown[]) => {
          calls.push({ method, args });
          if (method === "credentials.connect") {
            return { id: "cred-1" };
          }
          throw new Error(`unexpected method: ${method}`);
        }),
      },
    };

    await expect(connectMobileOAuthCredential(shellClient as never, {
      providerId: "example",
      flow: {
        type: "oauth2-auth-code-pkce",
        authorizeUrl: "https://auth.example.test/oauth",
        tokenUrl: "https://auth.example.test/token",
        clientId: "client",
      },
      credential: {
        label: "Example",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: {
          type: "header",
          name: "Authorization",
          valueTemplate: "Bearer {token}",
        },
      },
    })).resolves.toEqual({ id: "cred-1" });
    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({
      method: "credentials.connect",
      args: [expect.objectContaining({
        flow: expect.objectContaining({ clientId: "client" }),
        browser: "external",
        redirect: { type: "public" },
      })],
    });
  });

  it("opts into client-forwarded redirect when callbackOrigin is supplied", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const shellClient = {
      transport: {
        call: jest.fn(async (_target: string, method: string, ...args: unknown[]) => {
          calls.push({ method, args });
          if (method === "credentials.connect") {
            return { id: "cred-1" };
          }
          throw new Error(`unexpected method: ${method}`);
        }),
      },
    };

    await connectMobileOAuthCredential(shellClient as never, {
      providerId: "example",
      callbackOrigin: "https://auth.snugenv.com",
      flow: {
        type: "oauth2-auth-code-pkce",
        authorizeUrl: "https://auth.example.test/oauth",
        tokenUrl: "https://auth.example.test/token",
        clientId: "client",
      },
      credential: {
        label: "Example",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: {
          type: "header",
          name: "Authorization",
          valueTemplate: "Bearer {token}",
        },
      },
    });
    expect(calls[0]).toMatchObject({
      args: [expect.objectContaining({
        redirect: {
          type: "client-forwarded",
          callbackUri: "https://auth.snugenv.com/oauth/callback/example",
        },
      })],
    });
  });
});

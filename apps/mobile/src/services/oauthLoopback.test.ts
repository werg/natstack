import { Linking, NativeModules } from "react-native";
import { handleExternalOpen } from "./oauthLoopback";

const mockOpenURL = jest.fn(async () => undefined);
const mockStart = jest.fn(async () => undefined);
const mockWait = jest.fn(async () => ({
  url: "http://localhost:1455/auth/callback?code=code-1&state=state-1",
  code: "code-1",
  state: "state-1",
}));
const mockStop = jest.fn(async () => undefined);
const mockCall = jest.fn(async () => undefined);

beforeEach(() => {
  (Linking as unknown as { openURL: typeof mockOpenURL }).openURL = mockOpenURL;
  (NativeModules as unknown as { OAuthLoopback: unknown }).OAuthLoopback = {
    start: mockStart,
    wait: mockWait,
    stop: mockStop,
  };
  mockOpenURL.mockClear();
  mockStart.mockClear();
  mockWait.mockClear();
  mockStop.mockClear();
  mockCall.mockClear();
});

describe("oauthLoopback", () => {
  it("opens ordinary external URLs directly", async () => {
    await handleExternalOpen({ transport: { call: mockCall } } as never, {
      url: "https://example.test/",
    });

    expect(mockOpenURL).toHaveBeenCalledWith("https://example.test/");
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("rejects OpenAI public-callback OAuth handoffs on mobile", async () => {
    await expect(handleExternalOpen({ transport: { call: mockCall } } as never, {
      url: "https://auth.openai.com/oauth/authorize?redirect_uri=https%3A%2F%2Fexample.test%2F_r%2Fs%2Fcredentials%2Foauth%2Fcallback",
    })).rejects.toThrow(/Android loopback callback/);

    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("starts loopback listener before opening OAuth URL and forwards callback", async () => {
    const order: string[] = [];
    mockStart.mockImplementation(async () => {
      order.push("start");
    });
    mockOpenURL.mockImplementation(async () => {
      order.push("open");
    });
    mockWait.mockImplementation(async () => {
      order.push("wait");
      return {
        url: "http://localhost:1455/auth/callback?code=code-1&state=state-1",
        code: "code-1",
        state: "state-1",
      };
    });
    mockCall.mockImplementation(async () => {
      order.push("forward");
    });

    await handleExternalOpen({ transport: { call: mockCall } } as never, {
      url: "https://auth.example.test/oauth",
      oauthLoopback: {
        transactionId: "tx-1",
        redirectUri: "http://localhost:1455/auth/callback",
        host: "localhost",
        port: 1455,
        callbackPath: "/auth/callback",
        state: "state-1",
        timeoutMs: 60_000,
      },
    });

    expect(order).toEqual(["start", "wait", "open", "forward"]);
    expect(mockStart).toHaveBeenCalledWith({
      host: "localhost",
      port: 1455,
      callbackPath: "/auth/callback",
      expectedState: "state-1",
      timeoutMs: 60_000,
    });
    expect(mockCall).toHaveBeenCalledWith("main", "credentials.forwardOAuthCallback", {
      transactionId: "tx-1",
      url: "http://localhost:1455/auth/callback?code=code-1&state=state-1",
      state: "state-1",
    });
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("stops listener when browser open fails", async () => {
    mockOpenURL.mockRejectedValueOnce(new Error("browser unavailable"));

    await expect(handleExternalOpen({ transport: { call: mockCall } } as never, {
      url: "https://auth.example.test/oauth",
      oauthLoopback: {
        transactionId: "tx-1",
        redirectUri: "http://localhost:1455/auth/callback",
        host: "localhost",
        port: 1455,
        callbackPath: "/auth/callback",
        state: "state-1",
        timeoutMs: 60_000,
      },
    })).rejects.toThrow(/browser unavailable/);

    expect(mockStop).toHaveBeenCalled();
    expect(mockCall).not.toHaveBeenCalled();
  });
});

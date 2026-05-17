import { describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { handleExternalOpenPayload } from "./oauthLoopbackHandoff.js";

describe("handleExternalOpenPayload", () => {
  it("opens plain external URLs without starting an OAuth callback", async () => {
    const openExternal = vi.fn(async () => undefined);
    const forwardOAuthCallback = vi.fn(async () => undefined);

    await handleExternalOpenPayload(
      { url: "https://example.test/path" },
      {
        openExternal,
        forwardOAuthCallback,
      }
    );

    expect(openExternal).toHaveBeenCalledWith("https://example.test/path");
    expect(forwardOAuthCallback).not.toHaveBeenCalled();
  });

  it("forwards client-loopback OAuth callbacks after opening the browser", async () => {
    const port = await getFreePort();
    const openExternal = vi.fn(async () => {
      setImmediate(() => {
        void httpGet(`http://127.0.0.1:${port}/auth/callback?code=code-1&state=state-1`);
      });
    });
    const forwardOAuthCallback = vi.fn(async () => undefined);

    await handleExternalOpenPayload(
      {
        url: "https://auth.example.test/oauth/authorize",
        oauthLoopback: {
          transactionId: "tx-1",
          redirectUri: `http://127.0.0.1:${port}/auth/callback`,
          host: "127.0.0.1",
          port,
          callbackPath: "/auth/callback",
          state: "state-1",
          timeoutMs: 5_000,
        },
      },
      {
        openExternal,
        forwardOAuthCallback,
      }
    );

    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/oauth/authorize");
    expect(forwardOAuthCallback).toHaveBeenCalledWith({
      transactionId: "tx-1",
      url: `http://127.0.0.1:${port}/auth/callback?code=code-1&state=state-1`,
      state: "state-1",
    });
  });
});

async function getFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function httpGet(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on("end", resolve);
      })
      .on("error", reject);
  });
}

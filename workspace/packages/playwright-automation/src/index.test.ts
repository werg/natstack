import { beforeEach, describe, expect, it, vi } from "vitest";

const connect = vi.hoisted(() => vi.fn());

vi.mock("@workspace/playwright-core", () => ({
  BrowserImpl: { connect },
}));

describe("@workspace/playwright-automation", () => {
  beforeEach(() => {
    connect.mockReset();
  });

  it("connects full Playwright from a panel CDP endpoint", async () => {
    const page = { marker: "page" };
    connect.mockResolvedValue({
      contexts: () => [{ pages: () => [page] }],
    });
    const { playwrightPage } = await import("./index.js");

    await expect(
      playwrightPage({
        cdp: {
          getCdpEndpoint: async () => ({
            wsEndpoint: "ws://server/cdp/panel-1",
            token: "token-1",
          }),
        },
      })
    ).resolves.toBe(page);

    expect(connect).toHaveBeenCalledWith("ws://server/cdp/panel-1", {
      isElectronWebview: true,
      transportOptions: { authToken: "token-1" },
    });
  });

  it("throws a clear error when the CDP target has no page", async () => {
    connect.mockResolvedValue({
      contexts: () => [{ pages: () => [] }],
    });
    const { playwrightPage } = await import("./index.js");

    await expect(
      playwrightPage({
        cdp: {
          getCdpEndpoint: async () => ({ wsEndpoint: "ws://server/cdp/panel-1" }),
        },
      })
    ).rejects.toThrow("No page found in panel CDP target");
  });
});

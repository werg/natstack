import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  consumeConnectLinkReplay,
  isConnectLinkForStoredServer,
  markConnectLinkConsumed,
} from "./connectLinkReplayGuard";

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

describe("connectLinkReplayGuard", () => {
  beforeEach(() => {
    storage.getItem.mockReset();
    storage.setItem.mockReset();
    storage.removeItem.mockReset();
  });

  it("suppresses a consumed connect link once", async () => {
    const rawUrl =
      "natstack://connect?url=https%3A%2F%2Fhost.tailnet.ts.net&code=abc123abc123abc123";

    await markConnectLinkConsumed(rawUrl, 1_000);
    expect(storage.setItem).toHaveBeenCalledWith(
      "natstack:connect:consumed-url",
      JSON.stringify({ url: rawUrl, consumedAt: 1_000 })
    );

    storage.getItem.mockResolvedValueOnce(JSON.stringify({ url: rawUrl, consumedAt: 1_000 }));
    await expect(consumeConnectLinkReplay(rawUrl, 2_000)).resolves.toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith("natstack:connect:consumed-url");
  });

  it("does not suppress a different connect link", async () => {
    storage.getItem.mockResolvedValueOnce(
      JSON.stringify({
        url: "natstack://connect?url=https%3A%2F%2Fold.example&code=abc123abc123abc123",
        consumedAt: 1_000,
      })
    );

    await expect(
      consumeConnectLinkReplay(
        "natstack://connect?url=https%3A%2F%2Fnew.example&code=def123def123def123",
        2_000
      )
    ).resolves.toBe(false);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("does not suppress stale consumed links", async () => {
    const rawUrl =
      "natstack://connect?url=https%3A%2F%2Fhost.tailnet.ts.net&code=abc123abc123abc123";
    storage.getItem.mockResolvedValueOnce(JSON.stringify({ url: rawUrl, consumedAt: 1_000 }));

    await expect(consumeConnectLinkReplay(rawUrl, 1_000 + 11 * 60 * 1_000)).resolves.toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith("natstack:connect:consumed-url");
  });

  it("matches connect links against already stored credentials", () => {
    expect(
      isConnectLinkForStoredServer("https://host.tailnet.ts.net", "https://host.tailnet.ts.net")
    ).toBe(true);
    expect(
      isConnectLinkForStoredServer("https://other.tailnet.ts.net", "https://host.tailnet.ts.net")
    ).toBe(false);
    expect(isConnectLinkForStoredServer("https://host.tailnet.ts.net", null)).toBe(false);
  });
});

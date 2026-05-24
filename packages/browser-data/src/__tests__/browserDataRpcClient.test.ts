import { describe, expect, it, vi } from "vitest";
import { createBrowserDataRpcClient } from "../client/browserDataRpcClient.js";

describe("createBrowserDataRpcClient", () => {
  it("relays calls as extensions.invoke with [name, method, args]", async () => {
    const call = vi.fn(async () => []);
    const client = createBrowserDataRpcClient({ call });

    await client.history.searchForAutocomplete("git", 10);

    expect(call).toHaveBeenCalledWith("extensions", "invoke", [
      "@workspace-extensions/browser-data",
      "searchHistoryForAutocomplete",
      [{ query: "git", limit: 10 }],
    ]);
  });

  it("passes a single object argument through unwrapped", async () => {
    const call = vi.fn(async () => 1);
    const client = createBrowserDataRpcClient({ call });

    await client.history.recordVisit({ url: "https://example.com", typed: true });

    expect(call).toHaveBeenCalledWith("extensions", "invoke", [
      "@workspace-extensions/browser-data",
      "recordHistoryVisit",
      [{ url: "https://example.com", typed: true }],
    ]);
  });
});

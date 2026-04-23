import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderRegistry } from "./registry.js";
import type { ProviderManifest } from "./types.js";

function createManifest(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: "github",
    displayName: "GitHub",
    apiBase: ["https://api.github.com"],
    flows: [{ type: "device-code", deviceAuthUrl: "https://github.com/login/device/code" }],
    ...overrides,
  };
}

describe("ProviderRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers manifests and returns them by provider id", () => {
    const registry = new ProviderRegistry();
    const manifest = createManifest();

    registry.register(manifest);

    expect(registry.get("github")).toEqual(manifest);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("lists manifests in registration order", () => {
    const registry = new ProviderRegistry();
    const first = createManifest();
    const second = createManifest({
      id: "slack",
      displayName: "Slack",
      apiBase: ["https://slack.com/api"],
    });

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toEqual([first, second]);
  });

  it("loadFromConfig logs that the stub is not implemented", async () => {
    const registry = new ProviderRegistry();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await registry.loadFromConfig(["@natstack/provider-github"]);

    expect(infoSpy).toHaveBeenCalledWith("ProviderRegistry.loadFromConfig is not implemented", {
      packageNames: ["@natstack/provider-github"],
    });
  });
});

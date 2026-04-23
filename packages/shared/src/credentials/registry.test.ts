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

  it("applyConfig overrides clientId on manifest and its flows", () => {
    const registry = new ProviderRegistry();
    const manifest = createManifest({
      clientId: "PLACEHOLDER",
      flows: [
        { type: "device-code", clientId: "PLACEHOLDER", deviceAuthUrl: "https://github.com/login/device/code" },
        { type: "pat" },
      ],
    });

    registry.register(manifest);
    registry.applyConfig({ github: { clientId: "real-client-id" } });

    const updated = registry.get("github")!;
    expect(updated.clientId).toBe("real-client-id");
    expect(updated.flows[0]!.clientId).toBe("real-client-id");
    expect(updated.flows[1]!.clientId).toBeUndefined();
  });

  it("applyConfig ignores unknown providers", () => {
    const registry = new ProviderRegistry();
    registry.applyConfig({ unknown: { clientId: "test" } });
    expect(registry.list()).toEqual([]);
  });

  it("applyEnvironment reads NATSTACK_<PROVIDER>_CLIENT_ID", () => {
    const registry = new ProviderRegistry();
    registry.register(createManifest({
      clientId: "PLACEHOLDER",
      flows: [{ type: "device-code", clientId: "PLACEHOLDER", deviceAuthUrl: "https://github.com/login/device/code" }],
    }));

    process.env["NATSTACK_GITHUB_CLIENT_ID"] = "env-client-id";
    try {
      registry.applyEnvironment();
      expect(registry.get("github")!.clientId).toBe("env-client-id");
    } finally {
      delete process.env["NATSTACK_GITHUB_CLIENT_ID"];
    }
  });
});

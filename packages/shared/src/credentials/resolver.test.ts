import { describe, expect, it, vi } from "vitest";

import { FlowResolver, type FlowRunner } from "./resolver.js";
import type { Credential, FlowConfig } from "./types.js";

function createCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    providerId: "github",
    connectionId: "conn-1",
    connectionLabel: "GitHub",
    accountIdentity: { providerUserId: "user-1", username: "octocat" },
    accessToken: "token-1",
    scopes: ["repo"],
    ...overrides,
  };
}

describe("FlowResolver", () => {
  it("tries flows in order and returns the first successful credential", async () => {
    const firstRunner = vi.fn<FlowRunner>().mockResolvedValue(null);
    const secondCredential = createCredential({ connectionId: "conn-2" });
    const secondRunner = vi.fn<FlowRunner>().mockResolvedValue(secondCredential);
    const resolver = new FlowResolver(
      new Map<string, FlowRunner>([
        ["device-code", firstRunner],
        ["pat", secondRunner],
      ]),
    );
    const flows: FlowConfig[] = [
      { type: "device-code", deviceAuthUrl: "https://example.com/device" },
      { type: "pat" },
    ];

    await expect(resolver.resolve(flows)).resolves.toEqual(secondCredential);

    expect(firstRunner).toHaveBeenCalledWith(flows[0]);
    expect(secondRunner).toHaveBeenCalledWith(flows[1]);
  });

  it("registers runners after construction", async () => {
    const credential = createCredential();
    const runner = vi.fn<FlowRunner>().mockResolvedValue(credential);
    const resolver = new FlowResolver(new Map());
    const flows: FlowConfig[] = [{ type: "cli-piggyback", command: "gh auth token" }];

    resolver.registerRunner("cli-piggyback", runner);

    await expect(resolver.resolve(flows)).resolves.toEqual(credential);
    expect(runner).toHaveBeenCalledWith(flows[0]);
  });

  it("throws when no flow succeeds", async () => {
    const failingRunner = vi.fn<FlowRunner>().mockResolvedValue(null);
    const resolver = new FlowResolver(new Map<string, FlowRunner>([["device-code", failingRunner]]));
    const flows: FlowConfig[] = [
      { type: "mcp-dcr", resource: "https://example.com" },
      { type: "device-code", deviceAuthUrl: "https://example.com/device" },
    ];

    await expect(resolver.resolve(flows)).rejects.toThrow("No credential flow succeeded");
    expect(failingRunner).toHaveBeenCalledTimes(1);
    expect(failingRunner).toHaveBeenCalledWith(flows[1]);
  });
});

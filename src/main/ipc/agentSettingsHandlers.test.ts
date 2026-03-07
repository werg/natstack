/**
 * Tests for agent settings service.
 */

import { createAgentSettingsService } from "../../server/services/agentSettingsService.js";
import type { ServiceContext } from "../../shared/serviceDispatcher.js";

const ctx: ServiceContext = { callerId: "test", callerKind: "shell" };

describe("agentSettingsService", () => {
  const mockService = {
    getGlobalSettings: vi.fn().mockReturnValue({ enabled: true }),
    setGlobalSetting: vi.fn(),
    getAgentSettings: vi.fn().mockReturnValue({ model: "claude-3" }),
    getAllAgentSettings: vi.fn().mockReturnValue({}),
    setAgentSettings: vi.fn(),
  };

  const svc = createAgentSettingsService({
    agentSettingsService: mockService as any,
    agentDiscovery: null,
  });
  const handler = svc.handler;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getGlobalSettings calls service.getGlobalSettings()", async () => {
    const result = await handler(ctx, "getGlobalSettings", []);
    expect(mockService.getGlobalSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: true });
  });

  it("setGlobalSetting calls service.setGlobalSetting(key, value)", async () => {
    await handler(ctx, "setGlobalSetting", ["enabled", false]);
    expect(mockService.setGlobalSetting).toHaveBeenCalledWith("enabled", false);
  });

  it("setGlobalSetting throws on missing key", async () => {
    await expect(handler(ctx, "setGlobalSetting", [undefined, "val"])).rejects.toThrow(
      "Missing key argument",
    );
  });

  it("getAgentSettings calls service.getAgentSettings(agentId)", async () => {
    const result = await handler(ctx, "getAgentSettings", ["agent-1"]);
    expect(mockService.getAgentSettings).toHaveBeenCalledWith("agent-1");
    expect(result).toEqual({ model: "claude-3" });
  });

  it("getAgentSettings throws on missing agentId", async () => {
    await expect(handler(ctx, "getAgentSettings", [])).rejects.toThrow(
      "Missing agentId argument",
    );
  });

  it("getAllAgentSettings calls service.getAllAgentSettings()", async () => {
    const result = await handler(ctx, "getAllAgentSettings", []);
    expect(mockService.getAllAgentSettings).toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("setAgentSettings validates arguments and calls service", async () => {
    const settings = { model: "claude-3", enabled: true };
    await handler(ctx, "setAgentSettings", ["agent-1", settings]);
    expect(mockService.setAgentSettings).toHaveBeenCalledWith("agent-1", settings);
  });

  it("setAgentSettings throws on missing agentId", async () => {
    await expect(handler(ctx, "setAgentSettings", [undefined, {}])).rejects.toThrow(
      "Missing agentId argument",
    );
  });

  it("setAgentSettings throws on invalid settings", async () => {
    await expect(handler(ctx, "setAgentSettings", ["agent-1", null])).rejects.toThrow(
      "Invalid settings argument",
    );
  });

  it("listAgents delegates to agentDiscovery", async () => {
    const manifest1 = { id: "a1", name: "Agent 1" };
    const manifest2 = { id: "a2", name: "Agent 2" };
    const mockDiscovery = {
      listValid: vi.fn().mockReturnValue([
        { manifest: manifest1 },
        { manifest: manifest2 },
      ]),
    } as any;

    const svcWithDiscovery = createAgentSettingsService({
      agentSettingsService: mockService as any,
      agentDiscovery: mockDiscovery,
    });
    const result = await svcWithDiscovery.handler(ctx, "listAgents", []);
    expect(result).toEqual([manifest1, manifest2]);
  });

  it("listAgents returns empty array when discovery is null", async () => {
    const result = await handler(ctx, "listAgents", []);
    expect(result).toEqual([]);
  });

  it("throws on unknown method", async () => {
    await expect(handler(ctx, "unknownMethod", [])).rejects.toThrow(
      "Unknown agentSettings method: unknownMethod",
    );
  });
});

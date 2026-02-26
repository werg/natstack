/**
 * Tests for agent settings handlers.
 */

import { handleAgentSettingsCall } from "./agentSettingsHandlers.js";
import { getAgentSettingsService } from "../agentSettings.js";
import { getAgentDiscovery } from "../agentDiscovery.js";

vi.mock("../agentSettings.js", () => ({
  getAgentSettingsService: vi.fn(),
}));
vi.mock("../agentDiscovery.js", () => ({
  getAgentDiscovery: vi.fn(),
}));

describe("handleAgentSettingsCall", () => {
  const mockService = {
    getGlobalSettings: vi.fn().mockReturnValue({ enabled: true }),
    setGlobalSetting: vi.fn(),
    getAgentSettings: vi.fn().mockReturnValue({ model: "claude-3" }),
    getAllAgentSettings: vi.fn().mockReturnValue({}),
    setAgentSettings: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAgentSettingsService).mockReturnValue(mockService as any);
    vi.mocked(getAgentDiscovery).mockReturnValue(null as any);
  });

  it("throws when service is not initialized", async () => {
    vi.mocked(getAgentSettingsService).mockReturnValue(null as any);
    await expect(
      handleAgentSettingsCall("getGlobalSettings", []),
    ).rejects.toThrow("AgentSettingsService not initialized");
  });

  it("getGlobalSettings calls service.getGlobalSettings()", async () => {
    const result = await handleAgentSettingsCall("getGlobalSettings", []);
    expect(mockService.getGlobalSettings).toHaveBeenCalled();
    expect(result).toEqual({ enabled: true });
  });

  it("setGlobalSetting calls service.setGlobalSetting(key, value)", async () => {
    await handleAgentSettingsCall("setGlobalSetting", ["enabled", false]);
    expect(mockService.setGlobalSetting).toHaveBeenCalledWith(
      "enabled",
      false,
    );
  });

  it("setGlobalSetting throws on missing key", async () => {
    await expect(
      handleAgentSettingsCall("setGlobalSetting", [undefined, "val"]),
    ).rejects.toThrow("Missing key argument");
  });

  it("getAgentSettings calls service.getAgentSettings(agentId)", async () => {
    const result = await handleAgentSettingsCall("getAgentSettings", [
      "agent-1",
    ]);
    expect(mockService.getAgentSettings).toHaveBeenCalledWith("agent-1");
    expect(result).toEqual({ model: "claude-3" });
  });

  it("getAgentSettings throws on missing agentId", async () => {
    await expect(
      handleAgentSettingsCall("getAgentSettings", []),
    ).rejects.toThrow("Missing agentId argument");
  });

  it("getAllAgentSettings calls service.getAllAgentSettings()", async () => {
    const result = await handleAgentSettingsCall("getAllAgentSettings", []);
    expect(mockService.getAllAgentSettings).toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("setAgentSettings validates arguments and calls service", async () => {
    const settings = { model: "claude-3", enabled: true };
    await handleAgentSettingsCall("setAgentSettings", ["agent-1", settings]);
    expect(mockService.setAgentSettings).toHaveBeenCalledWith(
      "agent-1",
      settings,
    );
  });

  it("setAgentSettings throws on missing agentId", async () => {
    await expect(
      handleAgentSettingsCall("setAgentSettings", [undefined, {}]),
    ).rejects.toThrow("Missing agentId argument");
  });

  it("setAgentSettings throws on invalid settings", async () => {
    await expect(
      handleAgentSettingsCall("setAgentSettings", ["agent-1", null]),
    ).rejects.toThrow("Invalid settings argument");
  });

  it("listAgents delegates to agentDiscovery", async () => {
    const manifest1 = { id: "a1", name: "Agent 1" };
    const manifest2 = { id: "a2", name: "Agent 2" };
    vi.mocked(getAgentDiscovery).mockReturnValue({
      listValid: vi.fn().mockReturnValue([
        { manifest: manifest1 },
        { manifest: manifest2 },
      ]),
    } as any);

    const result = await handleAgentSettingsCall("listAgents", []);
    expect(result).toEqual([manifest1, manifest2]);
  });

  it("listAgents returns empty array when discovery is null", async () => {
    vi.mocked(getAgentDiscovery).mockReturnValue(null as any);
    const result = await handleAgentSettingsCall("listAgents", []);
    expect(result).toEqual([]);
  });

  it("throws on unknown method", async () => {
    await expect(
      handleAgentSettingsCall("unknownMethod", []),
    ).rejects.toThrow("Unknown agentSettings method: unknownMethod");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSettingsManager } from "../settings/settings-manager.js";
import type { AgenticClient, AgenticParticipantMetadata } from "@natstack/agentic-messaging";

// Mock client factory
function createMockClient(savedSettings: Record<string, unknown> | null = null): AgenticClient<AgenticParticipantMetadata> {
  let settings = savedSettings;

  return {
    sessionKey: "test-session-key",
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockImplementation(async (newSettings) => {
      settings = newSettings;
    }),
  } as unknown as AgenticClient<AgenticParticipantMetadata>;
}

interface TestSettings extends Record<string, unknown> {
  modelRole: string;
  temperature: number;
  nested: {
    value: string;
    count: number;
  };
}

const DEFAULT_SETTINGS: TestSettings = {
  modelRole: "fast",
  temperature: 0.7,
  nested: {
    value: "default",
    count: 0,
  },
};

describe("createSettingsManager", () => {
  it("should return defaults when no saved settings", async () => {
    const client = createMockClient(null);
    const manager = createSettingsManager<TestSettings>({
      client,
      defaults: DEFAULT_SETTINGS,
    });

    await manager.load();
    expect(manager.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("should merge saved settings over defaults", async () => {
    const savedSettings = {
      modelRole: "slow",
      temperature: 0.9,
    };
    const client = createMockClient(savedSettings);
    const manager = createSettingsManager<TestSettings>({
      client,
      defaults: DEFAULT_SETTINGS,
    });

    await manager.load();
    expect(manager.get()).toEqual({
      modelRole: "slow",
      temperature: 0.9,
      nested: DEFAULT_SETTINGS.nested,
    });
  });

  it("should apply initConfig with highest priority", async () => {
    const savedSettings = {
      modelRole: "slow",
      temperature: 0.9,
    };
    const client = createMockClient(savedSettings);
    const manager = createSettingsManager<TestSettings>({
      client,
      defaults: DEFAULT_SETTINGS,
      initConfig: {
        temperature: 0.5, // Override saved
      },
    });

    await manager.load();
    expect(manager.get()).toEqual({
      modelRole: "slow", // From saved
      temperature: 0.5, // From initConfig
      nested: DEFAULT_SETTINGS.nested,
    });
  });

  it("should deep merge nested objects", async () => {
    const savedSettings = {
      nested: {
        value: "saved",
      },
    };
    const client = createMockClient(savedSettings);
    const manager = createSettingsManager<TestSettings>({
      client,
      defaults: DEFAULT_SETTINGS,
    });

    await manager.load();
    expect(manager.get().nested).toEqual({
      value: "saved",
      count: 0, // From defaults
    });
  });

  it("should update and persist settings", async () => {
    const client = createMockClient(null);
    const manager = createSettingsManager<TestSettings>({
      client,
      defaults: DEFAULT_SETTINGS,
    });

    await manager.load();
    await manager.update({ temperature: 0.8 });

    expect(manager.get().temperature).toBe(0.8);
    expect(client.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.8 })
    );
  });

  it("should deep merge on update", async () => {
    const client = createMockClient(null);
    const manager = createSettingsManager<TestSettings>({
      client,
      defaults: DEFAULT_SETTINGS,
    });

    await manager.load();
    await manager.update({
      nested: { ...manager.get().nested, value: "updated" },
    });

    expect(manager.get().nested).toEqual({
      value: "updated",
      count: 0,
    });
  });

  it("should reset to defaults (with initConfig)", async () => {
    const savedSettings = {
      modelRole: "slow",
      temperature: 0.9,
    };
    const client = createMockClient(savedSettings);
    const manager = createSettingsManager<TestSettings>({
      client,
      defaults: DEFAULT_SETTINGS,
      initConfig: {
        temperature: 0.5,
      },
    });

    await manager.load();
    await manager.reset();

    // Should be defaults + initConfig, not saved
    expect(manager.get()).toEqual({
      modelRole: "fast", // From defaults
      temperature: 0.5, // From initConfig
      nested: DEFAULT_SETTINGS.nested,
    });

    // Should have cleared saved settings
    expect(client.updateSettings).toHaveBeenCalledWith({});
  });

  it("should handle missing sessionKey gracefully", async () => {
    const client = {
      ...createMockClient(null),
      sessionKey: null,
    } as unknown as AgenticClient<AgenticParticipantMetadata>;

    const manager = createSettingsManager<TestSettings>({
      client,
      defaults: DEFAULT_SETTINGS,
    });

    // Should not throw
    await manager.load();
    expect(manager.get()).toEqual(DEFAULT_SETTINGS);

    // Should not try to save
    await manager.update({ temperature: 0.8 });
    expect(client.updateSettings).not.toHaveBeenCalled();
  });

  it("should handle getSettings error gracefully", async () => {
    const client = createMockClient(null);
    (client.getSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB error"));

    const manager = createSettingsManager<TestSettings>({
      client,
      defaults: DEFAULT_SETTINGS,
    });

    // Should not throw, should use defaults
    await manager.load();
    expect(manager.get()).toEqual(DEFAULT_SETTINGS);
  });
});

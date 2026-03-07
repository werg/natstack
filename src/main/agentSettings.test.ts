/**
 * AgentSettingsService Unit Tests
 *
 * Tests for defaultAgent global setting: set/get, null handling,
 * and stale cleanup in syncWithDiscovery.
 *
 * Run with: npx vitest run src/main/agentSettings.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentManifest } from "@natstack/types";

let testDir: string;

const mockWorkspace = {
  config: { id: "test-workspace" },
  path: "",
  cachePath: "",
  gitReposPath: "",
};

// Mutable list of "discovered" agents for the mock
let mockValidAgents: Array<{ manifest: AgentManifest }> = [];

const mockDiscovery = {
  listValid: () => mockValidAgents,
  on: () => () => {},
  list: () => [],
  startWatching: () => {},
  stopWatching: () => {},
} as any;

vi.mock("./devLog.js", () => ({
  createDevLogger: () => ({
    verbose: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Import after mocks
import { AgentSettingsService } from "./agentSettings.js";

function makeAgent(id: string): { manifest: AgentManifest } {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
    },
  };
}

describe("AgentSettingsService - defaultAgent", () => {
  let service: AgentSettingsService;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-settings-test-"));
    mockWorkspace.path = testDir;
    mockValidAgents = [makeAgent("agent-a"), makeAgent("agent-b")];

    service = new AgentSettingsService();
    await service.initialize(testDir, mockDiscovery);
  });

  afterEach(() => {
    service.shutdown();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("returns null for defaultAgent by default", () => {
    const settings = service.getGlobalSettings();
    expect(settings.defaultAgent).toBeNull();
  });

  it("stores and retrieves a defaultAgent", () => {
    service.setGlobalSetting("defaultAgent", "agent-a");
    const settings = service.getGlobalSettings();
    expect(settings.defaultAgent).toBe("agent-a");
  });

  it("stores and retrieves null for defaultAgent", () => {
    service.setGlobalSetting("defaultAgent", null);
    const settings = service.getGlobalSettings();
    expect(settings.defaultAgent).toBeNull();
  });

  it("round-trip: set agent, then clear to null", () => {
    service.setGlobalSetting("defaultAgent", "agent-b");
    expect(service.getGlobalSettings().defaultAgent).toBe("agent-b");

    service.setGlobalSetting("defaultAgent", null);
    expect(service.getGlobalSettings().defaultAgent).toBeNull();
  });

  it("clears stale defaultAgent on syncWithDiscovery", async () => {
    service.setGlobalSetting("defaultAgent", "removed-agent");
    expect(service.getGlobalSettings().defaultAgent).toBe("removed-agent");

    // removed-agent is not in mockValidAgents, so sync should clear it
    await service.syncWithDiscovery();
    expect(service.getGlobalSettings().defaultAgent).toBeNull();
  });

  it("preserves valid defaultAgent on syncWithDiscovery", async () => {
    service.setGlobalSetting("defaultAgent", "agent-a");

    await service.syncWithDiscovery();
    expect(service.getGlobalSettings().defaultAgent).toBe("agent-a");
  });
});

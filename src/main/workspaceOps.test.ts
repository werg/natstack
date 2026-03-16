import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import YAML from "yaml";
import { createWorkspaceConfigManager } from "./workspaceOps.js";
import type { WorkspaceConfig } from "../shared/workspace/types.js";

vi.mock("fs");
vi.mock("yaml");

const mockFs = vi.mocked(fs);
const mockYAML = vi.mocked(YAML);

describe("createWorkspaceConfigManager", () => {
  const configPath = "/fake/workspace/source/natstack.yml";
  let config: WorkspaceConfig;

  beforeEach(() => {
    vi.resetAllMocks();
    config = { id: "test-ws", rootPanel: "panels/chat", git: { port: 63524 } };
  });

  it("get() returns the live config object", () => {
    const mgr = createWorkspaceConfigManager(configPath, config);
    expect(mgr.get()).toBe(config);
    expect(mgr.get().id).toBe("test-ws");
    expect(mgr.get().rootPanel).toBe("panels/chat");
  });

  it("set() writes disk then updates in-memory", () => {
    const onDisk = { id: "test-ws", rootPanel: "panels/chat", git: { port: 63524 } };
    mockFs.readFileSync.mockReturnValue("yaml-content");
    mockYAML.parse.mockReturnValue(onDisk);
    mockYAML.stringify.mockReturnValue("new-yaml");

    const mgr = createWorkspaceConfigManager(configPath, config);
    mgr.set("rootPanel", "panels/new-app");

    // Disk written
    expect(mockFs.readFileSync).toHaveBeenCalledWith(configPath, "utf-8");
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(configPath, "new-yaml", "utf-8");
    expect(onDisk["rootPanel"]).toBe("panels/new-app");

    // In-memory updated
    expect(config.rootPanel).toBe("panels/new-app");
  });

  it("set() does not mutate in-memory if disk write fails", () => {
    mockFs.readFileSync.mockReturnValue("yaml-content");
    mockYAML.parse.mockReturnValue({ id: "test-ws" });
    mockYAML.stringify.mockReturnValue("new-yaml");
    mockFs.writeFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const mgr = createWorkspaceConfigManager(configPath, config);
    expect(() => mgr.set("rootPanel", "panels/broken")).toThrow("EACCES");

    // In-memory should be unchanged
    expect(config.rootPanel).toBe("panels/chat");
  });

  it("set() does not mutate in-memory if disk read fails", () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });

    const mgr = createWorkspaceConfigManager(configPath, config);
    expect(() => mgr.set("rootPanel", "panels/broken")).toThrow("ENOENT");

    expect(config.rootPanel).toBe("panels/chat");
  });

  it("set() can set initPanels array", () => {
    const onDisk = { id: "test-ws" };
    mockFs.readFileSync.mockReturnValue("yaml");
    mockYAML.parse.mockReturnValue(onDisk);
    mockYAML.stringify.mockReturnValue("out");

    const mgr = createWorkspaceConfigManager(configPath, config);
    mgr.set("initPanels", ["panels/setup"]);

    expect(config.initPanels).toEqual(["panels/setup"]);
    expect(onDisk["initPanels" as keyof typeof onDisk]).toEqual(["panels/setup"]);
  });

  it("set() clears a field by setting undefined", () => {
    const onDisk: Record<string, unknown> = { id: "test-ws", rootPanel: "panels/old" };
    mockFs.readFileSync.mockReturnValue("yaml");
    mockYAML.parse.mockReturnValue(onDisk);
    mockYAML.stringify.mockReturnValue("out");

    const mgr = createWorkspaceConfigManager(configPath, config);
    mgr.set("rootPanel", undefined);

    expect(config.rootPanel).toBeUndefined();
    expect(onDisk["rootPanel"]).toBeUndefined();
  });
});

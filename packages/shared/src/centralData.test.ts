import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CentralDataManager } from "./centralData.js";

describe("CentralDataManager", () => {
  let tempRoot: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-central-data-"));
    originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tempRoot;
  });

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("repairs a missing registry entry when touching an existing workspace", () => {
    const configPath = path.join(
      tempRoot,
      "natstack",
      "workspaces",
      "client",
      "source",
      "meta",
      "natstack.yml"
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "id: client\n", "utf8");

    const manager = new CentralDataManager();
    expect(manager.getWorkspaceEntry("client")).toBeNull();

    manager.touchWorkspace("client");

    expect(manager.getWorkspaceEntry("client")).toMatchObject({ name: "client" });
    expect(manager.getLastWorkspaceTarget()).toMatchObject({ kind: "local", name: "client" });
  });

  it("does not add a registry entry when touching a missing workspace", () => {
    const manager = new CentralDataManager();

    manager.touchWorkspace("missing");

    expect(manager.getWorkspaceEntry("missing")).toBeNull();
    expect(manager.listWorkspaces()).toEqual([]);
  });
});

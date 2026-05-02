import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadWorkspaceConfig } from "./loader.js";

const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
const tempRoots: string[] = [];

function writeConfig(sourceRoot: string, content: string): void {
  fs.mkdirSync(path.join(sourceRoot, "meta"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "meta", "natstack.yml"), content, "utf-8");
}

afterEach(() => {
  if (originalXdgConfigHome === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("loadWorkspaceConfig", () => {
  (process.platform === "linux" ? it : it.skip)("derives the workspace id from the managed workspace folder name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");

    const sourceRoot = path.join(process.env["XDG_CONFIG_HOME"], "natstack", "workspaces", "cloned-ws", "source");
    writeConfig(sourceRoot, "initPanels: []\n");

    expect(loadWorkspaceConfig(sourceRoot).id).toBe("cloned-ws");
  });

  it("derives the workspace id from the absolute workspace root for unmanaged paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const workspaceRoot = path.join(root, "external-workspace");
    const sourceRoot = path.join(workspaceRoot, "source");
    writeConfig(sourceRoot, "initPanels: []\n");

    expect(loadWorkspaceConfig(sourceRoot).id).toBe(workspaceRoot);
  });

  it("ignores an explicit workspace id when one is configured", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const sourceRoot = path.join(workspaceRoot, "source");
    writeConfig(sourceRoot, "id: explicit\ninitPanels: []\n");

    expect(loadWorkspaceConfig(sourceRoot).id).toBe(workspaceRoot);
  });
});

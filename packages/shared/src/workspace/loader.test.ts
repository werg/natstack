import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initWorkspace, loadWorkspaceConfig, resolveDeclaredExtensions } from "./loader.js";

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

  it("rejects duplicate extension declarations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(
      sourceRoot,
      "extensions:\n  - source: extensions/@scope/a\n  - source: extensions/@scope/a.git\n",
    );

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/duplicate extension/);
  });

  it("rejects extension declarations without a source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "extensions:\n  - ref: main\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/non-empty `source`/);
  });
});

describe("resolveDeclaredExtensions", () => {
  it("returns an empty list when no extensions section exists", () => {
    expect(resolveDeclaredExtensions({ id: "ws" })).toEqual([]);
  });

  it("applies ref and enabled defaults", () => {
    expect(
      resolveDeclaredExtensions({
        id: "ws",
        extensions: [{ source: "extensions/@scope/a" }, { source: "@scope/b", ref: "dev", enabled: false }],
      }),
    ).toEqual([
      { source: "extensions/@scope/a", ref: "main", enabled: true },
      { source: "@scope/b", ref: "dev", enabled: false },
    ]);
  });
});

describe("initWorkspace", () => {
  (process.platform === "linux" ? it : it.skip)("records template provenance for new managed workspaces", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");

    const templateRoot = path.join(root, "workspace-template");
    writeConfig(templateRoot, "initPanels: []\n");

    initWorkspace("fresh-ws", { templateDir: templateRoot });

    const markerPath = path.join(
      process.env["XDG_CONFIG_HOME"],
      "natstack",
      "workspaces",
      "fresh-ws",
      "source",
      "meta",
      ".natstack-template-source.json",
    );
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
      kind?: string;
      sourcePath?: string;
      copiedAt?: string;
      gitHead?: unknown;
    };

    expect(marker.kind).toBe("template");
    expect(marker.sourcePath).toBe(templateRoot);
    expect(marker.copiedAt).toEqual(expect.any(String));
    expect(marker.gitHead === null || typeof marker.gitHead === "string").toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  loadWorkspaceConfig,
  resolveDeclaredApps,
  resolveDeclaredExtensions,
} from "./loader.js";

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
  (process.platform === "linux" ? it : it.skip)(
    "derives the workspace id from the managed workspace folder name",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
      tempRoots.push(root);
      process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");

      const sourceRoot = path.join(
        process.env["XDG_CONFIG_HOME"],
        "natstack",
        "workspaces",
        "cloned-ws",
        "source"
      );
      writeConfig(sourceRoot, "initPanels: []\n");

      expect(loadWorkspaceConfig(sourceRoot).id).toBe("cloned-ws");
    }
  );

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
      "extensions:\n  - source: extensions/a\n  - source: extensions/a.git\n"
    );

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/duplicate extension/);
  });

  it("rejects duplicate extension declarations across source-root and package-name forms", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(
      sourceRoot,
      'extensions:\n  - source: extensions/a\n  - source: "@workspace-extensions/a"\n'
    );

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/duplicate extension/);
  });

  it("rejects extension declarations outside the extension source root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "extensions:\n  - source: apps/shell\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(
      /extensions\[\]\.source.*extensions\/name/
    );
  });

  it("rejects nested extension source paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "extensions:\n  - source: extensions/react-native/nested\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(
      /extensions\[\]\.source.*@workspace-extensions\/name/
    );
  });

  it("rejects extension declarations without a source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "extensions:\n  - ref: main\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/non-empty `source`/);
  });

  it("rejects duplicate app declarations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "apps:\n  - source: apps/shell\n  - source: apps/shell.git\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/duplicate app/);
  });

  it("rejects duplicate app declarations across source-root and package-name forms", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, 'apps:\n  - source: apps/shell\n  - source: "@workspace-apps/shell"\n');

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/duplicate app/);
  });

  it("rejects app declarations outside the app source root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "apps:\n  - source: extensions/react-native\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(/apps\[\]\.source.*apps\/name/);
  });

  it("rejects unscoped app package names", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    const sourceRoot = path.join(root, "workspace", "source");
    writeConfig(sourceRoot, "apps:\n  - source: shell\n");

    expect(() => loadWorkspaceConfig(sourceRoot)).toThrow(
      /apps\[\]\.source.*@workspace-apps\/name/
    );
  });

});

describe("resolveDeclaredExtensions", () => {
  it("returns an empty list when no extensions section exists", () => {
    expect(resolveDeclaredExtensions({ id: "ws" })).toEqual([]);
  });

  it("applies ref defaults", () => {
    expect(
      resolveDeclaredExtensions({
        id: "ws",
        extensions: [
          { source: "extensions/a" },
          { source: "@workspace-extensions/b", ref: "dev" },
        ],
      })
    ).toEqual([
      { source: "extensions/a", ref: "main" },
      { source: "@workspace-extensions/b", ref: "dev" },
    ]);
  });
});

describe("resolveDeclaredApps", () => {
  it("returns an empty list when no apps section exists", () => {
    expect(resolveDeclaredApps({ id: "ws" })).toEqual([]);
  });

  it("applies ref defaults", () => {
    expect(
      resolveDeclaredApps({
        id: "ws",
        apps: [
          { source: "apps/shell" },
          {
            source: "@workspace-apps/mobile",
            ref: "dev",
          },
        ],
      })
    ).toEqual([
      { source: "apps/shell", ref: "main" },
      {
        source: "@workspace-apps/mobile",
        ref: "dev",
      },
    ]);
  });
});

describe("initWorkspace", () => {
  (process.platform === "linux" ? it : it.skip)(
    "copies canonical app units from the workspace template",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
      tempRoots.push(root);
      process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");
      const templateRoot = path.join(root, "workspace-template");
      writeConfig(
        templateRoot,
        [
          "extensions:",
          "  - source: extensions/react-native",
          "apps:",
          "  - source: apps/shell",
          "  - source: apps/mobile",
          "initPanels: []",
          "",
        ].join("\n")
      );
      fs.mkdirSync(path.join(templateRoot, "apps", "shell"), { recursive: true });
      fs.writeFileSync(
        path.join(templateRoot, "apps", "shell", "package.json"),
        JSON.stringify({
          name: "@workspace-apps/shell",
          version: "0.1.0",
          natstack: {
            app: {
              target: "electron",
              renderer: "index.tsx",
              capabilities: ["panel-hosting", "incoming-pair-links", "connection-management"],
            },
          },
        })
      );
      fs.writeFileSync(
        path.join(templateRoot, "apps", "shell", "index.tsx"),
        "export const templateShell = true;\n"
      );
      fs.mkdirSync(path.join(templateRoot, "apps", "mobile"), { recursive: true });
      fs.writeFileSync(
        path.join(templateRoot, "apps", "mobile", "package.json"),
        JSON.stringify({
          name: "@workspace-apps/mobile",
          version: "0.1.0",
          natstack: {
            app: {
              target: "react-native",
              renderer: "App.tsx",
              rnComponentName: "NatStack",
              rnHostAbi: "rn-host-1",
              capabilities: ["notifications", "camera", "keychain", "clipboard", "open-external"],
            },
          },
        })
      );
      fs.writeFileSync(
        path.join(templateRoot, "apps", "mobile", "App.tsx"),
        "export const templateMobile = true;\n"
      );
      fs.mkdirSync(path.join(templateRoot, "extensions", "react-native"), { recursive: true });
      fs.writeFileSync(
        path.join(templateRoot, "extensions", "react-native", "package.json"),
        JSON.stringify({
          name: "@workspace-extensions/react-native",
          version: "0.1.0",
          natstack: {
            extension: {
              activationEvents: ["*"],
              streamingMethods: ["buildArtifact"],
              contributes: { buildTargets: ["react-native"] },
            },
          },
        })
      );
      fs.writeFileSync(
        path.join(templateRoot, "extensions", "react-native", "index.ts"),
        "export const templateProvider = true;\n"
      );

      initWorkspace("fresh-app-ws", { templateDir: templateRoot });

      const sourceRoot = path.join(
        process.env["XDG_CONFIG_HOME"],
        "natstack",
        "workspaces",
        "fresh-app-ws",
        "source"
      );
      const config = loadWorkspaceConfig(sourceRoot);

      expect(resolveDeclaredApps(config)).toEqual([
        { source: "apps/shell", ref: "main" },
        {
          source: "apps/mobile",
          ref: "main",
        },
      ]);
      expect(resolveDeclaredExtensions(config)).toEqual([
        { source: "extensions/react-native", ref: "main" },
      ]);
      expect(fs.existsSync(path.join(sourceRoot, "apps", "shell", ".git"))).toBe(true);
      expect(fs.existsSync(path.join(sourceRoot, "apps", "mobile", ".git"))).toBe(true);
      expect(fs.existsSync(path.join(sourceRoot, "extensions", "react-native", ".git"))).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(path.join(sourceRoot, "apps", "shell", "package.json"), "utf-8"))
      ).toMatchObject({
        name: "@workspace-apps/shell",
        natstack: {
          app: {
            target: "electron",
            renderer: "index.tsx",
            capabilities: expect.arrayContaining([
              "panel-hosting",
              "incoming-pair-links",
              "connection-management",
            ]),
          },
        },
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(sourceRoot, "apps", "mobile", "package.json"), "utf-8")
        )
      ).toMatchObject({
        name: "@workspace-apps/mobile",
        natstack: {
          app: {
            target: "react-native",
            renderer: "App.tsx",
            rnComponentName: "NatStack",
            rnHostAbi: "rn-host-1",
            capabilities: expect.arrayContaining([
              "notifications",
              "camera",
              "keychain",
              "clipboard",
              "open-external",
            ]),
          },
        },
      });
      expect(
        fs.readFileSync(path.join(sourceRoot, "apps", "shell", "index.tsx"), "utf-8")
      ).toContain("templateShell");
      expect(
        fs.readFileSync(path.join(sourceRoot, "apps", "mobile", "App.tsx"), "utf-8")
      ).toContain("templateMobile");
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(sourceRoot, "extensions", "react-native", "package.json"),
            "utf-8"
          )
        )
      ).toMatchObject({
        name: "@workspace-extensions/react-native",
        natstack: {
          extension: {
            streamingMethods: ["buildArtifact"],
            contributes: { buildTargets: ["react-native"] },
          },
        },
      });
      const providerSource = fs.readFileSync(
        path.join(sourceRoot, "extensions", "react-native", "index.ts"),
        "utf-8"
      );
      expect(providerSource).toContain("templateProvider");
    }
  );

  (process.platform === "linux" ? it : it.skip)("requires a template or fork", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-loader-"));
    tempRoots.push(root);
    process.env["XDG_CONFIG_HOME"] = path.join(root, "xdg");

    expect(() => initWorkspace("missing-template")).toThrow(/requires a templateDir or forkFrom/);
  });

  (process.platform === "linux" ? it : it.skip)(
    "records template provenance for new managed workspaces",
    () => {
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
        ".natstack-template-source.json"
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
    }
  );
});

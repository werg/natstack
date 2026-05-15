import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@natstack/env-paths";

import { buildUnit } from "./builder.js";
import { discoverPackageGraph } from "./packageGraph.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

describe("buildUnit extension builds", () => {
  let root: string;
  let workspaceRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extension-build-"));
    workspaceRoot = path.join(root, "workspace");
    setUserDataPath(path.join(root, "state"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds a scoped workspace extension as a node ESM bundle with inline sourcemaps", async () => {
    const extensionDir = path.join(
      workspaceRoot,
      "extensions",
      "@workspace-extensions",
      "hello",
    );
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, "package.json"),
      JSON.stringify({
        name: "@workspace-extensions/hello",
        version: "0.1.0",
        type: "module",
        private: true,
        natstack: {
          displayName: "Hello Extension",
          entry: "index.ts",
          sourcemap: true,
          extension: { activationEvents: ["*"] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(extensionDir, "index.ts"),
      [
        "export async function activate() {",
        "  return {",
        "    ping() { return 'pong'; },",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    git(extensionDir, ["init", "-b", "main"]);
    git(extensionDir, ["add", "."]);
    git(extensionDir, [
      "-c",
      "user.name=NatStack Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial extension",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const node = graph.get("@workspace-extensions/hello");
    const result = await buildUnit(node, "ev-extension-test", graph, workspaceRoot);

    expect(result.metadata).toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/hello",
      sourcemap: true,
      runtimeDepsKey: null,
    });
    expect(fs.readFileSync(path.join(result.dir, "package.json"), "utf8")).toBe('{"type":"module"}');
    expect(result.bundle).toContain("ping() {");
    expect(result.bundle).toContain("sourceMappingURL=data:application/json");
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearTypeCheckCache } from "@natstack/shared/typecheck/service";

import { activate } from "./index.js";

function tempPanel(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-typecheck-extension-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "panel-under-test", version: "0.0.0" }),
  );
  fs.writeFileSync(path.join(dir, "index.tsx"), "const value: number = 'nope';\n");
  return dir;
}

async function api() {
  return activate({
    workspace: {
      async getInfo() {
        return { path: process.cwd(), contextsPath: path.join(os.tmpdir(), "natstack-contexts") };
      },
    },
    invocation: { current: () => null },
    log: { info: () => {} },
  });
}

describe("@workspace-extensions/typecheck-service", () => {
  afterEach(() => {
    clearTypeCheckCache();
  });

  it("checks a panel path and reports diagnostics", async () => {
    const service = await api();
    const panelPath = tempPanel();

    try {
      const result = await service.check(panelPath);
      expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
      expect(result.checkedFiles.some((file) => file.endsWith("index.tsx"))).toBe(true);
    } finally {
      fs.rmSync(panelPath, { recursive: true, force: true });
    }
  });

  it("returns checkPanel summary counts", async () => {
    const service = await api();
    const panelPath = tempPanel();

    try {
      const result = await service.checkPanel(panelPath);
      expect(result.errorCount).toBeGreaterThan(0);
      expect(result.warningCount).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(panelPath, { recursive: true, force: true });
    }
  });
});

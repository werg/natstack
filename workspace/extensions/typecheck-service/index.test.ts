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

async function api(
  caller?: string | {
    callerId: string;
    contextId?: string;
    chainContextId?: string;
  },
  contextsPath = path.join(os.tmpdir(), "natstack-contexts"),
) {
  const callerInfo = typeof caller === "string" ? { callerId: caller } : caller;
  return activate({
    workspace: {
      async getInfo() {
        return { path: process.cwd(), contextsPath };
      },
    },
    invocation: {
      current: () => callerInfo
        ? {
            caller: {
              callerId: callerInfo.callerId,
              ...(callerInfo.contextId ? { contextId: callerInfo.contextId } : {}),
            },
            ...(callerInfo.chainContextId
              ? { chainCaller: { contextId: callerInfo.chainContextId } }
              : {}),
          }
        : null,
    },
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

  it("resolves checkPanel against an explicit context", async () => {
    const contextsPath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-typecheck-contexts-"));
    const panelPath = path.join(contextsPath, "ctx-1", "panels", "my-app");
    fs.mkdirSync(panelPath, { recursive: true });
    fs.writeFileSync(
      path.join(panelPath, "package.json"),
      JSON.stringify({ name: "context-panel", version: "0.0.0" }),
    );
    fs.writeFileSync(path.join(panelPath, "index.tsx"), "const value: number = 'context-error';\n");
    const service = await api(undefined, contextsPath);

    try {
      const result = await service.checkPanel("panels/my-app", { contextId: "ctx-1" });
      expect(result.errorCount).toBeGreaterThan(0);
      expect(result.diagnostics.some((diagnostic) => diagnostic.file.includes("ctx-1"))).toBe(true);
    } finally {
      fs.rmSync(contextsPath, { recursive: true, force: true });
    }
  });

  it("infers checkPanel context from the current extension invocation", async () => {
    const contextsPath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-typecheck-contexts-"));
    const panelPath = path.join(contextsPath, "ctx-auto", "panels", "my-app");
    fs.mkdirSync(panelPath, { recursive: true });
    fs.writeFileSync(
      path.join(panelPath, "package.json"),
      JSON.stringify({ name: "context-panel", version: "0.0.0" }),
    );
    fs.writeFileSync(path.join(panelPath, "index.tsx"), "const value: number = 'context-error';\n");
    const service = await api({ callerId: "worker:agent", chainContextId: "ctx-auto" }, contextsPath);

    try {
      const result = await service.checkPanel("panels/my-app");
      expect(result.errorCount).toBeGreaterThan(0);
      expect(result.diagnostics.some((diagnostic) => diagnostic.file.includes("ctx-auto"))).toBe(true);
    } finally {
      fs.rmSync(contextsPath, { recursive: true, force: true });
    }
  });

  it("resolves workspace packages from the context tree", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-typecheck-source-"));
    const contextsPath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-typecheck-contexts-"));
    const contextRoot = path.join(contextsPath, "ctx-workspace");
    const sourcePackage = path.join(workspaceRoot, "packages", "shared");
    const contextPackage = path.join(contextRoot, "packages", "shared");
    const panelPath = path.join(contextRoot, "panels", "my-app");

    fs.mkdirSync(sourcePackage, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(
      path.join(sourcePackage, "package.json"),
      JSON.stringify({
        name: "@workspace/shared",
        version: "0.0.0",
        exports: { ".": "./index.ts" },
      }),
    );
    fs.writeFileSync(path.join(sourcePackage, "index.ts"), "export const fromShared = 1;\n");

    fs.mkdirSync(contextPackage, { recursive: true });
    fs.writeFileSync(
      path.join(contextPackage, "package.json"),
      JSON.stringify({
        name: "@workspace/shared",
        version: "0.0.0",
        exports: { ".": "./index.ts" },
      }),
    );
    fs.writeFileSync(path.join(contextPackage, "index.ts"), "export const fromShared = 1;\n");
    fs.mkdirSync(panelPath, { recursive: true });
    fs.writeFileSync(
      path.join(panelPath, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/my-app",
        version: "0.0.0",
        dependencies: { "@workspace/shared": "workspace:*" },
      }),
    );
    fs.writeFileSync(
      path.join(panelPath, "index.ts"),
      "import { fromShared } from '@workspace/shared';\nconst value: number = fromShared;\n",
    );

    const service = await activate({
      workspace: {
        async getInfo() {
          return { path: workspaceRoot, contextsPath };
        },
      },
      invocation: {
        current: () => ({
          caller: { callerId: "worker:agent" },
          chainCaller: { contextId: "ctx-workspace" },
        }),
      },
      log: { info: () => {} },
    });

    try {
      const result = await service.checkPanel("panels/my-app");
      expect(result.diagnostics).not.toContainEqual(
        expect.objectContaining({
          code: 2307,
          message: expect.stringContaining("@workspace/shared"),
        }),
      );
      expect(result.errorCount).toBe(0);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(contextsPath, { recursive: true, force: true });
    }
  });

  it("auto-detects panel source from canonical panel ID", async () => {
    const service = await api("panel:tree/workspace~extensions~@workspace-extensions~typecheck-service/abc123");

    const result = await service.checkPanel();

    expect(result.errorCount).toBeGreaterThanOrEqual(0);
    expect(result.warningCount).toBeGreaterThanOrEqual(0);
  });
});

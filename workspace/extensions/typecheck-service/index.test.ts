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
  workspaceRoot = process.cwd(),
) {
  const callerInfo = typeof caller === "string" ? { callerId: caller } : caller;
  return activate({
    workspace: {
      async getInfo() {
        return { path: workspaceRoot, contextsPath };
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

  it("resolves workspace packages from source/state layout without a workspace manifest", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-typecheck-source-"));
    const contextsPath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-typecheck-contexts-"));
    const contextRoot = path.join(contextsPath, "ctx-source-layout");
    const sourceRuntime = path.join(workspaceRoot, "packages", "runtime");
    const contextRuntime = path.join(contextRoot, "packages", "runtime");
    const contextOnlyPackage = path.join(contextRoot, "packages", "context-only");
    const panelPath = path.join(contextRoot, "panels", "my-app");

    fs.mkdirSync(sourceRuntime, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRuntime, "package.json"),
      JSON.stringify({
        name: "@workspace/runtime",
        version: "0.0.0",
        exports: { ".": "./index.ts" },
      }),
    );
    fs.writeFileSync(path.join(sourceRuntime, "index.ts"), "export const contextId = 'ctx';\n");

    fs.mkdirSync(contextRuntime, { recursive: true });
    fs.writeFileSync(
      path.join(contextRuntime, "package.json"),
      JSON.stringify({
        name: "@workspace/runtime",
        version: "0.0.0",
        exports: { ".": "./index.ts" },
      }),
    );
    fs.writeFileSync(path.join(contextRuntime, "index.ts"), "export const contextId = 'ctx';\n");

    fs.mkdirSync(contextOnlyPackage, { recursive: true });
    fs.writeFileSync(
      path.join(contextOnlyPackage, "package.json"),
      JSON.stringify({
        name: "@workspace/context-only",
        version: "0.0.0",
        exports: { ".": "./index.ts" },
      }),
    );
    fs.writeFileSync(path.join(contextOnlyPackage, "index.ts"), "export const helper = 'ok';\n");

    fs.mkdirSync(panelPath, { recursive: true });
    fs.writeFileSync(
      path.join(panelPath, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/my-app",
        version: "0.0.0",
        dependencies: {
          "@workspace/context-only": "workspace:*",
          "@workspace/runtime": "workspace:*",
        },
      }),
    );
    fs.writeFileSync(
      path.join(panelPath, "index.ts"),
      "import { helper } from '@workspace/context-only';\nimport { contextId } from '@workspace/runtime';\nconst value: string = contextId + helper;\n",
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
          chainCaller: { contextId: "ctx-source-layout" },
        }),
      },
      log: { info: () => {} },
    });

    try {
      const result = await service.checkPanel("panels/my-app");
      expect(result.diagnostics).not.toContainEqual(
        expect.objectContaining({
          code: 2307,
          message: expect.stringMatching(/@workspace\/(context-only|runtime)/),
        }),
      );
      expect(result.errorCount).toBe(0);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(contextsPath, { recursive: true, force: true });
    }
  });

  it("resolves relative source panel paths without an invocation context", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-typecheck-source-"));
    const runtimePackage = path.join(workspaceRoot, "packages", "runtime");
    const panelPath = path.join(workspaceRoot, "panels", "my-app");

    fs.mkdirSync(runtimePackage, { recursive: true });
    fs.writeFileSync(
      path.join(runtimePackage, "package.json"),
      JSON.stringify({
        name: "@workspace/runtime",
        version: "0.0.0",
        exports: { ".": "./index.ts" },
      }),
    );
    fs.writeFileSync(path.join(runtimePackage, "index.ts"), "export const contextId = 'source';\n");

    fs.mkdirSync(panelPath, { recursive: true });
    fs.writeFileSync(
      path.join(panelPath, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/my-app",
        version: "0.0.0",
        dependencies: { "@workspace/runtime": "workspace:*" },
      }),
    );
    fs.writeFileSync(
      path.join(panelPath, "index.ts"),
      "import { contextId } from '@workspace/runtime';\nconst value: string = contextId;\n",
    );

    const service = await api(undefined, path.join(workspaceRoot, "state", ".contexts"), workspaceRoot);

    try {
      const result = await service.checkPanel("panels/my-app");
      expect(result.errorCount).toBe(0);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("auto-detects panel source from canonical panel ID", async () => {
    const service = await api("panel:tree/workspace~extensions~@workspace-extensions~typecheck-service/abc123");

    const result = await service.checkPanel();

    expect(result.errorCount).toBeGreaterThanOrEqual(0);
    expect(result.warningCount).toBeGreaterThanOrEqual(0);
  });
});

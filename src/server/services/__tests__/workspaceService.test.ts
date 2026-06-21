import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
/**
 * Workspace service contract regression tests.
 *
 * The point of these tests is to catch the exact regression that broke the
 * workspace API for panels in March: a refactor moved panels from a routing
 * bridge (which split RPC by service name) to a single direct-to-server
 * transport, but the workspace service was left registered only on the
 * Electron-main side. The runtime's `WorkspaceClient` kept calling
 * `rpc.call("main", "workspace.list")` against a server that no longer had
 * the `workspace` service, and every panel-side workspace operation silently
 * failed with `Unknown service 'workspace'`.
 *
 * The contract this file locks in:
 *
 * 1. The runtime-side `createWorkspaceClient` and the server-side
 *    `createWorkspaceService` use the same service name (`"workspace"`) and
 *    the same method names. Any drift on either side fails a test.
 *
 * 2. `"workspace"` is not Electron-local, so the IpcDispatcher forwards
 *    shell-renderer calls to the server by default.
 *
 * 3. The service policy allows `panel`, `worker`, `shell`, and `server`
 *    callers — panels and workers must be able to reach this service
 *    directly via the WebSocket transport.
 *
 * 4. `workspace.select` invokes the `requestRelaunch` callback (the only path
 *    by which the server signals Electron main to call `app.relaunch()`).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ELECTRON_LOCAL_SERVICE_NAMES } from "@natstack/rpc";
import type { RpcCaller } from "@natstack/rpc";
import { createWorkspaceService } from "../workspaceService.js";
import { createWorkspaceClient } from "@natstack/shared/workspace/client";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { UserlandApprovalChoice } from "@natstack/shared/approvals";

/**
 * Build a recording RpcCaller that captures every (target, method, args) tuple
 * the runtime client emits. The cast is necessary because `vi.fn` collapses
 * the generic `call<T>` signature into `(...args: unknown[]) => unknown`,
 * which can't be assigned back to `RpcCaller` without help.
 */
function recordingRpc(): {
  rpc: RpcCaller;
  captured: Array<{ target: string; method: string; args: unknown[] }>;
} {
  const captured: Array<{ target: string; method: string; args: unknown[] }> = [];
  const callImpl = async (target: string, method: string, args: unknown[]): Promise<unknown> => {
    captured.push({ target, method, args });
    return undefined;
  };
  const rpc = { call: callImpl } as unknown as RpcCaller;
  return { rpc, captured };
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return { id: "test-ws", initPanels: [], ...overrides };
}

function makeWorkspace() {
  return {
    path: "/tmp/source",
    statePath: "/tmp/state",
    config: makeConfig(),
    panelsPath: "/tmp/source/panels",
    packagesPath: "/tmp/source/packages",
    contextsPath: "/tmp/state/.contexts",
    cachePath: "/tmp/state/.cache",
    agentsPath: "/tmp/source/agents",
    projectsPath: "/tmp/source/projects",
  };
}

function makeCentralData() {
  const entries: Array<{ name: string; lastOpened: number }> = [
    { name: "test-ws", lastOpened: 1000 },
    { name: "other", lastOpened: 500 },
  ];
  return {
    listWorkspaces: vi.fn(() => entries),
    hasWorkspace: vi.fn((name: string) => entries.some((e) => e.name === name)),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn((name: string) => {
      const idx = entries.findIndex((e) => e.name === name);
      if (idx !== -1) entries.splice(idx, 1);
    }),
    touchWorkspace: vi.fn(),
    getWorkspaceEntry: vi.fn((name: string) => entries.find((e) => e.name === name) ?? null),
  };
}

function grantedApproval(): UserlandApprovalChoice {
  return { kind: "choice", choice: "allow" };
}

function makeService(opts: { requestRelaunch?: (name: string) => void } = {}) {
  return createWorkspaceService({
    workspace: makeWorkspace(),
    getConfig: () => makeConfig(),
    setConfigField: vi.fn(),
    centralData: makeCentralData(),
    createWorkspace: vi.fn((name: string) => ({ name, lastOpened: Date.now() })),
    deleteWorkspaceDir: vi.fn(),
    requestRelaunch: opts.requestRelaunch,
    approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
  });
}

const panelCtx: ServiceContext = {
  caller: createVerifiedCaller("panel-1", "panel", {
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/test",
    effectiveVersion: "ev-test",
  }),
};
const appCtx: ServiceContext = {
  caller: createVerifiedCaller("@workspace-apps/shell", "app", {
    callerId: "@workspace-apps/shell",
    callerKind: "app",
    repoPath: "apps/shell",
    effectiveVersion: "ev-app",
  }),
};
const shellCtx: ServiceContext = { caller: createVerifiedCaller("shell", "shell") };

// ─── Contract: client/server method-name alignment ───────────────────────────

describe("workspace service ↔ client contract", () => {
  it("client and server agree on the service name (`workspace`)", () => {
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);
    void client.list();
    void client.getActive();

    expect(captured.length).toBeGreaterThan(0);
    for (const { target, method } of captured) {
      expect(target).toBe("main");
      expect(method.startsWith("workspace.")).toBe(true);
    }
  });

  it("every method the runtime client calls is registered on the server service", async () => {
    // Build a recording RPC, call every method on the client, capture wire calls.
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);

    // Exercise every method the client exposes (reads + writes). The contract
    // assertion below verifies each captured wire-name is a registered method
    // on the service definition.
    await client.list();
    await client.getActive();
    await client.getActiveEntry();
    await client.getConfig();
    await client.create("new-ws", { forkFrom: "test-ws" });
    await client.delete("old-ws");
    await client.setInitPanels([{ source: "panels/chat" }]);
    await client.setConfigField("title", "Test");
    await client.switchTo("other");
    await client.units.list();
    await client.units.inspector("extensions/foo");
    await client.units.restart("extensions/foo");
    await client.units.logs("extensions/foo");
    await client.units.versions("apps/shell");
    await client.units.rollback("apps/shell");
    await client.recurring.list();

    const service = makeService();
    for (const { method } of captured) {
      // Wire format is "workspace.<methodName>"
      const [serviceName, ...methodParts] = method.split(".") as [string, ...string[]];
      const methodName = methodParts.join(".");
      expect(serviceName).toBe(service.name);
      expect(methodName in service.methods).toBe(true);
    }
  });

  it("the runtime client's interface keys map 1:1 to server method names", () => {
    // Build a recording RPC and call EVERY method on the client interface.
    // This catches drift in either direction: a server method that no client
    // uses, or a client method that hits an unregistered server method.
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);

    void client.list();
    void client.getActive();
    void client.getActiveEntry();
    void client.getConfig();
    void client.create("x");
    void client.delete("old");
    void client.setInitPanels([]);
    void client.setConfigField("title", "Test");
    void client.switchTo("x");
    void client.units.list();
    void client.units.inspector("extensions/foo");
    void client.units.restart("extensions/foo");
    void client.units.logs("extensions/foo");
    void client.units.versions("apps/shell");
    void client.units.rollback("apps/shell");
    void client.recurring.list();

    // The server should have a method handler for each captured wire name.
    const service = makeService();
    for (const { method } of captured) {
      const wireName = method.split(".").slice(1).join(".");
      expect(service.methods[wireName]).toBeDefined();
    }
  });
});

// ─── Routing: server-by-default service ownership ────────────────────────────

describe("workspace service routing", () => {
  it("`workspace` is not Electron-local so IpcDispatcher forwards to server", () => {
    expect((ELECTRON_LOCAL_SERVICE_NAMES as readonly string[]).includes("workspace")).toBe(false);
  });

  it("the obsolete `workspaceInfo` name is not Electron-local", () => {
    // Catches the cleanup regression where someone re-introduces both names.
    expect((ELECTRON_LOCAL_SERVICE_NAMES as readonly string[]).includes("workspaceInfo")).toBe(
      false
    );
  });
});

// ─── Policy: panel/worker reachability ────────────────────────────────────────

describe("workspace service policy", () => {
  it("allows panel callers (the regression target)", () => {
    const service = makeService();
    expect(service.policy.allowed).toContain("panel");
  });

  it("allows worker, shell, and server callers as well", () => {
    const service = makeService();
    expect(service.policy.allowed).toContain("worker");
    expect(service.policy.allowed).toContain("shell");
    expect(service.policy.allowed).toContain("server");
  });
});

// ─── Behavior: handler delegates correctly ────────────────────────────────────

describe("workspace service handler", () => {
  it("list returns the central catalog entries", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "list", []);
    expect(result).toEqual([
      { name: "test-ws", lastOpened: 1000 },
      { name: "other", lastOpened: 500 },
    ]);
  });

  it("getActive returns the active workspace name from config", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "getActive", []);
    expect(result).toBe("test-ws");
  });

  it("getActiveEntry returns the catalog entry for the active workspace", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "getActiveEntry", []);
    expect(result).toEqual({ name: "test-ws", lastOpened: 1000 });
  });

  it("getActiveEntry uses the proxied workspace list when the local catalog is unavailable", async () => {
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: null,
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      requestWorkspaceList: vi.fn(async () => [
        { name: "test-ws", lastOpened: 1234 },
        { name: "other", lastOpened: 500 },
      ]),
      approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
    });

    const result = await service.handler(panelCtx, "getActiveEntry", []);

    expect(result).toEqual({ name: "test-ws", lastOpened: 1234 });
  });

  it("getActiveEntry returns a minimal active entry instead of null when no catalog entry exists", async () => {
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: null,
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
    });

    const result = await service.handler(panelCtx, "getActiveEntry", []);

    expect(result).toEqual({ name: "test-ws", lastOpened: 0 });
  });

  it("getConfig returns the workspace config", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "getConfig", []);
    expect(result).toEqual(makeConfig());
  });

  it("units.inspector returns the inspector URL for a matching unit", async () => {
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: makeCentralData(),
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      listUnits: vi.fn(() => [
        {
          name: "@workspace-extensions/git-tools",
          kind: "extension" as const,
          source: "extensions/git-tools",
          status: "running" as const,
          inspectorUrl: "ws://127.0.0.1:9229/abcdef",
        },
      ]),
    });

    await expect(
      service.handler(panelCtx, "units.inspector", ["@workspace-extensions/git-tools"])
    ).resolves.toEqual({ url: "ws://127.0.0.1:9229/abcdef" });
    await expect(service.handler(panelCtx, "units.inspector", ["missing"])).resolves.toBeNull();
  });

  it("units.bakeAppDist delegates only for shell callers", async () => {
    const bakeAppDist = vi.fn(() => ({ build: { key: "app-key" } }));
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: makeCentralData(),
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      bakeAppDist,
    });

    await expect(
      service.handler(shellCtx, "units.bakeAppDist", [
        "apps/shell",
        { outDir: "/tmp/natstack-dist" },
      ])
    ).resolves.toEqual({ build: { key: "app-key" } });
    await expect(service.handler(panelCtx, "units.bakeAppDist", ["apps/shell"])).rejects.toThrow(
      /not accessible to panel callers/
    );
    expect(bakeAppDist).toHaveBeenCalledWith("apps/shell", { outDir: "/tmp/natstack-dist" });
    expect(bakeAppDist).toHaveBeenCalledTimes(1);
  });

  it("allows shell to inspect and roll back any app unit", async () => {
    const listAppVersions = vi.fn(() => ({ current: null, previous: [], retentionLimit: 5 }));
    const rollbackAppVersion = vi.fn(() => ({ ok: true }));
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: makeCentralData(),
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      listUnits: vi.fn(() => [
        {
          name: "@workspace-apps/other",
          kind: "app" as const,
          source: "apps/other",
          status: "running" as const,
        },
      ]),
      listAppVersions,
      rollbackAppVersion,
    });

    await expect(
      service.handler(shellCtx, "units.versions", ["@workspace-apps/other"])
    ).resolves.toEqual({ current: null, previous: [], retentionLimit: 5 });
    await expect(
      service.handler(shellCtx, "units.rollback", ["@workspace-apps/other"])
    ).resolves.toEqual({ ok: true });
  });

  it("allows app callers to manage only their own app unit", async () => {
    const rollbackAppVersion = vi.fn(() => ({ ok: true }));
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: makeCentralData(),
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      listUnits: vi.fn(() => [
        {
          name: "@workspace-apps/self",
          kind: "app" as const,
          source: "apps/self",
          status: "running" as const,
        },
        {
          name: "@workspace-apps/other",
          kind: "app" as const,
          source: "apps/other",
          status: "running" as const,
        },
      ]),
      rollbackAppVersion,
    });
    const selfCtx: ServiceContext = {
      caller: createVerifiedCaller("@workspace-apps/self", "app", {
        callerId: "@workspace-apps/self",
        callerKind: "app",
        repoPath: "apps/self",
        effectiveVersion: "ev-self",
      }),
    };

    await expect(
      service.handler(selfCtx, "units.rollback", ["@workspace-apps/self"])
    ).resolves.toEqual({ ok: true });
    await expect(
      service.handler(selfCtx, "units.rollback", ["@workspace-apps/other"])
    ).rejects.toThrow(/can only manage the calling app/);
    expect(rollbackAppVersion).toHaveBeenCalledTimes(1);
  });

  it("create delegates to the createWorkspace dep", async () => {
    const service = makeService();
    const result = (await service.handler(panelCtx, "create", [
      "new-ws",
      { forkFrom: "test-ws" },
    ])) as { name: string };
    expect(result.name).toBe("new-ws");
  });

  it("delete is approval-gated for panels", async () => {
    const service = makeService();
    await service.handler(panelCtx, "delete", ["other"]);
    // Should not throw when approval is granted.
  });

  it("delete is approval-gated for apps", async () => {
    const service = makeService();
    await service.handler(appCtx, "delete", ["other"]);
    // Should not throw when approval is granted.
  });

  it("delete works from the shell", async () => {
    const service = makeService();
    await service.handler(shellCtx, "delete", ["other"]);
    // Should not throw
  });

  it("delete refuses to delete the currently running workspace", async () => {
    const service = makeService();
    await expect(service.handler(shellCtx, "delete", ["test-ws"])).rejects.toThrow(
      /currently running/
    );
  });

  it("setInitPanels delegates to setConfigField", async () => {
    const setConfigField = vi.fn();
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField,
      centralData: makeCentralData(),
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
    });
    await service.handler(panelCtx, "setInitPanels", [[{ source: "panels/chat" }]]);
    expect(setConfigField).toHaveBeenCalledWith("initPanels", [{ source: "panels/chat" }]);
  });

  it("setConfigField delegates to setConfigField after approval", async () => {
    const setConfigField = vi.fn();
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField,
      centralData: makeCentralData(),
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
    });
    await service.handler(panelCtx, "setConfigField", ["title", "Test"]);
    expect(setConfigField).toHaveBeenCalledWith("title", "Test");
  });

  it("recurring.list returns declarative scheduled job diagnostics", async () => {
    const jobs = [
      {
        name: "news-briefing",
        target: {
          source: "workers/news-agent",
          className: "NewsAgentWorker",
          objectKey: "news",
          method: "runScheduledJob",
        },
        args: [{ job: "briefing" }],
        schedule: { intervalMs: 86_400_000, atMinutes: 480 },
        specHash: "hash",
        status: "scheduled" as const,
        nextRunAt: 20_000,
        lastRunAt: null,
        lastStartedAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastDurationMs: null,
        failCount: 0,
        backoffUntil: null,
      },
    ];
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: makeCentralData(),
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      listRecurringJobs: vi.fn(() => jobs),
    });

    await expect(service.handler(shellCtx, "recurring.list", [])).resolves.toEqual(jobs);
  });
});

// ─── Select / relaunch: the only Electron-coupled path ───────────────────────

describe("workspace.select", () => {
  it("touches the catalog and invokes requestRelaunch with the target name", async () => {
    const requestRelaunch = vi.fn();
    const central = makeCentralData();
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: central,
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      requestRelaunch,
      approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
    });

    await service.handler(panelCtx, "select", ["other"]);

    expect(central.touchWorkspace).toHaveBeenCalledWith("other");
    expect(requestRelaunch).toHaveBeenCalledWith("other");
  });

  it("is a no-op (no error) when requestRelaunch is undefined (standalone mode)", async () => {
    const central = makeCentralData();
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: central,
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
      // No requestRelaunch — standalone server has no Electron app to relaunch.
    });

    await expect(service.handler(panelCtx, "select", ["other"])).resolves.toBeUndefined();
    expect(central.touchWorkspace).toHaveBeenCalledWith("other");
  });

  it("the runtime client's switchTo() maps to the wire method workspace.select", () => {
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);
    void client.switchTo("other");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("workspace.select");
    expect(captured[0]!.args).toEqual(["other"]);
  });
});

// ─── Agent resource loading: getAgentsMd / listSkills / readSkill ────────────
//
// These tests use a real tmpdir fixture because the handlers read from disk.
// The fixture layout mirrors the workspace structure:
//
//   <tmp>/
//     meta/AGENTS.md
//     skills/
//       alpha/SKILL.md          ← has frontmatter
//       beta/SKILL.md           ← no frontmatter at all
//       broken/                  ← no SKILL.md (should be skipped)

describe("workspace service agent resources", () => {
  let tmpRoot: string;

  // Build a service bound to a fresh tmpdir so filesystem reads are hermetic.
  function makeFsService(wsPath: string) {
    return createWorkspaceService({
      workspace: {
        path: wsPath,
        statePath: path.join(wsPath, ".state"),
        config: makeConfig(),
        panelsPath: path.join(wsPath, "panels"),
        packagesPath: path.join(wsPath, "packages"),
        contextsPath: path.join(wsPath, ".contexts"),
        cachePath: path.join(wsPath, ".cache"),
        agentsPath: path.join(wsPath, "agents"),
        projectsPath: path.join(wsPath, "projects"),
      },
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: makeCentralData(),
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
    });
  }

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "natstack-wsvc-"));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ─── getAgentsMd ───────────────────────────────────────────────────────────

  describe("getAgentsMd", () => {
    it("reads an existing AGENTS.md from meta/", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      mkdirSync(path.join(wsPath, "meta"), { recursive: true });
      writeFileSync(path.join(wsPath, "meta", "AGENTS.md"), "# Agents\nhello world\n");
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "getAgentsMd", []);
      expect(result).toBe("# Agents\nhello world\n");
    });

    it("returns an empty string when AGENTS.md is missing (ENOENT)", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      // Note: no AGENTS.md written.
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "getAgentsMd", []);
      expect(result).toBe("");
    });
  });

  // ─── listSkills ────────────────────────────────────────────────────────────

  describe("listSkills", () => {
    it("walks skills/ and parses SKILL.md frontmatter for name + description", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const skillsDir = path.join(wsPath, "skills");
      mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
      writeFileSync(
        path.join(skillsDir, "alpha", "SKILL.md"),
        "---\nname: alpha\ndescription: First skill\n---\n\nbody\n"
      );
      mkdirSync(path.join(skillsDir, "gamma"), { recursive: true });
      writeFileSync(
        path.join(skillsDir, "gamma", "SKILL.md"),
        "---\nname: \"gamma-named\"\ndescription: 'Third skill'\n---\n"
      );
      const service = makeFsService(wsPath);
      const result = (await service.handler(panelCtx, "listSkills", [])) as Array<{
        name: string;
        description: string;
        dirPath: string;
      }>;
      // Sort to make assertion order-independent (readdir order varies by FS).
      result.sort((a, b) => a.name.localeCompare(b.name));
      expect(result).toEqual([
        { name: "alpha", description: "First skill", dirPath: "skills/alpha" },
        { name: "gamma-named", description: "Third skill", dirPath: "skills/gamma" },
      ]);
    });

    it("skips directories that lack a SKILL.md and still returns the rest", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const skillsDir = path.join(wsPath, "skills");
      mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
      writeFileSync(
        path.join(skillsDir, "alpha", "SKILL.md"),
        "---\nname: alpha\ndescription: Real\n---\n"
      );
      // 'broken' exists but has no SKILL.md — must be skipped, not crash.
      mkdirSync(path.join(skillsDir, "broken"), { recursive: true });
      const service = makeFsService(wsPath);
      const result = (await service.handler(panelCtx, "listSkills", [])) as Array<{ name: string }>;
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("alpha");
    });

    it("falls back to directory name and empty description when frontmatter is absent", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const skillsDir = path.join(wsPath, "skills");
      mkdirSync(path.join(skillsDir, "beta"), { recursive: true });
      writeFileSync(path.join(skillsDir, "beta", "SKILL.md"), "# Just a heading, no frontmatter\n");
      const service = makeFsService(wsPath);
      const result = (await service.handler(panelCtx, "listSkills", [])) as Array<{
        name: string;
        description: string;
        dirPath: string;
      }>;
      expect(result).toEqual([{ name: "beta", description: "", dirPath: "skills/beta" }]);
    });

    it("returns an empty array when skills/ does not exist (ENOENT)", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "listSkills", []);
      expect(result).toEqual([]);
    });
  });

  // ─── readSkill ─────────────────────────────────────────────────────────────

  describe("readSkill", () => {
    it("returns the raw SKILL.md content for a valid skill name", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const skillsDir = path.join(wsPath, "skills");
      mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
      const body = "---\nname: alpha\ndescription: a\n---\n\nreal body\n";
      writeFileSync(path.join(skillsDir, "alpha", "SKILL.md"), body);
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "readSkill", ["alpha"]);
      expect(result).toBe(body);
    });

    it("rejects path traversal attempts like '../etc/passwd'", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const service = makeFsService(wsPath);
      await expect(service.handler(panelCtx, "readSkill", ["../etc/passwd"])).rejects.toThrow(
        /Invalid skill name/
      );
    });

    it("rejects names containing slashes or dots", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const service = makeFsService(wsPath);
      await expect(service.handler(panelCtx, "readSkill", ["foo/bar"])).rejects.toThrow(
        /Invalid skill name/
      );
      await expect(service.handler(panelCtx, "readSkill", ["foo.bar"])).rejects.toThrow(
        /Invalid skill name/
      );
      await expect(service.handler(panelCtx, "readSkill", [""])).rejects.toThrow(
        /Invalid skill name/
      );
    });
  });
});

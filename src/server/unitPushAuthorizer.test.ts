import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { UnitBatchEntry } from "@natstack/shared/approvals";

import {
  createWorkspaceMetaPushAuthorizer,
  createWorkspaceUnitPushAuthorizer,
} from "./unitPushAuthorizer.js";

function panelCaller(id = "panel:one") {
  return createVerifiedCaller(id, "panel", {
    callerId: id,
    callerKind: "panel",
    repoPath: "panels/test",
    effectiveVersion: "ev-panel",
  });
}

function unit(kind: "extension" | "app", name: string, ref = "main"): UnitBatchEntry {
  return {
    unitKind: kind,
    unitName: name,
    displayName: name,
    source: {
      kind: "internal-git",
      repo: `${kind === "app" ? "apps" : "extensions"}/${name}`,
      ref,
    },
    ev: `ev-${name}`,
    target: kind === "app" ? "electron" : null,
    capabilities: kind === "app" ? ["notifications"] : ["node:fs"],
  };
}

function grantStore() {
  const active = new Set<string>();
  return {
    active,
    hasActive: vi.fn((key: string) => active.has(key)),
    grant: vi.fn((key: string) => {
      active.add(key);
    }),
  };
}

describe("createWorkspaceUnitPushAuthorizer", () => {
  const caller = createVerifiedCaller("panel:one", "panel");

  it("routes app and extension pushes by normalized source root", async () => {
    const appHandler = { authorizeSourcePush: vi.fn(async () => ({ allowed: true })) };
    const extensionHandler = { authorizeSourcePush: vi.fn(async () => ({ allowed: true })) };
    const authorize = createWorkspaceUnitPushAuthorizer({
      targets: [
        { sourceRoot: "apps", getHandler: () => appHandler },
        { sourceRoot: "extensions", getHandler: () => extensionHandler },
      ],
      getMetaHandler: () => extensionHandler,
    });

    await authorize({
      caller,
      repoPath: "/workspace/apps/shell.git",
      branch: "main",
      commit: "abc",
    });
    await authorize({
      caller,
      repoPath: "extensions/react-native",
      branch: "main",
      commit: "def",
    });

    expect(appHandler.authorizeSourcePush).toHaveBeenCalledOnce();
    expect(appHandler.authorizeSourcePush).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "apps/shell",
      })
    );
    expect(extensionHandler.authorizeSourcePush).toHaveBeenCalledOnce();
    expect(extensionHandler.authorizeSourcePush).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "extensions/react-native",
      })
    );
  });

  it("routes meta pushes to the combined meta handler", async () => {
    const metaHandler = {
      authorizeSourcePush: vi.fn(async () => ({ allowed: false, reason: "denied" })),
    };
    const authorize = createWorkspaceUnitPushAuthorizer({
      targets: [],
      getMetaHandler: () => metaHandler,
    });

    await expect(
      authorize({
        caller,
        repoPath: "meta",
        branch: "main",
        commit: "abc",
      })
    ).resolves.toEqual({ allowed: false, reason: "denied" });
    expect(metaHandler.authorizeSourcePush).toHaveBeenCalledOnce();
  });

  it("allows non-unit pushes without touching unit hosts", async () => {
    const appHandler = { authorizeSourcePush: vi.fn(async () => ({ allowed: false })) };
    const authorize = createWorkspaceUnitPushAuthorizer({
      targets: [{ sourceRoot: "apps", getHandler: () => appHandler }],
      getMetaHandler: () => null,
    });

    await expect(
      authorize({
        caller,
        repoPath: "panels/main",
        branch: "main",
        commit: "abc",
      })
    ).resolves.toEqual({ allowed: true });
    expect(appHandler.authorizeSourcePush).not.toHaveBeenCalled();
  });

  it("fails closed for unit source pushes when the owning host is unavailable", async () => {
    const authorize = createWorkspaceUnitPushAuthorizer({
      targets: [{ sourceRoot: "apps", getHandler: () => null }],
      getMetaHandler: () => null,
    });

    await expect(
      authorize({
        caller,
        repoPath: "apps/shell",
        branch: "main",
        commit: "abc",
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "Workspace apps push authorizer is unavailable",
    });
  });

  it("fails closed for meta pushes when the combined meta handler is unavailable", async () => {
    const authorize = createWorkspaceUnitPushAuthorizer({
      targets: [],
      getMetaHandler: () => null,
    });

    await expect(
      authorize({
        caller,
        repoPath: "meta",
        branch: "main",
        commit: "abc",
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "Workspace config push authorizer is unavailable",
    });
  });
});

describe("createWorkspaceMetaPushAuthorizer", () => {
  it("combines app and extension meta approvals and preapproves exact pushed commit identities", async () => {
    const extensionProvider = {
      metaPushApprovalForCommit: vi.fn(() => ({
        units: [unit("extension", "@workspace-extensions/git-tools", "feature")],
        identityKeys: ["extension-key"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const appProvider = {
      metaPushApprovalForCommit: vi.fn(() => ({
        units: [unit("app", "@workspace-apps/shell")],
        identityKeys: ["app-key"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const approvalQueue = { request: vi.fn(async () => "once" as const) };
    const authorize = createWorkspaceMetaPushAuthorizer({
      workspacePath: "/workspace",
      approvalQueue,
      grantStore: grantStore(),
      grantTtlMs: 1000,
      getProviders: () => [extensionProvider, appProvider],
      resolveMetaCommit: (commit) => `resolved-${commit}`,
      summarizeMetaDiff: () => "1 file(s) changed, +2 -0",
    });

    await expect(
      authorize.authorizeSourcePush({
        caller: panelCaller("panel-1"),
        repoPath: "meta",
        branch: "main",
        commit: "abc123",
      })
    ).resolves.toEqual({ allowed: true });

    expect(extensionProvider.metaPushApprovalForCommit).toHaveBeenCalledWith("abc123");
    expect(appProvider.metaPushApprovalForCommit).toHaveBeenCalledWith("abc123");
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/test",
        effectiveVersion: "ev-panel",
        dedupKey: "unit-meta-push:panel-1:main:resolved-abc123",
        trigger: "meta-push",
        title: "Workspace units changed",
        units: [
          expect.objectContaining({
            unitKind: "extension",
            unitName: "@workspace-extensions/git-tools",
            source: expect.objectContaining({ ref: "feature" }),
          }),
          expect.objectContaining({ unitKind: "app", unitName: "@workspace-apps/shell" }),
        ],
        configWrite: { repoPath: "meta", summary: "1 file(s) changed, +2 -0" },
      })
    );
    expect(extensionProvider.acceptPreapprovedTrust).toHaveBeenCalledWith("resolved-abc123", [
      "extension-key",
    ]);
    expect(appProvider.acceptPreapprovedTrust).toHaveBeenCalledWith("resolved-abc123", ["app-key"]);
  });

  it("does not let a meta session grant skip new unit declaration approval", async () => {
    const store = grantStore();
    const provider = {
      metaPushApprovalForCommit: vi
        .fn()
        .mockReturnValueOnce({ units: [], identityKeys: [] })
        .mockReturnValueOnce({
          units: [unit("extension", "@workspace-extensions/git-tools")],
          identityKeys: ["extension-key"],
        }),
      acceptPreapprovedTrust: vi.fn(),
    };
    const approvalQueue = { request: vi.fn(async () => "session" as const) };
    const authorize = createWorkspaceMetaPushAuthorizer({
      workspacePath: "/workspace",
      approvalQueue,
      grantStore: store,
      grantTtlMs: 1000,
      getProviders: () => [provider],
      resolveMetaCommit: (commit) => commit,
      summarizeMetaDiff: () => "workspace config change",
    });
    const request = {
      caller: panelCaller("panel-1"),
      repoPath: "meta",
      branch: "main",
      commit: "config-only",
    };

    await expect(authorize.authorizeSourcePush(request)).resolves.toEqual({ allowed: true });
    await expect(
      authorize.authorizeSourcePush({ ...request, commit: "adds-extension" })
    ).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledWith("adds-extension", [
      "extension-key",
    ]);
  });

  it("canonicalizes meta push branches for session grants and dedup keys", async () => {
    const store = grantStore();
    const provider = {
      metaPushApprovalForCommit: vi.fn(() => ({ units: [], identityKeys: [] })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const approvalQueue = { request: vi.fn(async () => "session" as const) };
    const authorize = createWorkspaceMetaPushAuthorizer({
      workspacePath: "/workspace",
      approvalQueue,
      grantStore: store,
      grantTtlMs: 1000,
      getProviders: () => [provider],
      resolveMetaCommit: (commit) => commit,
      summarizeMetaDiff: () => "workspace config change",
    });
    const request = {
      caller: panelCaller("panel-1"),
      repoPath: "meta",
      branch: "refs/heads/main",
      commit: "config-only",
    };

    await expect(authorize.authorizeSourcePush(request)).resolves.toEqual({ allowed: true });
    await expect(authorize.authorizeSourcePush({ ...request, branch: "main" })).resolves.toEqual({
      allowed: true,
    });

    expect(approvalQueue.request).toHaveBeenCalledOnce();
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "unit-meta-push:panel-1:main:config-only",
      })
    );
    expect(store.active.has("panel-1\u0000meta\u0000meta\u0000main")).toBe(true);
  });

  it("allows trusted internal meta pushes without prompting", async () => {
    const approvalQueue = { request: vi.fn(async () => "deny" as const) };
    const provider = {
      metaPushApprovalForCommit: vi.fn(() => ({
        units: [unit("app", "@workspace-apps/shell")],
        identityKeys: ["app-key"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const authorize = createWorkspaceMetaPushAuthorizer({
      workspacePath: "/workspace",
      approvalQueue,
      grantStore: grantStore(),
      grantTtlMs: 1000,
      getProviders: () => [provider],
    });

    await expect(
      authorize.authorizeSourcePush({
        caller: createVerifiedCaller("server:bootstrap", "server"),
        repoPath: "meta",
        branch: "main",
        commit: "abc123",
      })
    ).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(provider.metaPushApprovalForCommit).not.toHaveBeenCalled();
  });

  it("rejects unsupported userland callers before requesting approval", async () => {
    const approvalQueue = { request: vi.fn(async () => "once" as const) };
    const authorize = createWorkspaceMetaPushAuthorizer({
      workspacePath: "/workspace",
      approvalQueue,
      grantStore: grantStore(),
      grantTtlMs: 1000,
      getProviders: () => [],
    });

    await expect(
      authorize.authorizeSourcePush({
        caller: createVerifiedCaller("extension:tools", "extension"),
        repoPath: "meta",
        branch: "main",
        commit: "abc123",
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "Workspace config pushes from extension callers are not supported",
    });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });
});

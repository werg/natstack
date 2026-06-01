import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { UnitBatchEntry } from "@natstack/shared/approvals";
import type { ApprovalQueue } from "./services/approvalQueue.js";
import { CapabilityGrantStore } from "./services/capabilityGrantStore.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createWorkspaceMetaPushAuthorizer,
  createWorkspaceRepoPushAuthorizer,
  createWorkspacePushAuthorizer,
} from "./workspacePushAuthorizer.js";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-workspace-push-"));
}

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

function createApprovalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "session"
): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestUserland: vi.fn(async () => ({ kind: "dismissed" as const })),
    presentDeviceCode: vi.fn(() => ({
      approvalId: "device-code-test",
      cancelled: new AbortController().signal,
      dispose: vi.fn(),
    })),
    resolve: vi.fn(),
    resolveUserland: vi.fn(),
    submitClientConfig: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
    cancelForCaller: vi.fn(),
  };
}

describe("createWorkspacePushAuthorizer", () => {
  const caller = createVerifiedCaller("panel:one", "panel");

  it("routes app and extension pushes by normalized source root", async () => {
    const appHandler = { authorizeSourcePush: vi.fn(async () => ({ allowed: true })) };
    const extensionHandler = { authorizeSourcePush: vi.fn(async () => ({ allowed: true })) };
    const authorize = createWorkspacePushAuthorizer({
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
    const authorize = createWorkspacePushAuthorizer({
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
    const authorize = createWorkspacePushAuthorizer({
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

  it("routes non-unit pushes to a fallback authorizer when configured", async () => {
    const appHandler = { authorizeSourcePush: vi.fn(async () => ({ allowed: false })) };
    const fallbackHandler = { authorizeSourcePush: vi.fn(async () => ({ allowed: true })) };
    const authorize = createWorkspacePushAuthorizer({
      targets: [{ sourceRoot: "apps", getHandler: () => appHandler }],
      getMetaHandler: () => null,
      getFallbackHandler: () => fallbackHandler,
    });

    await expect(
      authorize({
        caller,
        repoPath: "panels/main",
        branch: "refs/heads/main",
        commit: "abc",
      })
    ).resolves.toEqual({ allowed: true });
    expect(appHandler.authorizeSourcePush).not.toHaveBeenCalled();
    expect(fallbackHandler.authorizeSourcePush).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "panels/main",
        branch: "refs/heads/main",
        commit: "abc",
      })
    );
  });

  it("fails closed for unit source pushes when the owning host is unavailable", async () => {
    const authorize = createWorkspacePushAuthorizer({
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
    const authorize = createWorkspacePushAuthorizer({
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

describe("createWorkspaceRepoPushAuthorizer", () => {
  it("requests push-specific approval for generic workspace repos", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const authorizer = createWorkspaceRepoPushAuthorizer({ approvalQueue, grantStore });

    await expect(
      authorizer.authorizeSourcePush({
        caller: panelCaller("panel-1"),
        repoPath: "/panels/spectrolite.git",
        branch: "refs/heads/main",
        commit: "abcdef1234567890",
      })
    ).resolves.toEqual({ allowed: true });
    await expect(
      authorizer.authorizeSourcePush({
        caller: panelCaller("panel-1"),
        repoPath: "panels/spectrolite",
        branch: "main",
        commit: "fedcba0987654321",
      })
    ).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        capability: "internal-git-write",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/test",
        effectiveVersion: "ev-panel",
        dedupKey: "workspace-source-push:panels/spectrolite:main:abcdef1234567890",
        resource: {
          type: "git-repo",
          label: "Repository",
          value: "panels/spectrolite",
        },
        grantResourceKey: "workspace-source-push:panels/spectrolite:main",
        details: [
          { label: "Operation", value: "git push" },
          { label: "Branch", value: "main" },
          { label: "Commit", value: "abcdef1234567890" },
        ],
      })
    );
  });

  it("does not reuse broad internal git write grants for concrete pushes", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const caller = panelCaller("panel-1");
    const identity = caller.code;
    if (!identity) throw new Error("expected test caller identity");
    grantStore.grant("internal-git-write", "panels/spectrolite", identity, "session");
    const authorizer = createWorkspaceRepoPushAuthorizer({ approvalQueue, grantStore });

    await expect(
      authorizer.authorizeSourcePush({
        caller,
        repoPath: "panels/spectrolite",
        branch: "main",
        commit: "abcdef1234567890",
      })
    ).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledOnce();
  });

  it("denies generic workspace pushes when the caller has no code identity", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const authorizer = createWorkspaceRepoPushAuthorizer({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });

    await expect(
      authorizer.authorizeSourcePush({
        caller: createVerifiedCaller("panel-unknown", "panel"),
        repoPath: "panels/spectrolite",
        branch: "main",
        commit: "abcdef1234567890",
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "Unknown capability caller: panel-unknown",
    });
    expect(approvalQueue.request).not.toHaveBeenCalled();
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

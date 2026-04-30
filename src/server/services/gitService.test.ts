import { describe, expect, it, vi } from "vitest";
import { createGitService } from "./gitService.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-git-service-"));
}

function createApprovalQueueMock(): ApprovalQueue {
  return {
    request: vi.fn(async () => "deny" as const),
    requestOAuthClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    resolve: vi.fn(),
    submitOAuthClientConfig: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
  };
}

describe("gitService", () => {
  it("restricts git token minting RPCs to shell and server callers", () => {
    const service = createGitService({
      gitServer: {} as never,
      tokenManager: {} as never,
    });

    expect(service.methods["getTokenForPanel"]?.policy).toEqual({ allowed: ["shell", "server"] });
    expect(service.methods["revokeTokenForPanel"]?.policy).toEqual({ allowed: ["shell", "server"] });
  });

  it("gates panel-created repositories through git write permission", async () => {
    const approvalQueue = createApprovalQueueMock();
    const service = createGitService({
      gitServer: {} as never,
      tokenManager: {} as never,
      workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), "natstack-workspace-")),
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "panel:source",
          callerKind: "panel",
          repoPath: "panels/source",
          effectiveVersion: "version-1",
        }),
      },
    });

    await expect(service.handler(
      { callerId: "panel:source", callerKind: "panel" },
      "createRepo",
      ["panels/new"],
    )).rejects.toThrow("Git write permission denied");

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "capability",
      capability: "internal-git-write",
      dedupKey: null,
      repoPath: "panels/source",
      effectiveVersion: "version-1",
      resource: {
        type: "git-repo",
        label: "Repository",
        value: "panels/new",
      },
    }));
  });

  it("rejects escaping createRepo paths before prompting for permission", async () => {
    const approvalQueue = createApprovalQueueMock();
    const service = createGitService({
      gitServer: {} as never,
      tokenManager: {} as never,
      workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), "natstack-workspace-")),
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "panel:source",
          callerKind: "panel",
          repoPath: "panels/source",
          effectiveVersion: "version-1",
        }),
      },
    });

    await expect(service.handler(
      { callerId: "panel:source", callerKind: "panel" },
      "createRepo",
      ["../outside"],
    )).rejects.toThrow("Invalid repo path: escapes workspace root");

    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("uses a targeted approval for shared remote configuration", async () => {
    const approvalQueue = createApprovalQueueMock();
    const service = createGitService({
      gitServer: {} as never,
      tokenManager: {} as never,
      workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), "natstack-workspace-")),
      workspaceConfig: { id: "test", git: {} },
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "panel:source",
          callerKind: "panel",
          repoPath: "panels/source",
          effectiveVersion: "version-1",
        }),
      },
    });

    await expect(service.handler(
      { callerId: "panel:source", callerKind: "panel" },
      "setSharedRemote",
      ["panels/chat", { name: "origin", url: "https://github.com/acme/chat.git" }],
    )).rejects.toThrow("Shared remote configuration denied");

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "capability",
      capability: "workspace-shared-git-remote",
      dedupKey: null,
      title: "Configure shared remote",
      resource: {
        type: "git-remote",
        label: "Workspace repo",
        value: "panels/chat",
      },
      details: expect.arrayContaining([
        { label: "Operation", value: "Add or update shared remote" },
        { label: "Repository path", value: "panels/chat" },
        { label: "Remote name", value: "origin" },
        { label: "Remote URL", value: "github.com/acme/chat.git" },
      ]),
    }));
  });

  it("uses a targeted approval for workspace repo imports", async () => {
    const approvalQueue = createApprovalQueueMock();
    const service = createGitService({
      gitServer: {} as never,
      tokenManager: {} as never,
      workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), "natstack-workspace-")),
      workspaceConfig: { id: "test", git: {} },
      egressProxy: {} as never,
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "panel:source",
          callerKind: "panel",
          repoPath: "panels/source",
          effectiveVersion: "version-1",
        }),
      },
    });

    await expect(service.handler(
      { callerId: "panel:source", callerKind: "panel" },
      "importProject",
      [{
        path: "skills/example",
        remote: { name: "origin", url: "https://github.com/acme/example.git" },
      }],
    )).rejects.toThrow("Project import denied");

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "capability",
      capability: "workspace-project-import",
      dedupKey: null,
      title: "Add project repo",
      resource: {
        type: "workspace-project",
        label: "Project path",
        value: "skills/example",
      },
      details: expect.arrayContaining([
        { label: "Project path", value: "skills/example" },
        { label: "Remote name", value: "origin" },
        { label: "Remote URL", value: "github.com/acme/example.git" },
      ]),
    }));
  });

  it("rejects imports outside supported workspace source parents before prompting", async () => {
    const approvalQueue = createApprovalQueueMock();
    const service = createGitService({
      gitServer: {} as never,
      tokenManager: {} as never,
      workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), "natstack-workspace-")),
      workspaceConfig: { id: "test", git: {} },
      egressProxy: {} as never,
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "panel:source",
          callerKind: "panel",
          repoPath: "panels/source",
          effectiveVersion: "version-1",
        }),
      },
    });

    await expect(service.handler(
      { callerId: "panel:source", callerKind: "panel" },
      "importProject",
      [{
        path: "random/example",
        remote: { name: "origin", url: "https://github.com/acme/example.git" },
      }],
    )).rejects.toThrow("Imports must target one of");

    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("completes missing configured workspace dependencies through import approvals", async () => {
    const approvalQueue = createApprovalQueueMock();
    const gitServer = {
      getWorkspaceTree: vi.fn(async () => ({
        children: [
          { name: "panels", path: "panels", isGitRepo: false, children: [
            { name: "present", path: "panels/present", isGitRepo: true, children: [] },
          ] },
        ],
      })),
      invalidateTreeCache: vi.fn(),
    };
    const service = createGitService({
      gitServer: gitServer as never,
      tokenManager: {} as never,
      workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), "natstack-workspace-")),
      workspaceConfig: {
        id: "test",
        git: {
          remotes: {
            panels: {
              present: { origin: "https://github.com/acme/present.git" },
            },
            skills: {
              missing: {
                origin: "https://github.com/acme/missing.git",
                ci: "https://github.com/acme/missing-ci.git",
              },
            },
            random: {
              unsupported: { origin: "https://github.com/acme/unsupported.git" },
            },
          },
        },
      },
      egressProxy: {} as never,
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "panel:source",
          callerKind: "panel",
          repoPath: "panels/source",
          effectiveVersion: "version-1",
        }),
      },
    });

    const result = await service.handler(
      { callerId: "panel:source", callerKind: "panel" },
      "completeWorkspaceDependencies",
      [{}],
    );

    expect(result).toEqual({
      imported: [],
      skipped: [
        { path: "panels/present", reason: "already-present" },
        { path: "random/unsupported", reason: "unsupported-path" },
      ],
      failed: [
        { path: "skills/missing", error: "Project import denied" },
      ],
    });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      capability: "workspace-project-import",
      resource: expect.objectContaining({
        value: "skills/missing",
      }),
    }));
  });
});

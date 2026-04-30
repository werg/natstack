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
    resolve: vi.fn(),
    submitOAuthClientConfig: vi.fn(),
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
});

import { describe, expect, it, vi } from "vitest";
import { createGitWriteAuthorizer, INTERNAL_GIT_WRITE_CAPABILITY } from "./gitWritePermission.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-git-write-"));
}

function createApprovalQueueMock(decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "session"): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestOAuthClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    resolve: vi.fn(),
    submitOAuthClientConfig: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
  };
}

describe("gitWritePermission", () => {
  it("requests permission for internal git writes and reuses session grants", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const authorizer = createGitWriteAuthorizer({
      approvalQueue,
      grantStore,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "panel:source",
          callerKind: "panel",
          repoPath: "panels/source",
          effectiveVersion: "version-1",
        }),
      },
    });

    await expect(authorizer({
      callerId: "panel:source",
      callerKind: "panel",
      repoPath: "/panels/target.git",
    })).resolves.toMatchObject({ allowed: true });
    await expect(authorizer({
      callerId: "panel:source",
      callerKind: "panel",
      repoPath: "panels/target",
    })).resolves.toMatchObject({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "capability",
      capability: INTERNAL_GIT_WRITE_CAPABILITY,
      dedupKey: null,
      repoPath: "panels/source",
      effectiveVersion: "version-1",
      resource: {
        type: "git-repo",
        label: "Repository",
        value: "panels/target",
      },
    }));
  });

  it("does not reuse allow-once git write permissions", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const authorizer = createGitWriteAuthorizer({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:source",
          callerKind: "worker",
          repoPath: "workers/source",
          effectiveVersion: "version-1",
        }),
      },
    });

    await authorizer({ callerId: "worker:source", callerKind: "worker", repoPath: "packages/target" });
    await authorizer({ callerId: "worker:source", callerKind: "worker", repoPath: "packages/target" });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("uses sensitive config copy for meta repo pushes", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const authorizer = createGitWriteAuthorizer({
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

    await authorizer({ callerId: "panel:source", callerKind: "panel", repoPath: "meta" });

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      title: "Edit workspace config",
      description: "Allow this code version to push changes to sensitive workspace configuration.",
      resource: {
        type: "git-repo",
        label: "Config repository",
        value: "meta",
      },
      details: expect.arrayContaining([
        { label: "Operation", value: "git push to meta" },
        { label: "Scope", value: "Workspace prompts, settings, and shared git remotes" },
      ]),
    }));
  });

  it("denies unknown callers before prompting", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const authorizer = createGitWriteAuthorizer({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: () => null,
      },
    });

    await expect(authorizer({
      callerId: "panel:unknown",
      callerKind: "panel",
      repoPath: "panels/target",
    })).resolves.toMatchObject({
      allowed: false,
      reason: "Unknown capability caller: panel:unknown",
    });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });
});

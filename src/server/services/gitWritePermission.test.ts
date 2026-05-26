import { describe, expect, it, vi } from "vitest";
import { createGitWriteAuthorizer, INTERNAL_GIT_WRITE_CAPABILITY } from "./gitWritePermission.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-git-write-"));
}

function caller(
  id: string,
  kind: "panel" | "app" | "worker" | "do",
  repoPath: string,
  effectiveVersion = "version-1"
) {
  return createVerifiedCaller(id, kind, {
    callerId: id,
    callerKind: kind,
    repoPath,
    effectiveVersion,
  });
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

describe("gitWritePermission", () => {
  it.each([
    ["panel", "panel-source"],
    ["app", "app:apps/shell:desktop"],
    ["worker", "worker:source"],
    ["do", "do:source:WorkspaceDO:object"],
  ] as const)("requests permission for %s internal git writes", async (kind, callerId) => {
    const approvalQueue = createApprovalQueueMock("session");
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const authorizer = createGitWriteAuthorizer({
      approvalQueue,
      grantStore,
    });

    await expect(
      authorizer({
        caller: caller(callerId, kind, "panels/source"),
        repoPath: "/panels/target.git",
      })
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizer({
        caller: caller(callerId, kind, "panels/source"),
        repoPath: "panels/target",
      })
    ).resolves.toMatchObject({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        capability: INTERNAL_GIT_WRITE_CAPABILITY,
        dedupKey: null,
        repoPath: "panels/source",
        effectiveVersion: "version-1",
        callerId,
        callerKind: kind,
        resource: {
          type: "git-repo",
          label: "Repository",
          value: "panels/target",
        },
      })
    );
  });

  it("requests approval for protected internal repo paths", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const authorizer = createGitWriteAuthorizer({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });

    await expect(
      authorizer({
        caller: caller("panel-source", "panel", "panels/source"),
        repoPath: "tree/panels/target",
      })
    ).resolves.toMatchObject({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: {
          type: "git-repo",
          label: "Repository",
          value: "tree/panels/target",
        },
      })
    );
  });

  it("does not reuse allow-once git write permissions", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const authorizer = createGitWriteAuthorizer({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });

    await authorizer({
      caller: caller("worker:source", "worker", "workers/source"),
      repoPath: "packages/target",
    });
    await authorizer({
      caller: caller("worker:source", "worker", "workers/source"),
      repoPath: "packages/target",
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("defers meta repo pushes to the push-phase combined approval without prompting here", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const authorizer = createGitWriteAuthorizer({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });

    await expect(
      authorizer({
        caller: caller("panel-source", "panel", "panels/source"),
        repoPath: "meta",
      })
    ).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("denies unknown callers before prompting", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const authorizer = createGitWriteAuthorizer({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });

    await expect(
      authorizer({
        caller: createVerifiedCaller("panel-unknown", "panel"),
        repoPath: "panels/target",
      })
    ).resolves.toMatchObject({
      allowed: false,
      reason: "Unknown capability caller: panel-unknown",
    });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });
});

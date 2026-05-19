import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ApprovalQueue } from "./approvalQueue.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { createCorsApprovalService } from "./corsApprovalService.js";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-cors-approval-"));
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

describe("corsApprovalService", () => {
  it("approval-gates DO access to target origins", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const service = createCorsApprovalService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });
    const ctx = {
      caller: createVerifiedCaller("do:workers/agent-worker:AiChatWorker:agent-1", "do", {
        callerId: "do:workers/agent-worker:AiChatWorker:agent-1",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "version-1",
      }),
    };

    await expect(
      service.handler(ctx, "authorize", [
        {
          targetUrl: "https://api.example.com/v1/models",
          requestOrigin: "http://localhost:9100",
        },
      ])
    ).resolves.toMatchObject({ allowed: true, decision: "session" });
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: "do:workers/agent-worker:AiChatWorker:agent-1",
        callerKind: "do",
        repoPath: "workers/agent-worker",
      })
    );
  });

  it("approval-gates panel access to target origins", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const service = createCorsApprovalService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });
    const ctx = {
      caller: createVerifiedCaller("panel-1", "panel", {
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "workspace/panels/chat",
        effectiveVersion: "version-1",
      }),
    };

    await expect(
      service.handler(ctx, "authorize", [
        {
          targetUrl: "https://api.example.com/v1/models",
          requestOrigin: "http://localhost:9100",
        },
      ])
    ).resolves.toMatchObject({ allowed: true, decision: "session" });
    await expect(
      service.handler(ctx, "authorize", [
        {
          targetUrl: "https://api.example.com/v1/other",
          requestOrigin: "http://localhost:9100",
        },
      ])
    ).resolves.toMatchObject({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "cors-response-read",
        resource: {
          type: "url-origin",
          label: "Target origin",
          value: "https://api.example.com",
        },
      })
    );
  });

  it("rejects callers without verified code identity", async () => {
    const service = createCorsApprovalService({
      approvalQueue: createApprovalQueueMock(),
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("panel-1", "panel") }, "authorize", [
        { targetUrl: "https://api.example.com/" },
      ])
    ).resolves.toMatchObject({ allowed: false, reason: "Unknown capability caller: panel-1" });
  });
});

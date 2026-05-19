import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { normalizeCallerKind, requestCapabilityPermission } from "./capabilityPermission.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-capability-"));
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

describe("capabilityPermission", () => {
  it("stores reusable grants with a stable resource key", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = {
      caller: createVerifiedCaller("panel-source", "panel", {
        callerId: "panel-source",
        callerKind: "panel",
        repoPath: "panels/source",
        effectiveVersion: "version-1",
      }),
      capability: "example-capability",
      resource: {
        type: "example",
        label: "Example",
        value: "Display value",
        key: "stable-key",
      },
      title: "Example action",
      deniedReason: "Denied",
    };

    await expect(requestCapabilityPermission(deps, request)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(requestCapabilityPermission(deps, request)).resolves.toMatchObject({
      allowed: true,
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: {
          type: "example",
          label: "Example",
          value: "Display value",
        },
      })
    );
  });

  it.each(["version", "repo"] as const)("reuses %s-scoped capability grants", async (decision) => {
    const approvalQueue = createApprovalQueueMock(decision);
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = {
      caller: createVerifiedCaller("worker:source", "worker", {
        callerId: "worker:source",
        callerKind: "worker",
        repoPath: "workers/source",
        effectiveVersion: "version-1",
      }),
      capability: "example-capability",
      resource: { type: "example", label: "Example", value: "stable-key" },
      title: "Example action",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, request);
    await requestCapabilityPermission(deps, request);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  describe("normalizeCallerKind", () => {
    it("accepts panel, worker, and do caller kinds", () => {
      expect(normalizeCallerKind("panel")).toBe("panel");
      expect(normalizeCallerKind("worker")).toBe("worker");
      expect(normalizeCallerKind("do")).toBe("do");
    });

    it("rejects shell, server, extension, and harness caller kinds", () => {
      expect(normalizeCallerKind("shell")).toBeNull();
      expect(normalizeCallerKind("server")).toBeNull();
      expect(normalizeCallerKind("extension")).toBeNull();
      expect(normalizeCallerKind("harness")).toBeNull();
    });
  });

  it("does not store allow-once grants", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = {
      caller: createVerifiedCaller("worker:source", "worker", {
        callerId: "worker:source",
        callerKind: "worker",
        repoPath: "workers/source",
        effectiveVersion: "version-1",
      }),
      capability: "example-capability",
      resource: { type: "example", label: "Example", value: "stable-key" },
      title: "Example action",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, request);
    await requestCapabilityPermission(deps, request);

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });
});

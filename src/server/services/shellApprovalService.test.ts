import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, ServiceError } from "@natstack/shared/serviceDispatcher";
import type { PendingApproval, PendingUnitBatchApproval } from "@natstack/shared/approvals";
import { createApprovalQueue } from "./approvalQueue.js";
import { createShellApprovalService } from "./shellApprovalService.js";
import { createPushMetrics } from "./pushMetrics.js";

function startupApproval(id = "startup-1"): PendingUnitBatchApproval {
  return {
    kind: "unit-batch",
    approvalId: id,
    callerId: "system:startup",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "ev:startup",
    requestedAt: 10,
    title: "Workspace apps need approval",
    description: "Approve startup apps.",
    trigger: "startup",
    units: [
      {
        unitKind: "app",
        unitName: "@workspace-apps/shell",
        displayName: "Shell",
        source: { kind: "workspace-repo", repo: "apps/shell", ref: "HEAD" },
        ev: "ev:startup",
        capabilities: ["panel-hosting"],
      },
    ],
  };
}

describe("shellApprovalService", () => {
  it("accepts every approval decision exposed by the consent UI", () => {
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveUserland: vi.fn(),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
        cancelForCaller: vi.fn(),
      },
    });

    for (const decision of ["once", "session", "version", "repo", "deny", "dismiss"] as const) {
      expect(() => service.methods["resolve"]?.args.parse(["approval-1", decision])).not.toThrow();
    }
  });

  it("validates userland choices against the pending prompt", async () => {
    const resolve = vi.fn();
    const resolveUserland = vi.fn();
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveUserland,
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => [
          {
            approvalId: "approval-1",
            callerId: "worker:alpha",
            callerKind: "worker" as const,
            repoPath: "workers/alpha",
            effectiveVersion: "hash-1",
            requestedAt: 10,
            kind: "userland" as const,
            subject: { id: "team-x:foo" },
            title: "Allow foo?",
            promptOptions: "choices" as const,
            options: [{ value: "allow", label: "Allow" }],
          },
        ]),
        cancelForCaller: vi.fn(),
      },
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolveUserland", [
        "approval-1",
        "allow",
      ])
    ).resolves.toBeUndefined();
    expect(resolveUserland).toHaveBeenCalledWith("approval-1", "allow");

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolveUserland", [
        "approval-1",
        "synthetic",
      ])
    ).rejects.toMatchObject({ name: "ServiceError", code: "EINVAL" });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolveUserland", [
        "approval-1",
        "dismiss",
      ])
    ).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledWith("approval-1", "dismiss");
  });

  it("uses typed errors for missing userland approvals and unknown methods", async () => {
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveUserland: vi.fn(),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
        cancelForCaller: vi.fn(),
      },
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolveUserland", [
        "approval-1",
        "allow",
      ])
    ).rejects.toMatchObject({ name: "ServiceError", code: "ENOENT" });
    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "missing", [])
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("refuses to resolve non-bootstrap approvals through the bootstrap method", async () => {
    const resolve = vi.fn();
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveUserland: vi.fn(),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => [
          {
            kind: "credential",
            approvalId: "credential-1",
            callerId: "worker:alpha",
            callerKind: "worker",
            repoPath: "workers/alpha",
            effectiveVersion: "ev:worker",
            requestedAt: 10,
            credentialId: "openai",
            credentialLabel: "ChatGPT Codex model credential",
          } as PendingApproval,
        ]),
        cancelForCaller: vi.fn(),
      },
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("bootstrap", "app") }, "resolveBootstrap", [
        "credential-1",
        "once",
      ])
    ).rejects.toMatchObject({ name: "ServiceError", code: "ENOENT" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves startup approvals through the bootstrap method", async () => {
    const resolve = vi.fn();
    const metrics = createPushMetrics();
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveUserland: vi.fn(),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => [startupApproval("startup-1")]),
        cancelForCaller: vi.fn(),
      },
      metrics,
    });

    await service.handler(
      { caller: createVerifiedCaller("bootstrap", "app") },
      "resolveBootstrap",
      ["startup-1", "once"]
    );
    expect(resolve).toHaveBeenCalledWith("startup-1", "once");
    expect(metrics.snapshot().approval_resolved_total).toMatchObject({
      "decision=once,source=app": 1,
    });
  });

  it("leaves double resolves idempotent and records resolution metrics", async () => {
    const approvalQueue = createApprovalQueue({ eventService: { emit: vi.fn() } as never });
    const metrics = createPushMetrics();
    const service = createShellApprovalService({ approvalQueue, metrics });
    const pendingPromise = approvalQueue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
    });
    const approvalId = approvalQueue.listPending()[0]!.approvalId;

    await service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolve", [
      approvalId,
      "once",
    ]);
    await service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolve", [
      approvalId,
      "deny",
    ]);

    await expect(pendingPromise).resolves.toBe("once");
    expect(approvalQueue.listPending()).toEqual([]);
    expect(metrics.snapshot().approval_resolved_total).toMatchObject({
      "decision=once,source=shell": 1,
    });
    expect(metrics.snapshot().approval_resolved_total).not.toHaveProperty(
      "decision=deny,source=shell"
    );
  });
});

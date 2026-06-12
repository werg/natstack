import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createVerifiedCaller, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue } from "./approvalQueue.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  createWorkerdInspectorService,
  type WorkerdInspectorServiceDeps,
} from "./workerdInspectorService.js";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-workerd-inspector-"));
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

function panelCtx(): ServiceContext {
  return {
    caller: createVerifiedCaller("panel:panels/chat:1", "panel", {
      callerId: "panel:panels/chat:1",
      callerKind: "panel",
      repoPath: "panels/chat",
      effectiveVersion: "ev-test",
    }),
  };
}

function makeDeps(overrides?: Partial<WorkerdInspectorServiceDeps>): WorkerdInspectorServiceDeps {
  return {
    approvalQueue: createApprovalQueueMock(),
    grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    listTargets: vi.fn(async () => [
      {
        id: "core:user:worker-host",
        title: "worker-host",
        type: "node",
        targetPath: "core:user:worker-host",
      },
    ]),
    getEndpoint: vi.fn((targetPath: string) => ({
      wsEndpoint: `ws://127.0.0.1:1234/workerd-inspector/${encodeURIComponent(targetPath)}`,
      token: "tok",
    })),
    ...overrides,
  };
}

describe("workerdInspectorService", () => {
  it("lists targets without approval", async () => {
    const deps = makeDeps();
    const service = createWorkerdInspectorService(deps);
    const targets = await service.handler(panelCtx(), "listTargets", []);
    expect(targets).toEqual([expect.objectContaining({ targetPath: "core:user:worker-host" })]);
    expect(deps.approvalQueue.request).not.toHaveBeenCalled();
  });

  it("gates getEndpoint behind the workerd.inspector capability approval", async () => {
    const deps = makeDeps();
    const service = createWorkerdInspectorService(deps);
    const endpoint = await service.handler(panelCtx(), "getEndpoint", ["core:user:worker-host"]);
    expect(endpoint).toEqual({
      wsEndpoint: expect.stringContaining("/workerd-inspector/"),
      token: "tok",
    });
    expect(deps.approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(deps.approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "workerd.inspector" })
    );
  });

  it("denies getEndpoint when approval is rejected", async () => {
    const deps = makeDeps({ approvalQueue: createApprovalQueueMock("deny") });
    const service = createWorkerdInspectorService(deps);
    await expect(
      service.handler(panelCtx(), "getEndpoint", ["core:user:worker-host"])
    ).rejects.toThrow(/denied/i);
    expect(deps.getEndpoint).not.toHaveBeenCalled();
  });

  it("reports unavailability when the bridge has no inspector", async () => {
    const deps = makeDeps({ getEndpoint: vi.fn(() => null) });
    const service = createWorkerdInspectorService(deps);
    await expect(
      service.handler(panelCtx(), "getEndpoint", ["core:user:worker-host"])
    ).rejects.toThrow(/unavailable/i);
  });

  it("skips approval for shell callers", async () => {
    const deps = makeDeps();
    const service = createWorkerdInspectorService(deps);
    const ctx: ServiceContext = { caller: createVerifiedCaller("shell:main", "shell") };
    await service.handler(ctx, "getEndpoint", ["core:user:worker-host"]);
    expect(deps.approvalQueue.request).not.toHaveBeenCalled();
  });
});

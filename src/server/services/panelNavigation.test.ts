/**
 * Panel navigation regression tests.
 *
 * Plan §Test coverage: "Panel navigation: navigation retires subtree + creates
 * fresh entity; back-navigation rematerializes the same history-entry id;
 * capability grants on the same source survive (version-scoped); per-caller
 * egress credentials reissue."
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import { createRuntimeService } from "./runtimeService.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { EntityCache } from "@natstack/shared/runtime/entityCache";
import { canonicalEntityId, type EntityRecord } from "@natstack/shared/runtime/entitySpec";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { DODispatch, DORef } from "../doDispatch.js";
import { WorkspaceDO } from "../internalDOs/workspaceDO.js";
import { WorkspaceDOTestable } from "../internalDOs/workspaceDO.testFixture.js";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-nav-"));
}

function approvalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "version"
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

function makeDODispatch(instance: WorkspaceDO): {
  dispatch: DODispatch;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
    const fn = (instance as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`WorkspaceDO has no method ${method}`);
    return (fn as (...a: unknown[]) => unknown).apply(instance, args);
  });
  return { spy, dispatch: { dispatch: spy } as unknown as DODispatch };
}

describe("panel navigation: capability grants and retire hooks", () => {
  it("a version-scoped grant on (repoPath, effectiveVersion) survives panel retire+recreate for the same source", async () => {
    const approvalQueue = approvalQueueMock("version");
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const deps = { approvalQueue, grantStore };

    // First request from "panel-1" gets approved with "version" scope.
    const request1 = {
      caller: createVerifiedCaller("panel:nav-1", "panel", {
        callerId: "panel:nav-1",
        callerKind: "panel" as const,
        repoPath: "workers/foo",
        effectiveVersion: "abc",
      }),
      capability: "egress.fetch",
      resource: { type: "host", label: "Host", value: "example.com", key: "example.com" },
      title: "Fetch example.com",
      deniedReason: "denied",
    };
    const res1 = await requestCapabilityPermission(deps, request1);
    expect(res1.allowed).toBe(true);
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);

    // Now simulate panel navigation: the panel entity is retired and a brand-new
    // entity (different id, same source+version) is created on back-or-forward navigation.
    const request2 = {
      ...request1,
      caller: createVerifiedCaller("panel:nav-2", "panel", {
        callerId: "panel:nav-2",
        callerKind: "panel" as const,
        repoPath: "workers/foo",
        effectiveVersion: "abc",
      }),
    };
    const res2 = await requestCapabilityPermission(deps, request2);
    expect(res2.allowed).toBe(true);
    // No re-prompt — grant is version-scoped, not principal-scoped.
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("a version-scoped grant does NOT cross to a different effectiveVersion (re-prompt required)", async () => {
    const approvalQueue = approvalQueueMock("version");
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const deps = { approvalQueue, grantStore };

    const baseRequest = {
      capability: "egress.fetch",
      resource: { type: "host", label: "Host", value: "example.com", key: "example.com" },
      title: "Fetch example.com",
      deniedReason: "denied",
    };

    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("panel:v1", "panel", {
        callerId: "panel:v1",
        callerKind: "panel",
        repoPath: "workers/foo",
        effectiveVersion: "abc",
      }),
    });

    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("panel:v2", "panel", {
        callerId: "panel:v2",
        callerKind: "panel",
        repoPath: "workers/foo",
        effectiveVersion: "def", // <-- different version
      }),
    });

    // Two prompts because version differs.
    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("retiring a panel fires onRetire with the panel entity record (so cleanup hooks like egressProxy.dropCaller run)", async () => {
    const { instance } = await createTestDO(WorkspaceDOTestable);
    const { dispatch } = makeDODispatch(instance);
    const entityCache = new EntityCache();
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const approvalQueue = approvalQueueMock("session");
    const retiredRecords: EntityRecord[] = [];

    const service = createRuntimeService({
      doDispatch: dispatch,
      workspaceId: "workspace-nav",
      hooks: {
        prepareDurableObject: vi.fn(async () => ({ targetId: "t", effectiveVersion: "v" })),
        prepareWorker: vi.fn(async () => ({ targetId: "t", effectiveVersion: "v" })),
        resolvePanelEffectiveVersion: vi.fn(async () => "ev-panel"),
        resolveAppEffectiveVersion: vi.fn(async () => "ev-app"),
        onRetire: async (record) => {
          retiredRecords.push(record);
        },
      },
      capability: { approvalQueue, grantStore },
      entityCache,
    });

    const handle = (await service.handler(
      { caller: createVerifiedCaller("server:main", "server") },
      "createEntity",
      [
        {
          kind: "panel",
          source: "panels/chat",
          contextId: "ctx-x",
          key: "nav-entry-1",
        },
      ]
    )) as { id: string };

    expect(handle.id).toBe(canonicalEntityId({ kind: "panel", key: "nav-entry-1" }));

    await service.handler(
      { caller: createVerifiedCaller("server:main", "server") },
      "retireEntity",
      [{ id: handle.id }]
    );

    // Hook was called with the retired panel record. Real bootstrap wires this
    // to egressProxy.dropCaller(record.id) etc. — proving the call site is
    // reached is sufficient at this layer.
    expect(retiredRecords).toHaveLength(1);
    expect(retiredRecords[0]?.id).toBe(handle.id);
    expect(retiredRecords[0]?.kind).toBe("panel");
    expect(retiredRecords[0]?.status).toBe("retired");
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createTestDO } from "@natstack/durable/test-utils";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { createRuntimeService } from "./runtimeService.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { EntityCache } from "@natstack/shared/runtime/entityCache";
import { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import {
  canonicalEntityId,
  type EntityRecord,
  type RuntimeEntityCreateSpec,
} from "@natstack/shared/runtime/entitySpec";
import { createVerifiedCaller, ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import type { DODispatch, DORef } from "../doDispatch.js";
import { WorkspaceDO } from "../internalDOs/workspaceDO.js";
import { WorkspaceDOTestable } from "../internalDOs/workspaceDO.testFixture.js";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-runtime-svc-"));
}

function approvalQueueMock(
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

/** Wrap a WorkspaceDO instance into a DODispatch-compatible mock. */
function makeDODispatch(instance: WorkspaceDO): {
  dispatch: DODispatch;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (_ref: DORef, method: string, ...args: unknown[]) => {
    // Direct in-process invocation against the WorkspaceDO instance.
    const fn = (instance as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      throw new Error(`WorkspaceDO has no method ${method}`);
    }
    return (fn as (...a: unknown[]) => unknown).apply(instance, args);
  });
  return {
    spy,
    dispatch: { dispatch: spy } as unknown as DODispatch,
  };
}

interface BuildDepsOptions {
  approvalDecision?: Awaited<ReturnType<ApprovalQueue["request"]>>;
  prepareDurableObject?: NonNullable<
    Parameters<typeof createRuntimeService>[0]["hooks"]
  >["prepareDurableObject"];
  prepareWorker?: NonNullable<Parameters<typeof createRuntimeService>[0]["hooks"]>["prepareWorker"];
  onRetire?: NonNullable<Parameters<typeof createRuntimeService>[0]["hooks"]>["onRetire"];
  resolvePanelEffectiveVersion?: NonNullable<
    Parameters<typeof createRuntimeService>[0]["hooks"]
  >["resolvePanelEffectiveVersion"];
  resolveAppEffectiveVersion?: NonNullable<
    Parameters<typeof createRuntimeService>[0]["hooks"]
  >["resolveAppEffectiveVersion"];
  setEntityTitle?: Parameters<typeof createRuntimeService>[0]["setEntityTitle"];
  canCreateCrossContextEntity?: Parameters<
    typeof createRuntimeService
  >[0]["canCreateCrossContextEntity"];
}

/** In-memory context-folder fake tracking which contexts exist. */
function contextFoldersFake() {
  const existing = new Set<string>();
  return {
    existing,
    ensureContextFolder: vi.fn(async (contextId: string) => {
      existing.add(contextId);
      return `/tmp/contexts/${contextId}`;
    }),
    removeContext: vi.fn(async (contextId: string) => {
      existing.delete(contextId);
    }),
  };
}

async function buildDeps(opts: BuildDepsOptions = {}) {
  const { instance } = await createTestDO(WorkspaceDOTestable);
  const { dispatch, spy } = makeDODispatch(instance);
  const entityCache = new EntityCache();
  const approvalQueue = approvalQueueMock(opts.approvalDecision ?? "session");
  const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });

  const prepareDurableObject =
    opts.prepareDurableObject ??
    vi.fn(async (args: { className: string; key: string }) => ({
      targetId: `target:${args.className}:${args.key}`,
      effectiveVersion: "ev-do",
    }));
  const prepareWorker =
    opts.prepareWorker ??
    vi.fn(async (args: { source: string; key: string }) => ({
      targetId: `target:worker:${args.source}:${args.key}`,
      effectiveVersion: "ev-worker",
    }));
  const contextFolders = contextFoldersFake();
  const onRetire = opts.onRetire ?? vi.fn(async () => {});
  const resolvePanelEffectiveVersion =
    opts.resolvePanelEffectiveVersion ?? vi.fn(async () => "ev-panel");
  const resolveAppEffectiveVersion = opts.resolveAppEffectiveVersion ?? vi.fn(async () => "ev-app");

  const entityStore = new WorkspaceEntityStore({
    doDispatch: dispatch,
    workspaceId: "workspace-main",
    entityCache,
  });

  const service = createRuntimeService({
    entityStore,
    hooks: {
      prepareDurableObject,
      prepareWorker,
      resolvePanelEffectiveVersion,
      resolveAppEffectiveVersion,
      onRetire,
    },
    capability: { approvalQueue, grantStore },
    contextFolders,
    setEntityTitle: opts.setEntityTitle,
    canCreateCrossContextEntity: opts.canCreateCrossContextEntity,
  });

  return {
    instance,
    service,
    spy,
    entityCache,
    contextFolders,
    approvalQueue,
    grantStore,
    prepareDurableObject,
    prepareWorker,
    onRetire,
    resolvePanelEffectiveVersion,
    resolveAppEffectiveVersion,
  };
}

const panelCaller = (id = "panel:caller", _contextId = "ctx-caller") =>
  createVerifiedCaller(id, "panel", {
    callerId: id,
    callerKind: "panel",
    repoPath: "panels/caller",
    effectiveVersion: "v1",
  });

const appCaller = (id = "app:apps/shell:desktop", _contextId = "ctx-caller") =>
  createVerifiedCaller(id, "app", {
    callerId: id,
    callerKind: "app",
    repoPath: "apps/shell",
    effectiveVersion: "v1",
  });

const panelHostAppCaller = (
  id = "app:apps/field-mobile:device-1",
  repoPath = "apps/field-mobile"
) =>
  createVerifiedCaller(id, "app", {
    callerId: id,
    callerKind: "app",
    repoPath,
    effectiveVersion: "v-host",
  });

const shellCaller = createVerifiedCaller("shell", "shell");
const serverCaller = createVerifiedCaller("server", "server");

const doCreateSpec = (
  overrides: Partial<Extract<RuntimeEntityCreateSpec, { kind: "do" }>> = {}
): RuntimeEntityCreateSpec => ({
  kind: "do",
  source: "workers/example",
  className: "MyDO",
  key: "k1",
  ...overrides,
});

const panelCreateSpec = (
  overrides: Partial<Extract<RuntimeEntityCreateSpec, { kind: "panel" }>> = {}
): RuntimeEntityCreateSpec => ({
  kind: "panel",
  source: "panels/example",
  key: "p1",
  ...overrides,
});

describe("runtimeService.createEntity (do kind)", () => {
  it("does not commit an entity row when prepareDurableObject fails", async () => {
    const prepareDurableObject = vi.fn(async () => {
      throw new Error("prepare boom");
    });
    const { service, spy, instance } = await buildDeps({ prepareDurableObject });
    await expect(
      service.handler({ caller: serverCaller }, "createEntity", [
        doCreateSpec({ contextId: "ctx-x" }),
      ])
    ).rejects.toThrow(/prepare boom/);
    expect(spy.mock.calls.some((c) => c[1] === "entityActivate")).toBe(false);
    const canonical = canonicalEntityId({
      kind: "do",
      source: "workers/example",
      className: "MyDO",
      key: "k1",
    });
    expect(instance.entityResolve(canonical)).toBeNull();
  });

  it("returns handle with id+targetId and updates the cache on the happy path", async () => {
    const { service, entityCache, prepareDurableObject } = await buildDeps();
    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-x" }),
    ])) as { id: string; targetId: string; kind: string };
    expect(handle.kind).toBe("do");
    expect(handle.id).toBe(
      canonicalEntityId({ kind: "do", source: "workers/example", className: "MyDO", key: "k1" })
    );
    expect(handle.targetId).toBe("target:MyDO:k1");
    expect(entityCache.resolveActive(handle.id)).not.toBeNull();
    expect(prepareDurableObject).toHaveBeenCalledTimes(1);
  });

  it("reactivates a retired row and re-runs prepareDurableObject", async () => {
    const { service, instance, prepareDurableObject } = await buildDeps();
    // First create — phase 1.
    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-x" }),
    ])) as { id: string };
    // Retire it.
    instance.entityRetire(handle.id);
    expect(instance.entityResolve(handle.id)?.status).toBe("retired");

    // Second create — should re-prepare and flip back to active.
    const second = (await service.handler({ caller: serverCaller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-x" }),
    ])) as { id: string };
    expect(second.id).toBe(handle.id);
    expect(instance.entityResolve(handle.id)?.status).toBe("active");
    expect(prepareDurableObject).toHaveBeenCalledTimes(2);
  });

  it("reactivates a retired row without changing its effective version", async () => {
    const prepareDurableObject = vi
      .fn()
      .mockResolvedValueOnce({ targetId: "target:MyDO:k1", effectiveVersion: "ev-do-v1" })
      .mockResolvedValueOnce({ targetId: "target:MyDO:k1", effectiveVersion: "ev-do-v2" });
    const { service, instance } = await buildDeps({ prepareDurableObject });

    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-x" }),
    ])) as { id: string };
    instance.entityRetire(handle.id);

    await service.handler({ caller: serverCaller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-x" }),
    ]);

    const reactivated = instance.entityResolve(handle.id);
    expect(reactivated?.status).toBe("active");
    expect(reactivated?.source.effectiveVersion).toBe("ev-do-v1");
  });

  it("reactivates a retired panel row without changing its effective version", async () => {
    const resolvePanelEffectiveVersion = vi
      .fn()
      .mockResolvedValueOnce("ev-panel-v1")
      .mockResolvedValueOnce("ev-panel-v2");
    const { service, instance } = await buildDeps({ resolvePanelEffectiveVersion });
    const spec: RuntimeEntityCreateSpec = {
      kind: "panel",
      source: "panels/example",
      key: "nav-1",
      contextId: "ctx-x",
    };

    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [spec])) as {
      id: string;
    };
    instance.entityRetire(handle.id);

    await service.handler({ caller: serverCaller }, "createEntity", [spec]);

    const reactivated = instance.entityResolve(handle.id);
    expect(reactivated?.status).toBe("active");
    expect(reactivated?.source.effectiveVersion).toBe("ev-panel-v1");
  });

  it("creates app entities as first-class runtime records", async () => {
    const resolveAppEffectiveVersion = vi.fn(async () => "ev-app-shell");
    const { service, entityCache } = await buildDeps({ resolveAppEffectiveVersion });
    const spec: RuntimeEntityCreateSpec = {
      kind: "app",
      source: "apps/shell",
      key: "desktop",
      contextId: "ctx-app",
      stateArgs: { window: "main" },
    };

    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [spec])) as {
      id: string;
      kind: string;
      targetId: string;
    };

    expect(handle.kind).toBe("app");
    expect(handle.id).toBe(
      canonicalEntityId({
        kind: "app",
        source: "apps/shell",
        key: "desktop",
      })
    );
    expect(handle.targetId).toBe(handle.id);
    expect(entityCache.resolveActive(handle.id)).toMatchObject({
      kind: "app",
      source: { repoPath: "apps/shell", effectiveVersion: "ev-app-shell" },
      contextId: "ctx-app",
      key: "desktop",
      stateArgs: { window: "main" },
    });
    expect(resolveAppEffectiveVersion).toHaveBeenCalledWith({
      source: "apps/shell",
      ref: undefined,
    });
  });

  it("rejects non-host callers creating app entities", async () => {
    const { service } = await buildDeps();
    const spec: RuntimeEntityCreateSpec = {
      kind: "app",
      source: "apps/shell",
      key: "desktop",
      contextId: "ctx-app",
    };

    await expect(
      service.handler({ caller: panelCaller() }, "createEntity", [spec])
    ).rejects.toThrow(/host-managed/);
  });

  it("reactivates a retired app row without changing its effective version", async () => {
    const resolveAppEffectiveVersion = vi
      .fn()
      .mockResolvedValueOnce("ev-app-v1")
      .mockResolvedValueOnce("ev-app-v2");
    const { service, instance } = await buildDeps({ resolveAppEffectiveVersion });
    const spec: RuntimeEntityCreateSpec = {
      kind: "app",
      source: "apps/shell",
      key: "desktop",
      contextId: "ctx-app",
    };

    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [spec])) as {
      id: string;
    };
    instance.entityRetire(handle.id);

    await service.handler({ caller: serverCaller }, "createEntity", [spec]);

    const reactivated = instance.entityResolve(handle.id);
    expect(reactivated?.status).toBe("active");
    expect(reactivated?.source.effectiveVersion).toBe("ev-app-v1");
  });
});

describe("runtimeService.createEntity context policy", () => {
  it("mints a fresh UUID when contextId is omitted", async () => {
    const { service } = await buildDeps();
    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [
      doCreateSpec(),
    ])) as EntityRecord;
    expect(handle.contextId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("allows callers in their own context", async () => {
    const { service, entityCache, approvalQueue } = await buildDeps();
    const caller = panelCaller("panel:p1", "ctx-caller");
    entityCache._onActivate({
      id: caller.runtime.id,
      kind: "panel",
      source: { repoPath: "panels/caller", effectiveVersion: "v1" },
      contextId: "ctx-caller",
      key: "p1",
      createdAt: 1,
      status: "active",
      cleanupComplete: true,
    });
    const handle = (await service.handler({ caller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-caller" }),
    ])) as { contextId: string };
    expect(handle.contextId).toBe("ctx-caller");
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("bypasses approval for server callers in cross-context", async () => {
    const { service, approvalQueue } = await buildDeps();
    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-other" }),
    ])) as { contextId: string };
    expect(handle.contextId).toBe("ctx-other");
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("bypasses approval for shell callers in cross-context", async () => {
    const { service, approvalQueue } = await buildDeps();
    const handle = (await service.handler({ caller: shellCaller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-other" }),
    ])) as { contextId: string };
    expect(handle.contextId).toBe("ctx-other");
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("bypasses approval for app callers trusted by the host policy", async () => {
    const canCreateCrossContextEntity = vi.fn(() => true);
    const { service, approvalQueue } = await buildDeps({ canCreateCrossContextEntity });
    const caller = panelHostAppCaller();

    const handle = (await service.handler({ caller }, "createEntity", [
      panelCreateSpec({ contextId: "ctx-target" }),
    ])) as { contextId: string };
    expect(handle.contextId).toBe("ctx-target");
    expect(canCreateCrossContextEntity).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({ kind: "panel", source: "panels/example" })
    );
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("requests approval for panel callers in cross-context and grants when allowed", async () => {
    const { service, approvalQueue, entityCache } = await buildDeps({
      approvalDecision: "session",
    });
    const caller = panelCaller("panel:p2", "ctx-caller");
    entityCache._onActivate({
      id: caller.runtime.id,
      kind: "panel",
      source: { repoPath: "panels/caller", effectiveVersion: "v1" },
      contextId: "ctx-caller",
      key: "p2",
      createdAt: 1,
      status: "active",
      cleanupComplete: true,
    });

    const handle = (await service.handler({ caller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-target" }),
    ])) as { contextId: string };
    expect(handle.contextId).toBe("ctx-target");
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("requests approval for app callers in cross-context and grants when allowed", async () => {
    const { service, approvalQueue, entityCache } = await buildDeps({
      approvalDecision: "session",
    });
    const caller = appCaller("app:apps/shell:desktop", "ctx-caller");
    entityCache._onActivate({
      id: caller.runtime.id,
      kind: "app",
      source: { repoPath: "apps/shell", effectiveVersion: "v1" },
      contextId: "ctx-caller",
      key: "desktop",
      createdAt: 1,
      status: "active",
      cleanupComplete: true,
    });

    const handle = (await service.handler({ caller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-target" }),
    ])) as { contextId: string };
    expect(handle.contextId).toBe("ctx-target");
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: "app:apps/shell:desktop",
        callerKind: "app",
        capability: "runtime.crossContextEntity",
      })
    );
  });

  it("rejects panel callers in cross-context when denied", async () => {
    const { service, entityCache } = await buildDeps({ approvalDecision: "deny" });
    const caller = panelCaller("panel:p3", "ctx-caller");
    entityCache._onActivate({
      id: caller.runtime.id,
      kind: "panel",
      source: { repoPath: "panels/caller", effectiveVersion: "v1" },
      contextId: "ctx-caller",
      key: "p3",
      createdAt: 1,
      status: "active",
      cleanupComplete: true,
    });
    await expect(
      service.handler({ caller }, "createEntity", [doCreateSpec({ contextId: "ctx-target" })])
    ).rejects.toThrow(/denied/i);
  });
});

describe("runtimeService.setTitle", () => {
  it("allows app callers to set their display title", async () => {
    const setEntityTitle = vi.fn();
    const { service } = await buildDeps({ setEntityTitle });
    const caller = appCaller("app:apps/shell:desktop");

    await expect(
      service.handler({ caller }, "setTitle", ["Workspace Shell"])
    ).resolves.toBeUndefined();

    expect(setEntityTitle).toHaveBeenCalledWith("app:apps/shell:desktop", "Workspace Shell", {
      explicit: false,
    });
  });

  it("passes explicit title intent through to the title registry", async () => {
    const setEntityTitle = vi.fn();
    const { service } = await buildDeps({ setEntityTitle });
    const caller = appCaller("app:apps/shell:desktop");

    await service.handler({ caller }, "setTitle", ["Workspace Shell", { explicit: true }]);

    expect(setEntityTitle).toHaveBeenCalledWith("app:apps/shell:desktop", "Workspace Shell", {
      explicit: true,
    });
  });

  // Fix 2: setTitle's caller-kind access is declared ONCE in the per-method policy
  // (runtimeMethods.setTitle: panel/app/worker/do) and enforced by the dispatcher's
  // single gate — the handler no longer re-rejects. These tests prove declared ==
  // enforced through the real dispatch path (not the handler-direct shortcut above).
  it("the dispatcher (single gate) rejects shell/server setTitle via the declared per-method policy", async () => {
    const setEntityTitle = vi.fn();
    const { service } = await buildDeps({ setEntityTitle });
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    for (const kind of ["shell", "server"] as const) {
      await expect(
        dispatcher.dispatch(
          { caller: createVerifiedCaller(`${kind}:x`, kind) },
          "runtime",
          "setTitle",
          ["T"]
        )
      ).rejects.toThrow(/not accessible to/i);
    }
    expect(setEntityTitle).not.toHaveBeenCalled();
  });

  it("the dispatcher admits worker/do setTitle (per-method policy, single gate)", async () => {
    const setEntityTitle = vi.fn();
    const { service } = await buildDeps({ setEntityTitle });
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await dispatcher.dispatch(
      { caller: createVerifiedCaller("do:workers/agent:Agent:k", "do") },
      "runtime",
      "setTitle",
      ["Agent Title"]
    );
    expect(setEntityTitle).toHaveBeenCalledWith("do:workers/agent:Agent:k", "Agent Title", {
      explicit: false,
    });
  });
});

describe("runtimeService.retireEntity", () => {
  it("commits DO retire first, then fires onRetire hook", async () => {
    const order: string[] = [];
    const { service, instance } = await buildDeps({
      onRetire: vi.fn(async () => {
        order.push("hook");
      }),
    });
    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-x" }),
    ])) as { id: string };

    // Wrap entityRetire so we observe ordering.
    const originalRetire = instance.entityRetire.bind(instance);
    (instance as unknown as { entityRetire: typeof instance.entityRetire }).entityRetire = (
      id: string
    ) => {
      order.push("do-commit");
      return originalRetire(id);
    };

    await service.handler({ caller: serverCaller }, "retireEntity", [{ id: handle.id }]);
    expect(order).toEqual(["do-commit", "hook"]);
    // cleanup_complete should be 1 on success.
    const rec = instance.entityResolve(handle.id);
    expect(rec?.cleanupComplete).toBe(true);
  });

  it("does not fire onRetire when DO retire returns null (no row)", async () => {
    const onRetire = vi.fn(async () => {});
    const { service } = await buildDeps({ onRetire });
    await service.handler({ caller: serverCaller }, "retireEntity", [{ id: "panel:missing" }]);
    expect(onRetire).not.toHaveBeenCalled();
  });

  it("leaves cleanup_complete=0 when the hook throws", async () => {
    const onRetire = vi.fn(async () => {
      throw new Error("hook fail");
    });
    const { service, instance, spy } = await buildDeps({ onRetire });
    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [
      doCreateSpec({ contextId: "ctx-x" }),
    ])) as { id: string };

    await service.handler({ caller: serverCaller }, "retireEntity", [{ id: handle.id }]);
    const rec = instance.entityResolve(handle.id);
    expect(rec?.status).toBe("retired");
    expect(rec?.cleanupComplete).toBe(false);
    // entityCleanupComplete dispatch should NOT have been issued.
    expect(spy.mock.calls.some((c) => c[1] === "entityCleanupComplete")).toBe(false);
  });
});

describe("runtimeService singleton DO + cross-panel sharing", () => {
  it("singleton precreation is idempotent and yields a stable own context across calls", async () => {
    const { service, instance, prepareDurableObject } = await buildDeps();

    // Bootstrap computes the singleton's contextId as a stable hash of
    // (workspaceId, source, className, key). Mimic that.
    const { createHash } = await import("node:crypto");
    const singletonContextId = createHash("sha256")
      .update("workspace-main\x00workers/gad\x00GadWorkspaceDO\x00workspace-gad")
      .digest("hex");

    const spec: RuntimeEntityCreateSpec = {
      kind: "do",
      source: "workers/gad",
      className: "GadWorkspaceDO",
      key: "workspace-gad",
      contextId: singletonContextId,
    };

    const a = (await service.handler({ caller: serverCaller }, "createEntity", [spec])) as {
      id: string;
      contextId: string;
    };
    const b = (await service.handler({ caller: serverCaller }, "createEntity", [spec])) as {
      id: string;
      contextId: string;
    };

    expect(b.id).toBe(a.id);
    expect(b.contextId).toBe(singletonContextId);
    expect(a.contextId).toBe(singletonContextId);
    expect(instance.entityResolve(a.id)?.status).toBe("active");
    // No IDENTITY_COLLISION raised; same row twice.
    expect(prepareDurableObject).toHaveBeenCalledTimes(2);
  });

  it("two panels in different contexts resolve the same singleton entity (shared targetId)", async () => {
    const { service, entityCache } = await buildDeps();

    // Two panels exist in different contexts.
    const panelA = panelCaller("panel:a", "ctx-a");
    const panelB = panelCaller("panel:b", "ctx-b");
    for (const [id, ctx] of [
      [panelA.runtime.id, "ctx-a"],
      [panelB.runtime.id, "ctx-b"],
    ] as const) {
      entityCache._onActivate({
        id,
        kind: "panel",
        source: { repoPath: "panels/caller", effectiveVersion: "v1" },
        contextId: ctx,
        key: id,
        createdAt: 1,
        status: "active",
        cleanupComplete: true,
      });
    }

    // The singleton is created by the server at bootstrap (in its own context).
    const { createHash } = await import("node:crypto");
    const singletonContextId = createHash("sha256")
      .update("workspace-main\x00workers/gad\x00GadWorkspaceDO\x00workspace-gad")
      .digest("hex");

    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [
      {
        kind: "do",
        source: "workers/gad",
        className: "GadWorkspaceDO",
        key: "workspace-gad",
        contextId: singletonContextId,
      },
    ])) as { id: string; targetId: string };

    // Now both panels resolve the singleton by canonical id and get the same row.
    const lookupA = entityCache.resolveActive(handle.id);
    const lookupB = entityCache.resolveActive(handle.id);
    expect(lookupA?.id).toBe(handle.id);
    expect(lookupB?.id).toBe(handle.id);
    expect(lookupA?.contextId).toBe(singletonContextId);
    expect(lookupB?.contextId).toBe(singletonContextId);
    // Same targetId regardless of which panel "asked" — singletons are shared.
    expect(handle.targetId).toBe("target:GadWorkspaceDO:workspace-gad");
  });

  it("an agent DO created by a panel records the requested panel context", async () => {
    const { service, entityCache, instance } = await buildDeps();

    const panel = panelCaller("panel:host", "ctx-host");
    entityCache._onActivate({
      id: panel.runtime.id,
      kind: "panel",
      source: { repoPath: "panels/host", effectiveVersion: "v1" },
      contextId: "ctx-host",
      key: "host",
      createdAt: 1,
      status: "active",
      cleanupComplete: true,
    });
    // Persist a host panel row.
    instance.entityActivate({
      kind: "panel",
      source: { repoPath: "panels/host", effectiveVersion: "v1" },
      contextId: "ctx-host",
      key: "host",
    });

    // Panel creates an agent DO in its own context.
    const agent = (await service.handler({ caller: panel }, "createEntity", [
      {
        kind: "do",
        source: "workers/agent",
        className: "AgentDO",
        key: "agent-1",
        contextId: "ctx-host",
      },
    ])) as { id: string; contextId: string };

    expect(agent.contextId).toBe("ctx-host");
    expect(instance.entityResolve(agent.id)?.contextId).toBe("ctx-host");
  });
});

describe("runtimeService session entities", () => {
  const sessionSpec = (
    overrides: Partial<Extract<RuntimeEntityCreateSpec, { kind: "session" }>> = {}
  ): RuntimeEntityCreateSpec => ({
    kind: "session",
    source: "agent-cli",
    ...overrides,
  });

  it("creates an inert session entity and eagerly materializes its context folder", async () => {
    const setEntityTitle = vi.fn();
    const { service, entityCache, contextFolders, prepareDurableObject, prepareWorker } =
      await buildDeps({ setEntityTitle });

    const handle = (await service.handler({ caller: shellCaller }, "createEntity", [
      sessionSpec({ key: "s1", title: "My agent session" }),
    ])) as { id: string; kind: string; contextId: string; targetId: string };

    expect(handle.kind).toBe("session");
    expect(handle.id).toBe("session:s1");
    expect(handle.targetId).toBe(handle.id);
    expect(handle.contextId).toMatch(/^[0-9a-f-]{36}$/); // fresh UUID minted
    // Context folder materialized eagerly.
    expect(contextFolders.ensureContextFolder).toHaveBeenCalledWith(handle.contextId);
    expect(contextFolders.existing.has(handle.contextId)).toBe(true);
    // No workerd/panel runtime prep.
    expect(prepareDurableObject).not.toHaveBeenCalled();
    expect(prepareWorker).not.toHaveBeenCalled();
    // Cache + title registry updated.
    expect(entityCache.resolveActive(handle.id)).toMatchObject({
      kind: "session",
      source: { repoPath: "agent-cli", effectiveVersion: "" },
      stateArgs: { title: "My agent session" },
    });
    expect(setEntityTitle).toHaveBeenCalledWith(handle.id, "My agent session", {
      explicit: true,
    });
  });

  it("honors an explicitly supplied contextId", async () => {
    const { service, contextFolders } = await buildDeps();
    const handle = (await service.handler({ caller: serverCaller }, "createEntity", [
      sessionSpec({ contextId: "ctx-given" }),
    ])) as { contextId: string };
    expect(handle.contextId).toBe("ctx-given");
    expect(contextFolders.ensureContextFolder).toHaveBeenCalledWith("ctx-given");
  });

  it("allows host callers and rejects non-host callers", async () => {
    const { service } = await buildDeps();
    const hostCaller = createVerifiedCaller("shell", "shell");
    await expect(
      service.handler({ caller: hostCaller }, "createEntity", [sessionSpec()])
    ).resolves.toMatchObject({ kind: "session" });

    await expect(
      service.handler({ caller: panelCaller() }, "createEntity", [sessionSpec()])
    ).rejects.toThrow(/host-managed/);
  });

  it("resolves and lists session entities", async () => {
    const { service } = await buildDeps();
    const handle = (await service.handler({ caller: shellCaller }, "createEntity", [
      sessionSpec({ key: "s-list", title: "Listed session" }),
    ])) as { id: string; contextId: string };
    // Create a worker too, so kind filtering is observable.
    await service.handler({ caller: serverCaller }, "createEntity", [
      { kind: "worker", source: "workers/w", key: "w1", contextId: "ctx-w" },
    ]);

    const resolved = await service.handler({ caller: shellCaller }, "resolveContext", [handle.id]);
    expect(resolved).toBe(handle.contextId);

    const all = (await service.handler({ caller: shellCaller }, "listEntities", [{}])) as Array<{
      id: string;
      kind: string;
    }>;
    expect(all.map((e) => e.kind).sort()).toEqual(["session", "worker"]);

    const sessions = (await service.handler({ caller: shellCaller }, "listEntities", [
      { kind: "session" },
    ])) as Array<{
      id: string;
      kind: string;
      source: string;
      contextId: string;
      title?: string;
      createdAt: number;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: handle.id,
      kind: "session",
      source: "agent-cli",
      contextId: handle.contextId,
      title: "Listed session",
    });
    expect(sessions[0]?.createdAt).toBeGreaterThan(0);
  });

  it("retire with removeContext deletes the context folder when no live entity shares it", async () => {
    const { service, contextFolders, instance } = await buildDeps();
    const handle = (await service.handler({ caller: shellCaller }, "createEntity", [
      sessionSpec({ key: "s-rm" }),
    ])) as { id: string; contextId: string };
    expect(contextFolders.existing.has(handle.contextId)).toBe(true);

    await service.handler({ caller: shellCaller }, "retireEntity", [
      { id: handle.id, removeContext: true },
    ]);

    expect(instance.entityResolve(handle.id)?.status).toBe("retired");
    expect(contextFolders.removeContext).toHaveBeenCalledWith(handle.contextId);
    expect(contextFolders.existing.has(handle.contextId)).toBe(false);
  });

  it("retire with removeContext keeps the folder when another live entity shares the context", async () => {
    const { service, contextFolders } = await buildDeps();
    const session = (await service.handler({ caller: shellCaller }, "createEntity", [
      sessionSpec({ key: "s-shared", contextId: "ctx-shared" }),
    ])) as { id: string };
    await service.handler({ caller: serverCaller }, "createEntity", [
      { kind: "worker", source: "workers/w", key: "w-shared", contextId: "ctx-shared" },
    ]);

    await service.handler({ caller: shellCaller }, "retireEntity", [
      { id: session.id, removeContext: true },
    ]);

    expect(contextFolders.removeContext).not.toHaveBeenCalled();
    expect(contextFolders.existing.has("ctx-shared")).toBe(true);
  });

  it("re-creating a session key after retire+removeContext reuses its contextId and re-materializes the folder", async () => {
    const { service, contextFolders } = await buildDeps();
    const first = (await service.handler({ caller: shellCaller }, "createEntity", [
      sessionSpec({ key: "s-again" }),
    ])) as { id: string; contextId: string };
    await service.handler({ caller: shellCaller }, "retireEntity", [
      { id: first.id, removeContext: true },
    ]);
    expect(contextFolders.existing.has(first.contextId)).toBe(false);

    const second = (await service.handler({ caller: shellCaller }, "createEntity", [
      sessionSpec({ key: "s-again" }),
    ])) as { id: string; contextId: string };
    expect(second.id).toBe(first.id);
    expect(second.contextId).toBe(first.contextId);
    expect(contextFolders.existing.has(first.contextId)).toBe(true);
  });

  it("retire without removeContext keeps the context folder", async () => {
    const { service, contextFolders } = await buildDeps();
    const handle = (await service.handler({ caller: shellCaller }, "createEntity", [
      sessionSpec({ key: "s-keep" }),
    ])) as { id: string; contextId: string };

    await service.handler({ caller: shellCaller }, "retireEntity", [{ id: handle.id }]);

    expect(contextFolders.removeContext).not.toHaveBeenCalled();
    expect(contextFolders.existing.has(handle.contextId)).toBe(true);
  });
});

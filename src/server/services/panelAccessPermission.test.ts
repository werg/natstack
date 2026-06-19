import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createVerifiedCaller,
  type ServiceContext,
  type VerifiedCaller,
} from "@natstack/shared/serviceDispatcher";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { CONTEXT_BOUNDARY_CAPABILITY, contextBoundaryResourceKey } from "./contextBoundary.js";
import {
  requirePanelAccessPermission,
  type PanelAccessPermissionDeps,
} from "./panelAccessPermission.js";
import type { ApprovalQueue } from "./approvalQueue.js";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-access-"));
}

function approvalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "session"
): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
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
    submitSecretInput: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
    cancelForCaller: vi.fn(),
  };
}

/** A code-identity panel caller (carries `.code`, so it is its own subject). */
function panelCaller(entityId: string, repoPath = "panels/requester"): VerifiedCaller {
  return createVerifiedCaller(entityId, "panel", {
    callerId: entityId,
    callerKind: "panel",
    repoPath,
    effectiveVersion: "version-1",
  });
}

function panelCtx(entityId = "panel:requester"): ServiceContext {
  return { caller: panelCaller(entityId) };
}

/**
 * Build the context-boundary deps for the panel gate. Defaults model a caller in
 * `ctx-caller` acting on a target in `ctx-target` that already exists — i.e. a
 * cross-context op that prompts. Override `resolveCallerContext`/`contextExists`
 * (or the target's `contextId`) to exercise the same-context / fresh branches.
 */
function accessDeps(overrides: Partial<PanelAccessPermissionDeps> = {}): PanelAccessPermissionDeps {
  return {
    approvalQueue: approvalQueueMock(),
    grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    contextExists: vi.fn(() => true),
    resolveContextOwnerLabel: vi.fn(() => "owner"),
    resolveCallerContext: vi.fn(async () => "ctx-caller"),
    resolveEntityContext: vi.fn(() => "ctx-target"),
    resolveSubjectCaller: vi.fn((id: string) =>
      createVerifiedCaller(id, "panel", {
        callerId: id,
        callerKind: "panel",
        repoPath: "panels/anchor",
        effectiveVersion: "version-1",
      })
    ),
    ...overrides,
  };
}

describe("panelAccessPermission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows open operations without prompting", async () => {
    const approvalQueue = approvalQueueMock();
    const deps = accessDeps({ approvalQueue });

    const result = await requirePanelAccessPermission(deps, panelCtx(), "read", {
      id: "target",
      title: "Target",
      contextId: "ctx-target",
    });

    expect(result).toEqual({ allowed: true });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("allows acting on a panel in the caller's own context without prompting", async () => {
    const approvalQueue = approvalQueueMock();
    const deps = accessDeps({
      approvalQueue,
      resolveCallerContext: vi.fn(async () => "ctx-shared"),
    });

    const result = await requirePanelAccessPermission(deps, panelCtx("panel:one"), "cdp", {
      id: "target",
      title: "Target",
      contextId: "ctx-shared",
    });

    expect(result).toEqual({ allowed: true });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("allows a panel to act on itself (same context) without prompting", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const deps = accessDeps({
      approvalQueue,
      resolveCallerContext: vi.fn(async () => "ctx-self"),
      resolveEntityContext: vi.fn(() => "ctx-self"),
    });

    const result = await requirePanelAccessPermission(
      deps,
      panelCtx("panel:entity-a"),
      "stateArgs.set",
      { id: "slot-a", runtimeEntityId: "panel:entity-a" }
    );

    expect(result).toEqual({ allowed: true });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("allows replacing a panel with no context change without prompting", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const deps = accessDeps({ approvalQueue });

    const result = await requirePanelAccessPermission(
      deps,
      panelCtx("panel:entity-a"),
      "replacePanel",
      { id: "slot-a", runtimeEntityId: "panel:entity-a" }
    );

    expect(result).toEqual({ allowed: true });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("prompts once when acting on a panel in another, already-existing context", async () => {
    const approvalQueue = approvalQueueMock("session");
    const contextExists = vi.fn(() => true);
    const deps = accessDeps({
      approvalQueue,
      contextExists,
      resolveCallerContext: vi.fn(async () => "ctx-caller"),
    });

    const result = await requirePanelAccessPermission(deps, panelCtx("panel:one"), "cdp", {
      id: "target",
      title: "Target",
      contextId: "ctx-target",
    });

    expect(result).toEqual({ allowed: true, prompted: true });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:one"),
      })
    );
    expect(contextExists).toHaveBeenCalledWith("ctx-target");
  });

  it("allows acting on a brand-new (non-existent) foreign context without prompting", async () => {
    const approvalQueue = approvalQueueMock("session");
    const deps = accessDeps({
      approvalQueue,
      contextExists: vi.fn(() => false),
      resolveCallerContext: vi.fn(async () => "ctx-caller"),
    });

    const result = await requirePanelAccessPermission(deps, panelCtx("panel:one"), "cdp", {
      id: "target",
      title: "Target",
      contextId: "ctx-fresh",
    });

    expect(result).toEqual({ allowed: true });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("remembers a cross-context grant per (target context, subject)", async () => {
    const approvalQueue = approvalQueueMock("version");
    const deps = accessDeps({
      approvalQueue,
      contextExists: vi.fn(() => true),
      resolveCallerContext: vi.fn(async () => "ctx-caller"),
    });
    const target = { id: "target", title: "Target", contextId: "ctx-target" };

    await requirePanelAccessPermission(deps, panelCtx("panel:one"), "cdp", target);
    await requirePanelAccessPermission(deps, panelCtx("panel:one"), "cdp", target);
    await requirePanelAccessPermission(deps, panelCtx("panel:two"), "cdp", target);

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:one"),
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:two"),
      })
    );
  });

  it("attributes a host-mediated (server) op to the anchor entity, not the host", async () => {
    const approvalQueue = approvalQueueMock("session");
    const anchorCaller = panelCaller("panel:anchor", "panels/anchor");
    const resolveSubjectCaller = vi.fn(() => anchorCaller);
    const resolveCallerContext = vi.fn(async () => "ctx-anchor");
    const deps = accessDeps({
      approvalQueue,
      resolveSubjectCaller,
      resolveCallerContext,
      contextExists: vi.fn(() => true),
    });
    const serverCtx: ServiceContext = { caller: createVerifiedCaller("server", "server") };

    const result = await requirePanelAccessPermission(deps, serverCtx, "cdp", {
      id: "target",
      title: "Target",
      contextId: "ctx-target",
      runtimeEntityId: "panel:anchor",
    });

    expect(result).toEqual({ allowed: true, prompted: true });
    // The anchor is resolved from the host-set runtime entity id.
    expect(resolveSubjectCaller).toHaveBeenCalledWith("panel:anchor");
    // Origin context is resolved for the ANCHOR, not the host "server" principal.
    expect(resolveCallerContext).toHaveBeenCalledWith("panel:anchor");
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        // Prompt/grant attributed to the anchor's code identity, never "server".
        callerId: "panel:anchor",
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:anchor"),
      })
    );
  });

  it("allows a host-mediated op cleanly when the anchor has no resolvable code identity", async () => {
    const approvalQueue = approvalQueueMock("session");
    const resolveSubjectCaller = vi.fn(() => null);
    const deps = accessDeps({ approvalQueue, resolveSubjectCaller });
    const serverCtx: ServiceContext = { caller: createVerifiedCaller("server", "server") };

    const result = await requirePanelAccessPermission(deps, serverCtx, "cdp", {
      id: "target",
      title: "Target",
      contextId: "ctx-target",
      runtimeEntityId: "panel:anchor",
    });

    expect(result).toEqual({ allowed: true });
    expect(resolveSubjectCaller).toHaveBeenCalledWith("panel:anchor");
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("treats host-mediated calls with no anchor entity as free (genuine system action)", async () => {
    const approvalQueue = approvalQueueMock("once");
    const resolveSubjectCaller = vi.fn(() => null);
    const deps = accessDeps({ approvalQueue, resolveSubjectCaller });

    for (const kind of ["shell", "server"] as const) {
      await expect(
        requirePanelAccessPermission(deps, { caller: createVerifiedCaller(kind, kind) }, "close", {
          id: "target",
        })
      ).resolves.toEqual({ allowed: true });
    }

    // No `runtimeEntityId` anchor on the target ⇒ never even tries to resolve one.
    expect(resolveSubjectCaller).not.toHaveBeenCalled();
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("forwards severe severity for privileged targets", async () => {
    const approvalQueue = approvalQueueMock("once");
    const deps = accessDeps({
      approvalQueue,
      contextExists: vi.fn(() => true),
      resolveCallerContext: vi.fn(async () => "ctx-caller"),
    });

    await requirePanelAccessPermission(deps, panelCtx(), "cdp", {
      id: "shell-target",
      title: "Shell",
      privileged: true,
      contextId: "ctx-target",
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        severity: "severe",
      })
    );
  });

  it("gates a non-host app caller acting on another existing context", async () => {
    const approvalQueue = approvalQueueMock("session");
    const deps = accessDeps({
      approvalQueue,
      contextExists: vi.fn(() => true),
      resolveCallerContext: vi.fn(async () => "ctx-app"),
    });
    const appCaller = createVerifiedCaller("app:apps/field-mobile:device-1", "app", {
      callerId: "app:apps/field-mobile:device-1",
      callerKind: "app",
      repoPath: "apps/field-mobile",
      effectiveVersion: "version-1",
    });

    const result = await requirePanelAccessPermission(deps, { caller: appCaller }, "close", {
      id: "target",
      contextId: "ctx-target",
    });

    expect(result).toMatchObject({ allowed: true, prompted: true });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
  });

  it("does not add a timeout signal to context-boundary prompts", async () => {
    const approvalQueue = approvalQueueMock("session");
    const deps = accessDeps({
      approvalQueue,
      contextExists: vi.fn(() => true),
      resolveCallerContext: vi.fn(async () => "ctx-caller"),
    });

    await expect(
      requirePanelAccessPermission(deps, panelCtx(), "cdp", {
        id: "target",
        title: "Target",
        contextId: "ctx-target",
      })
    ).resolves.toEqual({ allowed: true, prompted: true });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.not.objectContaining({ signal: expect.anything() })
    );
  });

  it("leaves pending cross-context prompts open until the queue resolves them", async () => {
    vi.useFakeTimers();
    const approvalQueue = approvalQueueMock("session");
    let resolveApproval!: (decision: "deny") => void;
    vi.mocked(approvalQueue.request).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveApproval = resolve;
        })
    );
    const deps = accessDeps({
      approvalQueue,
      contextExists: vi.fn(() => true),
      resolveCallerContext: vi.fn(async () => "ctx-caller"),
    });

    const promise = requirePanelAccessPermission(deps, panelCtx(), "cdp", {
      id: "target",
      title: "Target",
      contextId: "ctx-target",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const sentinel = Symbol("still pending");
    await expect(Promise.race([promise, Promise.resolve(sentinel)])).resolves.toBe(sentinel);

    resolveApproval("deny");
    await expect(promise).resolves.toEqual({
      allowed: false,
      reason: "Automate panel in denied: owner is another agent or panel's existing state",
    });
  });
});

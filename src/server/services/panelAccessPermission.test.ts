import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createVerifiedCaller, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import {
  PANEL_AUTOMATE_CAPABILITY,
  PANEL_STRUCTURAL_CAPABILITY,
} from "@natstack/shared/panelAccessPolicy";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { panelCapabilityResourceKey } from "./capabilityPermission.js";
import { requirePanelAccessPermission } from "./panelAccessPermission.js";
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

function panelCtx(entityId = "panel:requester"): ServiceContext {
  return {
    caller: createVerifiedCaller(entityId, "panel", {
      callerId: entityId,
      callerKind: "panel",
      repoPath: "panels/requester",
      effectiveVersion: "version-1",
    }),
  };
}

describe("panelAccessPermission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows open operations without prompting", async () => {
    const approvalQueue = approvalQueueMock();

    const result = await requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      },
      panelCtx(),
      "rpc.call",
      { id: "target", title: "Target" }
    );

    expect(result).toEqual({ allowed: true });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("prompts for automation and remembers by requester entity to target panel", async () => {
    const approvalQueue = approvalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };

    await requirePanelAccessPermission(deps, panelCtx("panel:one"), "cdp", {
      id: "target",
      title: "Target",
    });
    await requirePanelAccessPermission(deps, panelCtx("panel:one"), "cdp", {
      id: "target",
      title: "Target",
    });
    await requirePanelAccessPermission(deps, panelCtx("panel:two"), "cdp", {
      id: "target",
      title: "Target",
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        capability: PANEL_AUTOMATE_CAPABILITY,
        grantResourceKey: panelCapabilityResourceKey("target", "panel:one"),
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        capability: PANEL_AUTOMATE_CAPABILITY,
        grantResourceKey: panelCapabilityResourceKey("target", "panel:two"),
      })
    );
  });

  it("prompts for structural operations when there is no automation grant", async () => {
    const approvalQueue = approvalQueueMock("session");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };

    await requirePanelAccessPermission(deps, panelCtx(), "movePanel", { id: "target" });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: PANEL_STRUCTURAL_CAPABILITY })
    );
  });

  it("allows structural operations when the requester already has automation access", async () => {
    const approvalQueue = approvalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const ctx = panelCtx("panel:one");
    const target = { id: "target", title: "Target" };

    await requirePanelAccessPermission(deps, ctx, "cdp", target);
    await requirePanelAccessPermission(deps, ctx, "close", target);
    await requirePanelAccessPermission(deps, ctx, "archive", target);
    await requirePanelAccessPermission(deps, ctx, "unload", target);
    await requirePanelAccessPermission(deps, ctx, "movePanel", target);
    await requirePanelAccessPermission(deps, ctx, "replacePanel", target);
    await requirePanelAccessPermission(deps, ctx, "takeOver", target);
    await requirePanelAccessPermission(deps, ctx, "openDevTools", target);
    await requirePanelAccessPermission(deps, ctx, "rebuildPanel", target);
    await requirePanelAccessPermission(deps, ctx, "rebuildAndReload", target);
    await requirePanelAccessPermission(deps, ctx, "updatePanelState", target);
    await requirePanelAccessPermission(deps, ctx, "stateArgs.set", target);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: PANEL_AUTOMATE_CAPABILITY })
    );
  });

  it("reuses automation access for navigation without an extra prompt", async () => {
    const approvalQueue = approvalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const ctx = panelCtx("panel:one");
    const target = { id: "target", title: "Target" };

    await requirePanelAccessPermission(deps, ctx, "cdp", target);
    await requirePanelAccessPermission(deps, ctx, "navigate", target);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: PANEL_AUTOMATE_CAPABILITY })
    );
  });

  it("passes severe severity for privileged targets", async () => {
    const approvalQueue = approvalQueueMock("once");

    await requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      },
      panelCtx(),
      "cdp",
      { id: "shell-target", title: "Shell", privileged: true }
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_AUTOMATE_CAPABILITY,
        severity: "severe",
      })
    );
  });

  it("allows a panel to update its own stateArgs without prompting", async () => {
    const approvalQueue = approvalQueueMock("deny");

    const result = await requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
        resolveRequesterPanel: vi.fn(async () => ({
          id: "slot-a",
          runtimeEntityId: "panel:entity-a",
        })),
      },
      panelCtx("panel:entity-a"),
      "stateArgs.set",
      { id: "slot-a", runtimeEntityId: "panel:entity-a" }
    );

    expect(result).toEqual({ allowed: true });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("allows a panel to replace itself without prompting", async () => {
    const approvalQueue = approvalQueueMock("deny");

    const result = await requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
        resolveRequesterPanel: vi.fn(async () => ({
          id: "slot-a",
          runtimeEntityId: "panel:entity-a",
        })),
      },
      panelCtx("panel:entity-a"),
      "replacePanel",
      { id: "slot-a", runtimeEntityId: "panel:entity-a" }
    );

    expect(result).toEqual({ allowed: true });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("still gates panel CDP for the requesting panel itself", async () => {
    const approvalQueue = approvalQueueMock("session");

    const result = await requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
        resolveRequesterPanel: vi.fn(async () => ({
          id: "slot-a",
          runtimeEntityId: "panel:entity-a",
        })),
      },
      panelCtx("panel:entity-a"),
      "cdp",
      { id: "slot-a", runtimeEntityId: "panel:entity-a" }
    );

    expect(result).toMatchObject({
      allowed: true,
      capability: PANEL_AUTOMATE_CAPABILITY,
      prompted: true,
    });
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_AUTOMATE_CAPABILITY,
        grantResourceKey: panelCapabilityResourceKey("slot-a", "panel:entity-a"),
      })
    );
  });

  it("gates panel CDP for child and sibling panel targets", async () => {
    const approvalQueue = approvalQueueMock("session");

    await requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
        resolveRequesterPanel: vi.fn(async () => ({
          id: "slot-a",
          runtimeEntityId: "panel:entity-a",
        })),
      },
      panelCtx("panel:entity-a"),
      "cdp",
      { id: "slot-b", runtimeEntityId: "panel:entity-b" }
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_AUTOMATE_CAPABILITY,
        grantResourceKey: panelCapabilityResourceKey("slot-b", "panel:entity-a"),
      })
    );
  });

  it("still gates stateArgs updates for other panels", async () => {
    const approvalQueue = approvalQueueMock("session");

    await requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
        resolveRequesterPanel: vi.fn(async () => ({
          id: "slot-a",
          runtimeEntityId: "panel:entity-a",
        })),
      },
      panelCtx("panel:entity-a"),
      "stateArgs.set",
      { id: "slot-b", runtimeEntityId: "panel:entity-b" }
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: PANEL_STRUCTURAL_CAPABILITY })
    );
  });

  it("denies panel capabilities without queueing when no approval shell is active", async () => {
    const approvalQueue = approvalQueueMock("session");

    const result = await requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
        hasApprovalSession: () => false,
      },
      panelCtx(),
      "cdp",
      { id: "target", title: "Target" }
    );

    expect(result).toEqual({
      allowed: false,
      capability: PANEL_AUTOMATE_CAPABILITY,
      reason: "No approval-capable shell is connected",
    });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("allows remembered panel capabilities without an active approval shell", async () => {
    const approvalQueue = approvalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      hasApprovalSession: vi.fn(() => true),
    };

    await expect(
      requirePanelAccessPermission(deps, panelCtx("panel:one"), "cdp", {
        id: "target",
        title: "Target",
      })
    ).resolves.toMatchObject({ allowed: true });
    deps.hasApprovalSession.mockReturnValue(false);
    await expect(
      requirePanelAccessPermission(deps, panelCtx("panel:one"), "cdp", {
        id: "target",
        title: "Target",
      })
    ).resolves.toMatchObject({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("does not add a timeout signal to panel capability prompts", async () => {
    const approvalQueue = approvalQueueMock("session");

    await expect(
      requirePanelAccessPermission(
        {
          approvalQueue,
          grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
          hasApprovalSession: () => true,
        },
        panelCtx(),
        "cdp",
        { id: "target", title: "Target" }
      )
    ).resolves.toMatchObject({
      allowed: true,
      capability: PANEL_AUTOMATE_CAPABILITY,
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.not.objectContaining({ signal: expect.anything() })
    );
  });

  it("leaves pending panel capability prompts open until the queue resolves them", async () => {
    vi.useFakeTimers();
    const approvalQueue = approvalQueueMock("session");
    let resolveApproval!: (decision: "deny") => void;
    vi.mocked(approvalQueue.request).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveApproval = resolve;
        })
    );

    const promise = requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
        hasApprovalSession: () => true,
      },
      panelCtx(),
      "cdp",
      { id: "target", title: "Target" }
    );

    await vi.advanceTimersByTimeAsync(60_000);
    const sentinel = Symbol("still pending");
    await expect(Promise.race([promise, Promise.resolve(sentinel)])).resolves.toBe(sentinel);

    resolveApproval("deny");
    await expect(promise).resolves.toEqual({
      allowed: false,
      capability: PANEL_AUTOMATE_CAPABILITY,
      reason: "cdp denied for panel target",
    });
  });

  it("bypasses when the requester panel resolves as privileged", async () => {
    const approvalQueue = approvalQueueMock("once");

    const result = await requirePanelAccessPermission(
      {
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
        resolveRequesterPanel: vi.fn(async () => ({ id: "about", privileged: true })),
      },
      panelCtx("panel:about"),
      "cdp",
      { id: "target", title: "Target" }
    );

    expect(result).toEqual({ allowed: true });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("bypasses shell and server callers", async () => {
    const approvalQueue = approvalQueueMock("once");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };

    for (const kind of ["shell", "shell-remote", "server"] as const) {
      await expect(
        requirePanelAccessPermission(deps, { caller: createVerifiedCaller(kind, kind) }, "close", {
          id: "target",
        })
      ).resolves.toEqual({ allowed: true });
    }

    expect(approvalQueue.request).not.toHaveBeenCalled();
  });
});

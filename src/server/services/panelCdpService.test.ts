import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createVerifiedCaller, type VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { CONTEXT_BOUNDARY_CAPABILITY, contextBoundaryResourceKey } from "./contextBoundary.js";
import { createPanelCdpService, type PanelCdpServiceDeps } from "./panelCdpService.js";
import type { PanelAccessPermissionDeps } from "./panelAccessPermission.js";
import type { ApprovalQueue } from "./approvalQueue.js";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-panel-cdp-"));
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

function ctx(id = "panel:requester") {
  return {
    caller: createVerifiedCaller(id, "panel", {
      callerId: id,
      callerKind: "panel",
      repoPath: "panels/requester",
      effectiveVersion: "version-1",
    }),
  };
}

function runtimeCtx(kind: "worker" | "do", id: string) {
  return {
    caller: createVerifiedCaller(id, kind, {
      callerId: id,
      callerKind: kind,
      repoPath: `workers/${id}`,
      effectiveVersion: "version-1",
    }),
  };
}

/**
 * Context-boundary deps for the CDP gate. Defaults model the requester in
 * `ctx-caller`; a target carrying a foreign, already-existing `contextId`
 * prompts once with `context.boundary`. Same-context / context-less targets are
 * free.
 */
function accessFields(
  overrides: Partial<PanelAccessPermissionDeps> = {}
): PanelAccessPermissionDeps {
  return {
    approvalQueue: approvalQueueMock("session"),
    grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    contextExists: vi.fn(() => true),
    resolveContextOwnerLabel: vi.fn(() => "owner"),
    resolveCallerContext: vi.fn(async () => "ctx-caller"),
    resolveEntityContext: vi.fn(() => "ctx-target"),
    resolveSubjectCaller: vi.fn(
      (id: string): VerifiedCaller =>
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

type CdpTestDeps = Partial<PanelAccessPermissionDeps> &
  Omit<PanelCdpServiceDeps, keyof PanelAccessPermissionDeps>;

/** Merge context-boundary defaults (overridable per test) with the CDP deps. */
function cdpService(deps: CdpTestDeps) {
  return createPanelCdpService({ ...accessFields(deps), ...deps });
}

describe("panelCdpService", () => {
  it("gates endpoint minting on a cross-context target", async () => {
    const approvalQueue = approvalQueueMock("session");
    const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
    const getEndpoint = vi.fn(async () => endpoint);
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["target"])).resolves.toEqual(endpoint);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        operation: expect.objectContaining({ verb: "Automate panel in" }),
      })
    );
    expect(getEndpoint).toHaveBeenCalledWith("target", "panel:requester");
  });

  it("does not prompt for a CDP target in the caller's own context", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
    const getEndpoint = vi.fn(async () => endpoint);
    const service = cdpService({
      approvalQueue,
      resolveCallerContext: vi.fn(async () => "ctx-same"),
      getTarget: () => ({ id: "target", title: "Target", kind: "browser", contextId: "ctx-same" }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["target"])).resolves.toEqual(endpoint);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(getEndpoint).toHaveBeenCalledWith("target", "panel:requester");
  });

  it("remembers cross-context CDP access per (target context, requester)", async () => {
    const approvalQueue = approvalQueueMock("version");
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" }));
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await service.handler(ctx("panel:requester-one"), "getCdpEndpoint", ["target"]);
    await service.handler(ctx("panel:requester-one"), "getCdpEndpoint", ["target"]);
    await service.handler(ctx("panel:requester-two"), "getCdpEndpoint", ["target"]);

    expect(getEndpoint).toHaveBeenCalledTimes(3);
    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:requester-one"),
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:requester-two"),
      })
    );
  });

  it("checks approval before transparent endpoint loading work", async () => {
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" }));
    const service = cdpService({
      approvalQueue: approvalQueueMock("deny"),
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["target"])).rejects.toThrow(
      "is another agent or panel's existing state"
    );

    expect(getEndpoint).not.toHaveBeenCalled();
  });

  it("does not mint an endpoint when the cross-context prompt is denied", async () => {
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" }));
    const service = cdpService({
      approvalQueue: approvalQueueMock("deny"),
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["target"])).rejects.toThrow(
      "is another agent or panel's existing state"
    );
    expect(getEndpoint).not.toHaveBeenCalled();
  });

  it("does not treat non-panel runtime ids as CDP targets", async () => {
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/worker", token: "t" }));
    const service = cdpService({
      approvalQueue: approvalQueueMock("session"),
      getTarget: (panelId) =>
        panelId.startsWith("worker:") || panelId.startsWith("do:") ? null : { id: panelId },
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["worker:agent"])).rejects.toThrow(
      "Panel not found: worker:agent"
    );
    await expect(service.handler(ctx(), "getCdpEndpoint", ["do:Store:key"])).rejects.toThrow(
      "Panel not found: do:Store:key"
    );

    expect(getEndpoint).not.toHaveBeenCalled();
  });

  it.each([["worker", "worker:agent"] as const, ["do", "do:Store:key"] as const])(
    "allows %s callers to request CDP for cross-context panel targets",
    async (kind, callerId) => {
      const approvalQueue = approvalQueueMock("session");
      const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
      const getEndpoint = vi.fn(async () => endpoint);
      const service = cdpService({
        approvalQueue,
        getTarget: () => ({ id: "target", title: "Target", contextId: "ctx-target" }),
        getEndpoint,
      });

      await expect(
        service.handler(runtimeCtx(kind, callerId), "getCdpEndpoint", ["target"])
      ).resolves.toEqual(endpoint);

      expect(approvalQueue.request).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: CONTEXT_BOUNDARY_CAPABILITY,
          grantResourceKey: contextBoundaryResourceKey("ctx-target", callerId),
        })
      );
      expect(getEndpoint).toHaveBeenCalledWith("target", callerId);
    }
  );

  it("uses severe severity for privileged cross-context targets", async () => {
    const approvalQueue = approvalQueueMock("once");
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "shell",
        title: "Shell",
        privileged: true,
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/shell", token: "t" })),
    });

    await service.handler(ctx(), "getCdpEndpoint", ["shell"]);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        severity: "severe",
      })
    );
  });

  it("gates drive verbs with the context-boundary capability", async () => {
    const approvalQueue = approvalQueueMock("session");
    const drive = vi.fn(async () => undefined);
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
    });

    await expect(
      service.handler(ctx(), "navigate", ["target", "https://example.com"])
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(drive).toHaveBeenCalledWith("target", "panel:requester", "navigate", [
      "https://example.com",
    ]);
  });

  it("allows panel caller drive verbs against cross-context workspace panels with approval", async () => {
    const approvalQueue = approvalQueueMock("session");
    const drive = vi.fn(async () => undefined);
    const logAccess = vi.fn();
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "chat-panel",
        title: "Chat",
        source: "panels/chat",
        kind: "workspace",
        contextId: "ctx-target",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
      logAccess,
    });

    await expect(
      service.handler(ctx(), "navigate", ["chat-panel", "https://example.com"])
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(drive).toHaveBeenCalledWith("chat-panel", "panel:requester", "navigate", [
      "https://example.com",
    ]);
    expect(logAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "navigate",
        requesterId: "panel:requester",
        requesterKind: "panel",
        targetId: "chat-panel",
        targetKind: "workspace",
        targetSource: "panels/chat",
      })
    );
  });

  it("allows panel caller raw CDP endpoints against cross-context workspace panels with approval", async () => {
    const approvalQueue = approvalQueueMock("session");
    const endpoint = { wsEndpoint: "ws://server/cdp/chat", token: "t" };
    const getEndpoint = vi.fn(async () => endpoint);
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "chat-panel",
        title: "Chat",
        source: "panels/chat",
        kind: "workspace",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["chat-panel"])).resolves.toEqual(
      endpoint
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(getEndpoint).toHaveBeenCalledWith("chat-panel", "panel:requester");
  });

  it("allows non-panel callers to drive same-context workspace panels without prompting", async () => {
    const approvalQueue = approvalQueueMock("session");
    const drive = vi.fn(async () => undefined);
    const service = cdpService({
      approvalQueue,
      // No contextId on the target ⇒ no context change ⇒ free.
      getTarget: () => ({ id: "target", title: "Target", kind: "workspace" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
    });

    await expect(
      service.handler(runtimeCtx("worker", "worker:agent"), "reload", ["target"])
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(drive).toHaveBeenCalledWith("target", "worker:agent", "reload", []);
  });

  it("gates historical console access with the context-boundary capability", async () => {
    const approvalQueue = approvalQueueMock("session");
    const consoleHistory = vi.fn(async () => ({
      entries: [
        {
          timestamp: 1,
          level: "info" as const,
          message: "loaded",
          line: 1,
          sourceId: "app.tsx",
          url: "https://example.com",
        },
      ],
      errors: [],
      dropped: { entries: 0, errors: 0 },
      capacity: { entries: 1000, errors: 500 },
    }));
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({ id: "target", title: "Target", contextId: "ctx-target" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      consoleHistory,
    });

    await expect(
      service.handler(ctx(), "consoleHistory", ["target", { limit: 20, errorLimit: 20 }])
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ message: "loaded" })],
      capacity: { entries: 1000, errors: 500 },
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(consoleHistory).toHaveBeenCalledWith("target", "panel:requester", {
      limit: 20,
      errorLimit: 20,
    });
  });

  it("does not read console history when approval is denied", async () => {
    const consoleHistory = vi.fn();
    const service = cdpService({
      approvalQueue: approvalQueueMock("deny"),
      getTarget: () => ({ id: "target", title: "Target", contextId: "ctx-target" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      consoleHistory,
    });

    await expect(service.handler(ctx(), "consoleHistory", ["target"])).rejects.toThrow(
      "is another agent or panel's existing state"
    );
    expect(consoleHistory).not.toHaveBeenCalled();
  });

  it("rejects non-http navigation before prompting or driving", async () => {
    const approvalQueue = approvalQueueMock("session");
    const drive = vi.fn(async () => undefined);
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({ id: "target", title: "Target", contextId: "ctx-target" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
    });

    await expect(
      service.handler(ctx(), "navigate", ["target", "file:///etc/passwd"])
    ).rejects.toThrow("Invalid URL");

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(drive).not.toHaveBeenCalled();
  });

  it("bypasses approval for shell callers", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
    const service = cdpService({
      approvalQueue,
      // A host-mediated `shell` call with no resolvable anchor entity ⇒ free.
      resolveSubjectCaller: vi.fn(() => null),
      getTarget: () => ({ id: "target", title: "Target" }),
      getEndpoint: vi.fn(async () => endpoint),
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "getCdpEndpoint", [
        "target",
      ])
    ).resolves.toEqual(endpoint);
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });
});

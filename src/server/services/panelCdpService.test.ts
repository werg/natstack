import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { PANEL_AUTOMATE_CAPABILITY } from "@natstack/shared/panelAccessPolicy";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { createPanelCdpService } from "./panelCdpService.js";
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

describe("panelCdpService", () => {
  it("gates endpoint minting through panel automation approval", async () => {
    const approvalQueue = approvalQueueMock("session");
    const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
    const getEndpoint = vi.fn(async () => endpoint);
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "target", title: "Target", kind: "browser" }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["target"])).resolves.toEqual(endpoint);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_AUTOMATE_CAPABILITY,
        title: "Automate panel",
      })
    );
    expect(getEndpoint).toHaveBeenCalledWith("target", "panel:requester");
  });

  it("remembers approved CDP access per requester entity and target", async () => {
    const approvalQueue = approvalQueueMock("version");
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" }));
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "target", title: "Target", kind: "browser" }),
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
        grantResourceKey: "panel:target:requester:panel:requester-one",
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        grantResourceKey: "panel:target:requester:panel:requester-two",
      })
    );
  });

  it("checks approval before transparent endpoint loading work", async () => {
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" }));
    const service = createPanelCdpService({
      approvalQueue: approvalQueueMock("deny"),
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "target", title: "Target", kind: "browser" }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["target"])).rejects.toThrow(
      "cdp denied for panel target"
    );

    expect(getEndpoint).not.toHaveBeenCalled();
  });

  it("does not mint an endpoint when approval is denied", async () => {
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" }));
    const service = createPanelCdpService({
      approvalQueue: approvalQueueMock("deny"),
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "target", title: "Target", kind: "browser" }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["target"])).rejects.toThrow(
      "cdp denied for panel target"
    );
    expect(getEndpoint).not.toHaveBeenCalled();
  });

  it("does not treat non-panel runtime ids as CDP targets", async () => {
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/worker", token: "t" }));
    const service = createPanelCdpService({
      approvalQueue: approvalQueueMock("session"),
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
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
    "allows %s callers to request CDP for panel targets",
    async (kind, callerId) => {
      const approvalQueue = approvalQueueMock("session");
      const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
      const getEndpoint = vi.fn(async () => endpoint);
      const service = createPanelCdpService({
        approvalQueue,
        grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
        getTarget: () => ({ id: "target", title: "Target" }),
        getEndpoint,
      });

      await expect(
        service.handler(runtimeCtx(kind, callerId), "getCdpEndpoint", ["target"])
      ).resolves.toEqual(endpoint);

      expect(approvalQueue.request).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: PANEL_AUTOMATE_CAPABILITY,
          grantResourceKey: `panel:target:requester:${callerId}`,
        })
      );
      expect(getEndpoint).toHaveBeenCalledWith("target", callerId);
    }
  );

  it("uses severe approval for privileged targets", async () => {
    const approvalQueue = approvalQueueMock("once");
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "shell", title: "Shell", privileged: true, kind: "browser" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/shell", token: "t" })),
    });

    await service.handler(ctx(), "getCdpEndpoint", ["shell"]);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: PANEL_AUTOMATE_CAPABILITY,
        severity: "severe",
        resource: expect.objectContaining({ value: "Shell" }),
      })
    );
  });

  it("gates drive verbs with the same automation capability", async () => {
    const approvalQueue = approvalQueueMock("session");
    const drive = vi.fn(async () => undefined);
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "target", title: "Target", kind: "browser" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
    });

    await expect(
      service.handler(ctx(), "navigate", ["target", "https://example.com"])
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: PANEL_AUTOMATE_CAPABILITY })
    );
    expect(drive).toHaveBeenCalledWith("target", "panel:requester", "navigate", [
      "https://example.com",
    ]);
  });

  it("rejects panel caller drive verbs against workspace panels before prompting", async () => {
    const approvalQueue = approvalQueueMock("session");
    const drive = vi.fn(async () => undefined);
    const logAccess = vi.fn();
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({
        id: "chat-panel",
        title: "Chat",
        source: "panels/chat",
        kind: "workspace",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
      logAccess,
    });

    await expect(
      service.handler(ctx(), "navigate", ["chat-panel", "https://example.com"])
    ).rejects.toThrow("Refusing to navigate workspace panel chat-panel through CDP");

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(drive).not.toHaveBeenCalled();
    expect(logAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "navigate",
        requesterId: "panel:requester",
        requesterKind: "panel",
        targetId: "chat-panel",
        targetKind: "workspace",
        targetSource: "panels/chat",
        denied: true,
      })
    );
  });

  it("rejects panel caller raw CDP endpoints against workspace panels before prompting", async () => {
    const approvalQueue = approvalQueueMock("session");
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/chat", token: "t" }));
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({
        id: "chat-panel",
        title: "Chat",
        source: "panels/chat",
        kind: "workspace",
      }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["chat-panel"])).rejects.toThrow(
      "Refusing to open raw CDP for workspace panel chat-panel through CDP"
    );

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(getEndpoint).not.toHaveBeenCalled();
  });

  it("allows non-panel callers to drive workspace panels", async () => {
    const approvalQueue = approvalQueueMock("session");
    const drive = vi.fn(async () => undefined);
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "target", title: "Target", kind: "workspace" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
    });

    await expect(
      service.handler(runtimeCtx("worker", "worker:agent"), "reload", ["target"])
    ).resolves.toBeUndefined();

    expect(drive).toHaveBeenCalledWith("target", "worker:agent", "reload", []);
  });

  it("gates historical console access with the same automation capability", async () => {
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
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "target", title: "Target" }),
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
      expect.objectContaining({ capability: PANEL_AUTOMATE_CAPABILITY })
    );
    expect(consoleHistory).toHaveBeenCalledWith("target", "panel:requester", {
      limit: 20,
      errorLimit: 20,
    });
  });

  it("does not read console history when approval is denied", async () => {
    const consoleHistory = vi.fn();
    const service = createPanelCdpService({
      approvalQueue: approvalQueueMock("deny"),
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "target", title: "Target" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      consoleHistory,
    });

    await expect(service.handler(ctx(), "consoleHistory", ["target"])).rejects.toThrow(
      "cdp denied for panel target"
    );
    expect(consoleHistory).not.toHaveBeenCalled();
  });

  it("rejects non-http navigation before prompting or driving", async () => {
    const approvalQueue = approvalQueueMock("session");
    const drive = vi.fn(async () => undefined);
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      getTarget: () => ({ id: "target", title: "Target" }),
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
    const service = createPanelCdpService({
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
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

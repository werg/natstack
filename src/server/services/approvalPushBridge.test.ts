import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_CATEGORY_DECIDE,
  APPROVAL_CATEGORY_INPUT_REQUIRED,
} from "@natstack/shared/approvalContract";
import { createApprovalQueue } from "./approvalQueue.js";
import { createApprovalPushBridge } from "./approvalPushBridge.js";
import type { PushSendResult, PushServiceInternal } from "./pushService.js";

const SENT_PUSH_RESULT: PushSendResult = {
  clientId: "mobile-1",
  platform: "android",
  sent: true,
  logOnly: false,
};

function createQueue() {
  return createApprovalQueue({ eventService: { emit: vi.fn() } as never });
}

function createPushMock(): PushServiceInternal & { triggerRegistrationsChanged(): void } {
  const registrationListeners = new Set<() => void>();
  return {
    send: vi.fn(),
    sendBatch: vi.fn(async () => [SENT_PUSH_RESULT]),
    cancel: vi.fn(async () => []),
    listRegistrations: vi.fn(() => []),
    onRegistrationsChanged: vi.fn((listener) => {
      registrationListeners.add(listener);
      return () => registrationListeners.delete(listener);
    }),
    unregister: vi.fn(() => false),
    triggerRegistrationsChanged() {
      for (const listener of registrationListeners) listener();
    },
  };
}

function requestCapability(queue: ReturnType<typeof createQueue>) {
  return queue.request({
    kind: "capability",
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/example",
    effectiveVersion: "hash-1",
    capability: "external-browser-open",
    title: "Open external browser",
    resource: {
      type: "url-origin",
      label: "Origin",
      value: "https://example.com",
    },
  });
}

function requestAppSourcePush(queue: ReturnType<typeof createQueue>) {
  return queue.request({
    kind: "unit-batch",
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/example",
    effectiveVersion: "hash-1",
    trigger: "source-push",
    title: "@workspace-apps/shell app source push",
    description: "Accepting this push updates trusted workspace app code.",
    units: [
      {
        unitKind: "app",
        unitName: "@workspace-apps/shell",
        displayName: "Shell",
        version: "1.0.0",
        target: "electron",
        source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
        ev: "ev-shell",
        capabilities: ["notifications"],
      },
    ],
    configWrite: null,
  });
}

function requestUnitManagement(queue: ReturnType<typeof createQueue>) {
  return queue.request({
    kind: "unit-batch",
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/example",
    effectiveVersion: "hash-1",
    trigger: "management",
    title: "Reload extension",
    description: "Allow panel panel-1 to reload @workspace-extensions/image-service.",
    units: [
      {
        unitKind: "extension",
        unitName: "@workspace-extensions/image-service",
        displayName: "Image Service",
        version: "1.0.0",
        target: null,
        source: { kind: "internal-git", repo: "extensions/image-service", ref: "main" },
        ev: "ev-image",
        capabilities: ["node:fs"],
      },
    ],
    configWrite: null,
  });
}

function requestDoCapability(queue: ReturnType<typeof createQueue>) {
  return queue.request({
    kind: "capability",
    callerId: "do:workers/example:ExampleDO:agent-1",
    callerKind: "do",
    repoPath: "workers/example",
    effectiveVersion: "hash-1",
    capability: "external-browser-open",
    title: "Open external browser",
    resource: {
      type: "url-origin",
      label: "Origin",
      value: "https://example.com",
    },
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createTimerHarness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const setTimeoutFn = ((callback: () => void, delay?: number) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { due: now + (delay ?? 0), callback });
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as typeof clearTimeout;

  return {
    setTimeoutFn,
    clearTimeoutFn,
    advanceByTime(ms: number) {
      now += ms;
      while (true) {
        const nextTimer = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort(([, a], [, b]) => a.due - b.due)[0];
        if (!nextTimer) return;
        const [id, timer] = nextTimer;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

describe("approvalPushBridge", () => {
  it("fans out approval pushes and deduplicates by approvalId", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const first = requestCapability(queue);
    const second = requestCapability(queue);
    await flush();

    expect(push.sendBatch).toHaveBeenCalledTimes(1);
    expect(push.sendBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: APPROVAL_CATEGORY_DECIDE,
        data: expect.objectContaining({
          kind: "approval-prompt",
          approvalKind: "capability",
          category: APPROVAL_CATEGORY_DECIDE,
        }),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(first).resolves.toBe("deny");
    await expect(second).resolves.toBe("deny");
  });

  it("cancels local notifications when an approval resolves", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });
    const promise = requestCapability(queue);
    await flush();
    const approvalId = queue.listPending()[0]!.approvalId;

    queue.resolve(approvalId, "once");
    await flush();

    expect(push.cancel).toHaveBeenCalledWith(approvalId);
    await expect(promise).resolves.toBe("once");
  });

  it("delays pushes until the deadline while a desktop shell remains active", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => true,
        markActive: vi.fn(),
        getActiveShellCount: () => 1,
      },
      delayMs: 10_000,
      presenceMaxAgeMs: 6_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    expect(push.sendBatch).not.toHaveBeenCalled();

    timers.advanceByTime(10_000);
    await flush();
    expect(push.sendBatch).toHaveBeenCalledTimes(1);

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("fires a delayed push when shell presence goes stale", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    let active = true;
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => active,
        markActive: vi.fn(),
        getActiveShellCount: () => (active ? 1 : 0),
      },
      delayMs: 10_000,
      presenceMaxAgeMs: 6_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    active = false;
    timers.advanceByTime(6_000);
    await flush();

    expect(push.sendBatch).toHaveBeenCalledTimes(1);

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("clears delayed sends when the approval resolves before any push is sent", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => true,
        markActive: vi.fn(),
        getActiveShellCount: () => 1,
      },
      delayMs: 10_000,
      presenceMaxAgeMs: 6_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    const approvalId = queue.listPending()[0]!.approvalId;
    queue.resolve(approvalId, "deny");
    timers.advanceByTime(10_000);
    await flush();

    expect(push.sendBatch).not.toHaveBeenCalled();
    expect(push.cancel).not.toHaveBeenCalled();
    await expect(promise).resolves.toBe("deny");
  });

  it("routes field-input approval kinds to the open-only category", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = queue.requestClientConfig({
      kind: "client-config",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      configId: "github",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      title: "Configure GitHub",
      fields: [{ name: "clientId", label: "Client ID", type: "text", required: true }],
    });
    await flush();

    expect(push.sendBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: APPROVAL_CATEGORY_INPUT_REQUIRED,
        data: expect.objectContaining({
          actionsJson: JSON.stringify([{ id: "open", title: "Open" }]),
        }),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toEqual({ decision: "deny" });
  });

  it("offers session grants for unit source-push approvals", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestAppSourcePush(queue);
    await flush();

    expect(push.sendBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalKind: "unit-batch",
          actionsJson: JSON.stringify([
            { id: "once", title: "Approve push" },
            { id: "session", title: "Session" },
            { id: "deny", title: "Deny" },
            { id: "open", title: "Open" },
          ]),
        }),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "session");
    await expect(promise).resolves.toBe("session");
  });

  it("does not offer session grants for unit management approvals", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestUnitManagement(queue);
    await flush();

    expect(push.sendBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvalKind: "unit-batch",
          actionsJson: JSON.stringify([
            { id: "once", title: "Approve" },
            { id: "deny", title: "Deny" },
            { id: "open", title: "Open" },
          ]),
        }),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "once");
    await expect(promise).resolves.toBe("once");
  });

  it("labels DO-origin approvals accurately in push copy", async () => {
    const queue = createQueue();
    const push = createPushMock();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestDoCapability(queue);
    await flush();

    expect(push.sendBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("DO"),
      })
    );

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("resends pending approvals when a push registration appears later", async () => {
    const queue = createQueue();
    const push = createPushMock();
    vi.mocked(push.sendBatch).mockResolvedValueOnce([]).mockResolvedValueOnce([SENT_PUSH_RESULT]);
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestCapability(queue);
    await flush();
    expect(push.sendBatch).toHaveBeenCalledTimes(1);

    push.triggerRegistrationsChanged();
    await flush();
    expect(push.sendBatch).toHaveBeenCalledTimes(2);

    const approvalId = queue.listPending()[0]!.approvalId;
    queue.resolve(approvalId, "deny");
    await flush();

    expect(push.cancel).toHaveBeenCalledWith(approvalId);
    await expect(promise).resolves.toBe("deny");
  });

  it("does not send a cancel for a delayed approval that never pushed", async () => {
    const queue = createQueue();
    const push = createPushMock();
    const timers = createTimerHarness();
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => true,
        markActive: vi.fn(),
        getActiveShellCount: () => 1,
      },
      delayMs: 10_000,
      presenceMaxAgeMs: 6_000,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const promise = requestCapability(queue);
    const approvalId = queue.listPending()[0]!.approvalId;
    queue.resolve(approvalId, "deny");
    timers.advanceByTime(10_000);
    await flush();

    expect(push.sendBatch).not.toHaveBeenCalled();
    expect(push.cancel).not.toHaveBeenCalled();
    await expect(promise).resolves.toBe("deny");
  });

  it("does not send a cancel when every push attempt fails", async () => {
    const queue = createQueue();
    const push = createPushMock();
    vi.mocked(push.sendBatch).mockResolvedValue([
      {
        clientId: "mobile-1",
        platform: "android",
        sent: false,
        logOnly: false,
        error: "dead token",
      },
    ]);
    createApprovalPushBridge({
      approvalQueue: queue,
      push,
      shellPresence: {
        isAnyShellActive: () => false,
        markActive: vi.fn(),
        getActiveShellCount: () => 0,
      },
    });

    const promise = requestCapability(queue);
    await flush();
    const approvalId = queue.listPending()[0]!.approvalId;

    queue.resolve(approvalId, "deny");
    await flush();

    expect(push.cancel).not.toHaveBeenCalled();
    await expect(promise).resolves.toBe("deny");
  });
});

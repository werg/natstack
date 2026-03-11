import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkerActions, WorkerAction, TurnInput } from "@natstack/harness";
import { executeActions, type ExecuteActionsContext } from "./executeActions.js";
import type { PubSubFacade, ParticipantEntry } from "./services/pubsubFacade.js";
import type { HarnessManager } from "./harnessManager.js";
import type { WorkerRouter } from "./workerRouter.js";

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockFacade(
  overrides?: Partial<PubSubFacade>,
): PubSubFacade {
  return {
    executeChannelAction: vi.fn(),
    getHandle: vi.fn().mockReturnValue({
      className: "TestDO",
      objectKey: "key-1",
    } satisfies Partial<ParticipantEntry>),
    ...overrides,
  } as unknown as PubSubFacade;
}

function createMockBridge() {
  return {
    call: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockHarnessManager(
  overrides?: Partial<HarnessManager>,
): HarnessManager {
  return {
    getHarnessBridge: vi.fn().mockReturnValue(createMockBridge()),
    spawn: vi.fn().mockResolvedValue(undefined),
    waitForBridge: vi.fn().mockResolvedValue(createMockBridge()),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as HarnessManager;
}

function createMockRouter(overrides?: Partial<WorkerRouter>): WorkerRouter {
  return {
    registerHarness: vi.fn(),
    unregisterHarness: vi.fn(),
    registerParticipant: vi.fn(),
    dispatch: vi.fn().mockResolvedValue({ actions: [] } satisfies WorkerActions),
    ...overrides,
  } as unknown as WorkerRouter;
}

function createContext(overrides?: Partial<ExecuteActionsContext>): ExecuteActionsContext {
  return {
    facade: createMockFacade(),
    harnessManager: createMockHarnessManager(),
    router: createMockRouter(),
    ensureContextFolder: vi.fn(async () => "/workspace/.contexts/ctx-test"),
    participantId: "participant-1",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("executeActions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Empty actions ────────────────────────────────────────────────────────

  it("does nothing for an empty actions array", async () => {
    const ctx = createContext();
    await executeActions({ actions: [] }, ctx);

    expect(ctx.facade.executeChannelAction).not.toHaveBeenCalled();
  });

  // ── Channel actions ──────────────────────────────────────────────────────

  describe("channel actions", () => {
    it("forwards a send action to the facade", async () => {
      const ctx = createContext();
      const action: WorkerAction = {
        target: "channel",
        channelId: "ch-1",
        op: "send",
        messageId: "msg-1",
        content: "hello",
        options: { type: "text", persist: true },
      };

      await executeActions({ actions: [action] }, ctx);

      expect(ctx.facade.executeChannelAction).toHaveBeenCalledWith(
        action,
        "participant-1",
      );
    });

    it("forwards an update action to the facade", async () => {
      const ctx = createContext();
      const action: WorkerAction = {
        target: "channel",
        channelId: "ch-1",
        op: "update",
        messageId: "msg-1",
        content: "updated content",
      };

      await executeActions({ actions: [action] }, ctx);

      expect(ctx.facade.executeChannelAction).toHaveBeenCalledWith(
        action,
        "participant-1",
      );
    });

    it("forwards a complete action to the facade", async () => {
      const ctx = createContext();
      const action: WorkerAction = {
        target: "channel",
        channelId: "ch-1",
        op: "complete",
        messageId: "msg-1",
      };

      await executeActions({ actions: [action] }, ctx);

      expect(ctx.facade.executeChannelAction).toHaveBeenCalledWith(
        action,
        "participant-1",
      );
    });

    it("forwards a method-result action to the facade", async () => {
      const ctx = createContext();
      const action: WorkerAction = {
        target: "channel",
        channelId: "ch-1",
        op: "method-result",
        callId: "call-1",
        content: { data: "result" },
        isError: false,
      };

      await executeActions({ actions: [action] }, ctx);

      expect(ctx.facade.executeChannelAction).toHaveBeenCalledWith(
        action,
        "participant-1",
      );
    });

    it("forwards an update-metadata action to the facade", async () => {
      const ctx = createContext();
      const action: WorkerAction = {
        target: "channel",
        channelId: "ch-1",
        op: "update-metadata",
        metadata: { status: "typing" },
      };

      await executeActions({ actions: [action] }, ctx);

      expect(ctx.facade.executeChannelAction).toHaveBeenCalledWith(
        action,
        "participant-1",
      );
    });

    it("forwards a send-ephemeral action to the facade", async () => {
      const ctx = createContext();
      const action: WorkerAction = {
        target: "channel",
        channelId: "ch-1",
        op: "send-ephemeral",
        content: "ephemeral message",
        contentType: "status",
      };

      await executeActions({ actions: [action] }, ctx);

      expect(ctx.facade.executeChannelAction).toHaveBeenCalledWith(
        action,
        "participant-1",
      );
    });
  });

  // ── Harness actions ──────────────────────────────────────────────────────

  describe("harness actions", () => {
    it("forwards a start-turn command to the bridge", async () => {
      const bridge = createMockBridge();
      const harnessManager = createMockHarnessManager({
        getHarnessBridge: vi.fn().mockReturnValue(bridge),
      });
      const ctx = createContext({ harnessManager });

      const input: TurnInput = {
        content: "hello",
        senderId: "user-1",
      };
      const action: WorkerAction = {
        target: "harness",
        harnessId: "harness-1",
        command: { type: "start-turn", input },
      };

      await executeActions({ actions: [action] }, ctx);

      expect(harnessManager.getHarnessBridge).toHaveBeenCalledWith("harness-1");
      expect(bridge.call).toHaveBeenCalledWith(
        "harness-1",
        "startTurn",
        input,
      );
    });

    it("forwards an approve-tool command to the bridge", async () => {
      const bridge = createMockBridge();
      const harnessManager = createMockHarnessManager({
        getHarnessBridge: vi.fn().mockReturnValue(bridge),
      });
      const ctx = createContext({ harnessManager });

      const action: WorkerAction = {
        target: "harness",
        harnessId: "harness-1",
        command: {
          type: "approve-tool",
          toolUseId: "tool-1",
          allow: true,
          alwaysAllow: false,
        },
      };

      await executeActions({ actions: [action] }, ctx);

      expect(bridge.call).toHaveBeenCalledWith(
        "harness-1",
        "approveTool",
        "tool-1",
        true,
        false,
      );
    });

    it("forwards an interrupt command to the bridge", async () => {
      const bridge = createMockBridge();
      const harnessManager = createMockHarnessManager({
        getHarnessBridge: vi.fn().mockReturnValue(bridge),
      });
      const ctx = createContext({ harnessManager });

      const action: WorkerAction = {
        target: "harness",
        harnessId: "harness-1",
        command: { type: "interrupt" },
      };

      await executeActions({ actions: [action] }, ctx);

      expect(bridge.call).toHaveBeenCalledWith("harness-1", "interrupt");
    });

    it("forwards a fork command to the bridge", async () => {
      const bridge = createMockBridge();
      const harnessManager = createMockHarnessManager({
        getHarnessBridge: vi.fn().mockReturnValue(bridge),
      });
      const ctx = createContext({ harnessManager });

      const action: WorkerAction = {
        target: "harness",
        harnessId: "harness-1",
        command: {
          type: "fork",
          forkPointMessageId: 42,
          turnSessionId: "session-abc",
        },
      };

      await executeActions({ actions: [action] }, ctx);

      expect(bridge.call).toHaveBeenCalledWith(
        "harness-1",
        "fork",
        42,
        "session-abc",
      );
    });

    it("forwards a dispose command to the bridge", async () => {
      const bridge = createMockBridge();
      const harnessManager = createMockHarnessManager({
        getHarnessBridge: vi.fn().mockReturnValue(bridge),
      });
      const ctx = createContext({ harnessManager });

      const action: WorkerAction = {
        target: "harness",
        harnessId: "harness-1",
        command: { type: "dispose" },
      };

      await executeActions({ actions: [action] }, ctx);

      expect(bridge.call).toHaveBeenCalledWith("harness-1", "dispose");
    });

    it("skips when no bridge is found for a harness", async () => {
      const harnessManager = createMockHarnessManager({
        getHarnessBridge: vi.fn().mockReturnValue(undefined),
      });
      const ctx = createContext({ harnessManager });

      const action: WorkerAction = {
        target: "harness",
        harnessId: "missing-harness",
        command: { type: "interrupt" },
      };

      // Should not throw
      await executeActions({ actions: [action] }, ctx);

      expect(harnessManager.getHarnessBridge).toHaveBeenCalledWith("missing-harness");
    });
  });

  // ── System actions ─────────────────────────────────────────────────────

  describe("system actions", () => {
    describe("spawn-harness", () => {
      it("performs the full bootstrap: register, spawn, waitForBridge, notify DO", async () => {
        const bridge = createMockBridge();
        const harnessManager = createMockHarnessManager({
          waitForBridge: vi.fn().mockResolvedValue(bridge),
        });
        const router = createMockRouter();
        const facade = createMockFacade();
        const ctx = createContext({ facade, harnessManager, router });

        const action: WorkerAction = {
          target: "system",
          op: "spawn-harness",
          type: "claude-sdk",
          channelId: "ch-1",
          contextId: "ctx-1",
        };

        await executeActions({ actions: [action] }, ctx);

        // Step 1: register harness with router
        expect(router.registerHarness).toHaveBeenCalledTimes(1);
        const registeredHarnessId = (router.registerHarness as ReturnType<typeof vi.fn>).mock
          .calls[0]![0] as string;
        expect(registeredHarnessId).toMatch(/^harness:/);

        // Step 2: spawn
        expect(harnessManager.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            id: registeredHarnessId,
            type: "claude-sdk",
            channel: "ch-1",
            contextId: "ctx-1",
          }),
        );

        // Step 3: wait for bridge
        expect(harnessManager.waitForBridge).toHaveBeenCalledWith(registeredHarnessId);

        // Step 4: notify DO (onHarnessEvent with ready)
        expect(router.dispatch).toHaveBeenCalledWith(
          "TestDO",
          "key-1",
          "onHarnessEvent",
          registeredHarnessId,
          { type: "ready" },
        );
      });

      it("starts the initial turn when provided", async () => {
        const bridge = createMockBridge();
        const harnessManager = createMockHarnessManager({
          waitForBridge: vi.fn().mockResolvedValue(bridge),
        });
        const router = createMockRouter();
        const facade = createMockFacade();
        const ctx = createContext({ facade, harnessManager, router });

        const input: TurnInput = {
          content: "hello world",
          senderId: "user-1",
        };
        const action: WorkerAction = {
          target: "system",
          op: "spawn-harness",
          type: "claude-sdk",
          channelId: "ch-1",
          contextId: "ctx-1",
          initialTurn: {
            input,
            triggerMessageId: "trigger-1",
            triggerPubsubId: 10,
          },
        };

        await executeActions({ actions: [action] }, ctx);

        // Step 6: initial turn via bridge.call
        expect(bridge.call).toHaveBeenCalledWith(
          expect.stringMatching(/^harness:/),
          "startTurn",
          input,
        );
      });

      it("cleans up and notifies DO on spawn failure", async () => {
        const spawnError = new Error("spawn failed");
        const harnessManager = createMockHarnessManager({
          spawn: vi.fn().mockRejectedValue(spawnError),
        });
        const router = createMockRouter();
        const facade = createMockFacade();
        const ctx = createContext({ facade, harnessManager, router });

        const action: WorkerAction = {
          target: "system",
          op: "spawn-harness",
          type: "claude-sdk",
          channelId: "ch-1",
          contextId: "ctx-1",
        };

        await executeActions({ actions: [action] }, ctx);

        // Should unregister harness from router
        expect(router.unregisterHarness).toHaveBeenCalledTimes(1);

        // Should attempt to stop the harness
        expect(harnessManager.stop).toHaveBeenCalledTimes(1);

        // Should notify DO of error
        expect(router.dispatch).toHaveBeenCalledWith(
          "TestDO",
          "key-1",
          "onHarnessEvent",
          expect.stringMatching(/^harness:/),
          { type: "error", error: "Error: spawn failed", code: "spawn-failed" },
        );
      });

      it("returns early when no participant entry is found", async () => {
        const facade = createMockFacade({
          getHandle: vi.fn().mockReturnValue(undefined),
        });
        const router = createMockRouter();
        const harnessManager = createMockHarnessManager();
        const ctx = createContext({ facade, harnessManager, router });

        const action: WorkerAction = {
          target: "system",
          op: "spawn-harness",
          type: "claude-sdk",
          channelId: "ch-1",
          contextId: "ctx-1",
        };

        await executeActions({ actions: [action] }, ctx);

        expect(router.registerHarness).not.toHaveBeenCalled();
        expect(harnessManager.spawn).not.toHaveBeenCalled();
      });
    });

    describe("respawn-harness", () => {
      it("re-registers, spawns, waits for bridge, and notifies DO", async () => {
        const bridge = createMockBridge();
        const harnessManager = createMockHarnessManager({
          waitForBridge: vi.fn().mockResolvedValue(bridge),
        });
        const router = createMockRouter();
        const facade = createMockFacade();
        const ctx = createContext({ facade, harnessManager, router });

        const action: WorkerAction = {
          target: "system",
          op: "respawn-harness",
          harnessId: "harness-existing",
          channelId: "ch-1",
          contextId: "ctx-1",
          resumeSessionId: "session-abc",
        };

        await executeActions({ actions: [action] }, ctx);

        // Re-register harness
        expect(router.registerHarness).toHaveBeenCalledWith(
          "harness-existing",
          "TestDO",
          "key-1",
        );

        // Spawn with resume session
        expect(harnessManager.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "harness-existing",
            type: "claude-sdk",
            channel: "ch-1",
            contextId: "ctx-1",
            resumeSessionId: "session-abc",
          }),
        );

        // Wait for bridge
        expect(harnessManager.waitForBridge).toHaveBeenCalledWith("harness-existing");

        // Notify DO
        expect(router.dispatch).toHaveBeenCalledWith(
          "TestDO",
          "key-1",
          "onHarnessEvent",
          "harness-existing",
          { type: "ready" },
        );
      });

      it("retries the turn when retryTurn is provided", async () => {
        const bridge = createMockBridge();
        const harnessManager = createMockHarnessManager({
          waitForBridge: vi.fn().mockResolvedValue(bridge),
        });
        const ctx = createContext({ harnessManager });

        const input: TurnInput = {
          content: "retry input",
          senderId: "user-1",
        };
        const action: WorkerAction = {
          target: "system",
          op: "respawn-harness",
          harnessId: "harness-existing",
          channelId: "ch-1",
          contextId: "ctx-1",
          retryTurn: {
            input,
            triggerMessageId: "trigger-1",
            triggerPubsubId: 5,
          },
        };

        await executeActions({ actions: [action] }, ctx);

        expect(bridge.call).toHaveBeenCalledWith(
          "harness-existing",
          "startTurn",
          input,
        );
      });

      it("cleans up on respawn failure", async () => {
        const harnessManager = createMockHarnessManager({
          spawn: vi.fn().mockRejectedValue(new Error("respawn failed")),
        });
        const router = createMockRouter();
        const ctx = createContext({ harnessManager, router });

        const action: WorkerAction = {
          target: "system",
          op: "respawn-harness",
          harnessId: "harness-existing",
          channelId: "ch-1",
          contextId: "ctx-1",
        };

        await executeActions({ actions: [action] }, ctx);

        expect(router.unregisterHarness).toHaveBeenCalledWith("harness-existing");
        expect(harnessManager.stop).toHaveBeenCalledWith("harness-existing");
      });

      it("returns early when no participant entry is found", async () => {
        const facade = createMockFacade({
          getHandle: vi.fn().mockReturnValue(undefined),
        });
        const router = createMockRouter();
        const harnessManager = createMockHarnessManager();
        const ctx = createContext({ facade, harnessManager, router });

        const action: WorkerAction = {
          target: "system",
          op: "respawn-harness",
          harnessId: "harness-existing",
          channelId: "ch-1",
          contextId: "ctx-1",
        };

        await executeActions({ actions: [action] }, ctx);

        expect(router.registerHarness).not.toHaveBeenCalled();
        expect(harnessManager.spawn).not.toHaveBeenCalled();
      });
    });
  });

  // ── Mixed action types ───────────────────────────────────────────────────

  describe("mixed action types", () => {
    it("processes channel, harness, and system actions in order", async () => {
      const bridge = createMockBridge();
      const harnessManager = createMockHarnessManager({
        getHarnessBridge: vi.fn().mockReturnValue(bridge),
      });
      const facade = createMockFacade();
      const router = createMockRouter();
      const ctx = createContext({ facade, harnessManager, router });

      const callOrder: string[] = [];
      (facade.executeChannelAction as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("channel");
      });
      (bridge.call as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("harness");
      });

      const actions: WorkerActions = {
        actions: [
          {
            target: "channel",
            channelId: "ch-1",
            op: "send",
            messageId: "msg-1",
            content: "hello",
          },
          {
            target: "harness",
            harnessId: "harness-1",
            command: { type: "interrupt" },
          },
          {
            target: "channel",
            channelId: "ch-1",
            op: "complete",
            messageId: "msg-1",
          },
        ],
      };

      await executeActions(actions, ctx);

      expect(callOrder).toEqual(["channel", "harness", "channel"]);
      expect(facade.executeChannelAction).toHaveBeenCalledTimes(2);
      expect(bridge.call).toHaveBeenCalledTimes(1);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────

  describe("error handling", () => {
    it("continues processing remaining actions when one throws", async () => {
      const facade = createMockFacade();
      const bridge = createMockBridge();
      bridge.call.mockRejectedValueOnce(new Error("bridge error"));
      const harnessManager = createMockHarnessManager({
        getHarnessBridge: vi.fn().mockReturnValue(bridge),
      });
      const ctx = createContext({ facade, harnessManager });

      const actions: WorkerActions = {
        actions: [
          {
            target: "harness",
            harnessId: "harness-1",
            command: { type: "interrupt" },
          },
          {
            target: "channel",
            channelId: "ch-1",
            op: "send",
            messageId: "msg-1",
            content: "after error",
          },
        ],
      };

      // Should not throw
      await executeActions(actions, ctx);

      // The second action should still be processed
      expect(facade.executeChannelAction).toHaveBeenCalledTimes(1);
    });

    it("handles missing participant handle for spawn-harness gracefully", async () => {
      const facade = createMockFacade({
        getHandle: vi.fn().mockReturnValue(undefined),
      });
      const harnessManager = createMockHarnessManager();
      const router = createMockRouter();
      const ctx = createContext({ facade, harnessManager, router });

      const action: WorkerAction = {
        target: "system",
        op: "spawn-harness",
        type: "claude-sdk",
        channelId: "ch-1",
        contextId: "ctx-1",
      };

      // Should not throw
      await executeActions({ actions: [action] }, ctx);

      // No spawn attempted since there is no handle
      expect(harnessManager.spawn).not.toHaveBeenCalled();
    });

    it("handles missing bridge for harness action gracefully", async () => {
      const harnessManager = createMockHarnessManager({
        getHarnessBridge: vi.fn().mockReturnValue(undefined),
      });
      const ctx = createContext({ harnessManager });

      const action: WorkerAction = {
        target: "harness",
        harnessId: "nonexistent",
        command: { type: "start-turn", input: { content: "test", senderId: "u" } },
      };

      // Should not throw
      await executeActions({ actions: [action] }, ctx);

      expect(harnessManager.getHarnessBridge).toHaveBeenCalledWith("nonexistent");
    });

    it("handles channel action errors without stopping subsequent actions", async () => {
      const facade = createMockFacade();
      (facade.executeChannelAction as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(() => {
          throw new Error("channel send failed");
        });
      const ctx = createContext({ facade });

      const actions: WorkerActions = {
        actions: [
          {
            target: "channel",
            channelId: "ch-1",
            op: "send",
            messageId: "msg-1",
            content: "will fail",
          },
          {
            target: "channel",
            channelId: "ch-1",
            op: "send",
            messageId: "msg-2",
            content: "should succeed",
          },
        ],
      };

      await executeActions(actions, ctx);

      // Both should have been attempted
      expect(facade.executeChannelAction).toHaveBeenCalledTimes(2);
    });
  });
});

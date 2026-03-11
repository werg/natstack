import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChannelService } from "./channelService.js";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { ServiceContext } from "../../shared/serviceDispatcher.js";

// ─── Mock types ──────────────────────────────────────────────────────────────

interface MockMessageStore {
  createChannel: ReturnType<typeof vi.fn>;
  setChannelFork: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
}

interface MockPubSubServer {
  getMessageStore: ReturnType<typeof vi.fn>;
  getChannelParticipants: ReturnType<typeof vi.fn>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockMessageStore(): MockMessageStore {
  return {
    createChannel: vi.fn(),
    setChannelFork: vi.fn(),
    insert: vi.fn(() => 1),
  };
}

function createMockPubSub(messageStore: MockMessageStore): MockPubSubServer {
  return {
    getMessageStore: vi.fn(() => messageStore),
    getChannelParticipants: vi.fn(() => []),
  };
}

function createCtx(overrides: Partial<ServiceContext> = {}): ServiceContext {
  return {
    callerId: "test-caller",
    callerKind: "worker",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("channelService", () => {
  let messageStore: MockMessageStore;
  let pubsub: MockPubSubServer;
  let mockRouter: {
    getDOForHarness: ReturnType<typeof vi.fn>;
    getParticipantsForDO: ReturnType<typeof vi.fn>;
    dispatch: ReturnType<typeof vi.fn>;
  };
  let mockFacade: { callParticipantMethod: ReturnType<typeof vi.fn> };
  let mockHarnessManager: { getHarnessBridge: ReturnType<typeof vi.fn> };
  let service: ServiceDefinition;
  let ctx: ServiceContext;

  beforeEach(() => {
    messageStore = createMockMessageStore();
    pubsub = createMockPubSub(messageStore);
    mockRouter = {
      getDOForHarness: vi.fn().mockReturnValue({ className: "AgentWorker", objectKey: "key-1" }),
      getParticipantsForDO: vi.fn().mockReturnValue(["do:AgentWorker:key-1:agent"]),
      dispatch: vi.fn().mockImplementation(
        async (
          _className: string,
          _objectKey: string,
          method: string,
          channelId: string,
          callId: string,
          participantId: string,
          methodName: string,
          methodArgs: unknown,
        ) => {
          expect(method).toBe("onOutgoingMethodCall");
          return {
            actions: [{
              target: "channel",
              channelId,
              op: "call-method",
              callId,
              participantId,
              method: methodName,
              args: methodArgs,
            }],
          };
        },
      ),
    };
    mockFacade = {
      callParticipantMethod: vi.fn().mockResolvedValue({ ok: true }),
    };
    mockHarnessManager = {
      getHarnessBridge: vi.fn(),
    };
    service = createChannelService({
      pubsub: pubsub as never,
      router: mockRouter as never,
      facade: mockFacade as never,
      harnessManager: mockHarnessManager as never,
    });
    ctx = createCtx();
  });

  it("has correct service name and policy", () => {
    expect(service.name).toBe("channel");
    expect(service.policy).toEqual({ allowed: ["server", "worker", "harness"] });
  });

  describe("fork", () => {
    it("creates a forked channel with correct parent and forkPoint", async () => {
      const result = (await service.handler(ctx, "fork", [
        "source-chan",
        42,
      ])) as { channelId: string };

      expect(result.channelId).toMatch(/^fork:source-chan:[a-f0-9]{8}$/);

      expect(messageStore.createChannel).toHaveBeenCalledOnce();
      expect(messageStore.createChannel).toHaveBeenCalledWith(
        result.channelId,
        "default",
        "system",
      );

      expect(messageStore.setChannelFork).toHaveBeenCalledOnce();
      expect(messageStore.setChannelFork).toHaveBeenCalledWith(
        result.channelId,
        "source-chan",
        42,
      );
    });

    it("uses provided contextId and createdBy options", async () => {
      const result = (await service.handler(ctx, "fork", [
        "source-chan",
        10,
        { contextId: "ctx-123", createdBy: "user-alice" },
      ])) as { channelId: string };

      expect(messageStore.createChannel).toHaveBeenCalledWith(
        result.channelId,
        "ctx-123",
        "user-alice",
      );
    });

    it("defaults contextId to 'default' and createdBy to 'system' when options omitted", async () => {
      await service.handler(ctx, "fork", ["chan-abc", 5]);

      expect(messageStore.createChannel).toHaveBeenCalledWith(
        expect.stringContaining("fork:chan-abc:"),
        "default",
        "system",
      );
    });

    it("returns a unique channelId on each call", async () => {
      const r1 = (await service.handler(ctx, "fork", ["c", 1])) as { channelId: string };
      const r2 = (await service.handler(ctx, "fork", ["c", 1])) as { channelId: string };

      expect(r1.channelId).not.toBe(r2.channelId);
    });
  });

  describe("callMethod", () => {
    it("routes the call through DO middleware before delegating to the facade", async () => {
      await service.handler(ctx, "callMethod", [
        "chan-1",
        "participant-abc",
        "doSomething",
        { foo: "bar" },
      ]);

      expect(mockRouter.getDOForHarness).toHaveBeenCalledWith("test-caller");
      expect(mockRouter.getParticipantsForDO).toHaveBeenCalledWith("AgentWorker", "key-1");
      expect(mockRouter.dispatch).toHaveBeenCalledWith(
        "AgentWorker",
        "key-1",
        "onOutgoingMethodCall",
        "chan-1",
        expect.any(String),
        "participant-abc",
        "doSomething",
        { foo: "bar" },
      );
      expect(mockFacade.callParticipantMethod).toHaveBeenCalledOnce();
      const [callerPid, channelId, targetPid, callId, method, args] =
        mockFacade.callParticipantMethod.mock.calls[0]!;
      expect(callerPid).toBe("do:AgentWorker:key-1:agent");
      expect(channelId).toBe("chan-1");
      expect(targetPid).toBe("participant-abc");
      expect(typeof callId).toBe("string");
      expect(method).toBe("doSomething");
      expect(args).toEqual({ foo: "bar" });
    });

    it("resolves caller participant from the harness's owning DO", async () => {
      mockRouter.getDOForHarness.mockReturnValue({ className: "ReviewerDO", objectKey: "rev-1" });
      mockRouter.getParticipantsForDO.mockReturnValue(["do:ReviewerDO:rev-1:reviewer"]);

      const customCtx = createCtx({ callerId: "harness-7" });
      await service.handler(customCtx, "callMethod", [
        "chan-x",
        "p1",
        "run",
        null,
      ]);

      expect(mockRouter.getDOForHarness).toHaveBeenCalledWith("harness-7");
      expect(mockFacade.callParticipantMethod.mock.calls[0]![0]).toBe("do:ReviewerDO:rev-1:reviewer");
    });

    it("returns a direct method-result when the DO short-circuits the call", async () => {
      mockRouter.dispatch.mockImplementation(
        async (
          _className: string,
          _objectKey: string,
          _method: string,
          channelId: string,
          callId: string,
        ) => ({
          actions: [{
            target: "channel",
            channelId,
            op: "method-result",
            callId,
            content: { handled: true },
          }],
        }),
      );

      const result = await service.handler(ctx, "callMethod", [
        "chan-1",
        "participant-abc",
        "doSomething",
        { foo: "bar" },
      ]);

      expect(result).toEqual({ handled: true });
      expect(mockFacade.callParticipantMethod).not.toHaveBeenCalled();
    });

    it("throws when caller harness has no DO registration", async () => {
      mockRouter.getDOForHarness.mockReturnValue(undefined);

      await expect(
        service.handler(ctx, "callMethod", ["chan-1", "p1", "run", null]),
      ).rejects.toThrow("Cannot resolve caller participant");
    });
  });

  describe("discoverMethods", () => {
    it("returns empty array when no participants have methods", async () => {
      pubsub.getChannelParticipants.mockReturnValue([
        { participantId: "p1", metadata: { name: "Alice" } },
      ]);

      const result = await service.handler(ctx, "discoverMethods", ["chan-1"]);
      expect(result).toEqual([]);
    });

    it("extracts methods from participant metadata", async () => {
      pubsub.getChannelParticipants.mockReturnValue([
        {
          participantId: "p1",
          metadata: {
            methods: [
              { name: "pause", description: "Pause the agent" },
              { name: "resume", description: "Resume the agent", parameters: { type: "object" } },
            ],
          },
        },
        { participantId: "p2", metadata: {} },
      ]);

      const result = await service.handler(ctx, "discoverMethods", ["chan-1"]) as Array<Record<string, unknown>>;
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ participantId: "p1", name: "pause", description: "Pause the agent" });
      expect(result[1]).toEqual({ participantId: "p1", name: "resume", description: "Resume the agent", parameters: { type: "object" } });
    });
  });

  describe("unknown method", () => {
    it("throws for an unknown method name", async () => {
      await expect(
        service.handler(ctx, "nonexistent", []),
      ).rejects.toThrow("Unknown channels method: nonexistent");
    });
  });
});

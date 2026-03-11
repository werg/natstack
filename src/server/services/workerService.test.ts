import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWorkerService } from "./workerService";
import type { WorkerRouter } from "../workerRouter";
import type { PubSubFacade, ParticipantEntry } from "./pubsubFacade";
import type { HarnessManager } from "../harnessManager";
import type { BuildSystemV2 } from "../buildV2/index";
import type { PackageGraph, GraphNode } from "../buildV2/packageGraph";
import type { ServiceDefinition } from "../../shared/serviceDefinition";

// ─── Mock helpers ────────────────────────────────────────────────────────────

function makeGraphNode(overrides: Partial<GraphNode>): GraphNode {
  return {
    path: "/workspace/workers/test",
    relativePath: "workers/test",
    name: "@workspace/test",
    kind: "worker",
    dependencies: {},
    internalDeps: [],
    internalDepRefs: {},
    manifest: { title: "Test Worker" },
    ...overrides,
  };
}

function createMockDeps() {
  const router = {
    dispatch: vi.fn(),
    unregisterHarness: vi.fn(),
  } as unknown as WorkerRouter & {
    dispatch: ReturnType<typeof vi.fn>;
    unregisterHarness: ReturnType<typeof vi.fn>;
  };

  const facade = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getAllEntries: vi.fn().mockReturnValue([]),
  } as unknown as PubSubFacade & {
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    getAllEntries: ReturnType<typeof vi.fn>;
  };

  const harnessManager = {
    stop: vi.fn(),
  } as unknown as HarnessManager & {
    stop: ReturnType<typeof vi.fn>;
  };

  const mockGraph = {
    allNodes: vi.fn().mockReturnValue([]),
  } as unknown as PackageGraph & {
    allNodes: ReturnType<typeof vi.fn>;
  };

  const buildSystem = {
    getGraph: vi.fn().mockReturnValue(mockGraph),
  } as unknown as BuildSystemV2 & {
    getGraph: ReturnType<typeof vi.fn>;
  };

  return { router, facade, harnessManager, buildSystem, mockGraph };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("workerService", () => {
  let service: ServiceDefinition;
  let router: ReturnType<typeof createMockDeps>["router"];
  let facade: ReturnType<typeof createMockDeps>["facade"];
  let harnessManager: ReturnType<typeof createMockDeps>["harnessManager"];
  let buildSystem: ReturnType<typeof createMockDeps>["buildSystem"];
  let mockGraph: ReturnType<typeof createMockDeps>["mockGraph"];

  const ctx = { callerId: "test", callerKind: "server" as const };

  beforeEach(() => {
    const deps = createMockDeps();
    router = deps.router;
    facade = deps.facade;
    harnessManager = deps.harnessManager;
    buildSystem = deps.buildSystem;
    mockGraph = deps.mockGraph;

    service = createWorkerService({ router, facade, harnessManager, buildSystem });
  });

  // ── listSources ──────────────────────────────────────────────────────────

  describe("listSources", () => {
    it("returns sources filtered to those with durable classes", async () => {
      const workerWithDurable = makeGraphNode({
        name: "@workspace/chat-do",
        relativePath: "workers/chat-do",
        manifest: {
          title: "Chat DO",
          durable: { classes: [{ name: "ChatDO" }] },
        } as GraphNode["manifest"],
      });

      const workerWithoutDurable = makeGraphNode({
        name: "@workspace/plain-worker",
        relativePath: "workers/plain-worker",
        manifest: { title: "Plain Worker" },
      });

      const panelNode = makeGraphNode({
        name: "@workspace/my-panel",
        kind: "panel",
        manifest: { title: "My Panel" },
      });

      const workerWithEmptyClasses = makeGraphNode({
        name: "@workspace/empty-do",
        manifest: {
          title: "Empty DO",
          durable: { classes: [] },
        } as GraphNode["manifest"],
      });

      mockGraph.allNodes.mockReturnValue([
        workerWithDurable,
        workerWithoutDurable,
        panelNode,
        workerWithEmptyClasses,
      ]);

      const result = await service.handler(ctx, "listSources", []);

      expect(result).toEqual([
        {
          name: "@workspace/chat-do",
          source: "workers/chat-do",
          title: "Chat DO",
          classes: [{ name: "ChatDO" }],
        },
      ]);
    });

    it("returns empty array when no workers have durable classes", async () => {
      mockGraph.allNodes.mockReturnValue([
        makeGraphNode({ manifest: { title: "Plain" } }),
      ]);

      const result = await service.handler(ctx, "listSources", []);
      expect(result).toEqual([]);
    });
  });

  // ── getChannelWorkers ────────────────────────────────────────────────────

  describe("getChannelWorkers", () => {
    it("returns registered DOs for a channel", async () => {
      const entries: Partial<ParticipantEntry>[] = [
        {
          participantId: "do:ChatDO:room-1:ch-1",
          className: "ChatDO",
          objectKey: "room-1",
          channelId: "ch-1",
        },
        {
          participantId: "do:StateDO:state-1:ch-1",
          className: "StateDO",
          objectKey: "state-1",
          channelId: "ch-1",
        },
        {
          participantId: "do:OtherDO:key-1:ch-2",
          className: "OtherDO",
          objectKey: "key-1",
          channelId: "ch-2",
        },
      ];

      facade.getAllEntries.mockReturnValue(entries);

      const result = await service.handler(ctx, "getChannelWorkers", ["ch-1"]);

      expect(result).toEqual([
        {
          participantId: "do:ChatDO:room-1:ch-1",
          className: "ChatDO",
          objectKey: "room-1",
          channelId: "ch-1",
        },
        {
          participantId: "do:StateDO:state-1:ch-1",
          className: "StateDO",
          objectKey: "state-1",
          channelId: "ch-1",
        },
      ]);
    });

    it("returns empty array when no DOs on the channel", async () => {
      facade.getAllEntries.mockReturnValue([]);

      const result = await service.handler(ctx, "getChannelWorkers", ["ch-99"]);
      expect(result).toEqual([]);
    });
  });

  // ── callDO (generic dispatch) ────────────────────────────────────────────

  describe("callDO", () => {
    it("dispatches to DO and returns actions", async () => {
      const actions = { actions: [{ target: "pubsub", op: "send" }] };
      router.dispatch.mockResolvedValue(actions);

      const result = await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "onMessage",
        "hello",
        42,
      ]);

      expect(router.dispatch).toHaveBeenCalledWith(
        "ChatDO",
        "room-1",
        "onMessage",
        "hello",
        42,
      );
      expect(result).toBe(actions);
    });

    it("propagates errors from dispatch", async () => {
      router.dispatch.mockRejectedValue(new Error("bridge down"));

      await expect(
        service.handler(ctx, "callDO", ["ChatDO", "room-1", "someMethod"]),
      ).rejects.toThrow("bridge down");
    });
  });

  // ── subscribeChannel flow ────────────────────────────────────────────────

  describe("callDO with subscribeChannel", () => {
    it("calls DO subscribeChannel, extracts descriptor, calls facade.subscribe", async () => {
      const descriptor = {
        handle: "chat-handle",
        name: "Chat Bot",
        type: "bot",
        metadata: { icon: "robot" },
      };

      // DO returns descriptor directly
      router.dispatch.mockResolvedValue(descriptor);

      const result = await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "subscribeChannel",
        "ch-1",
      ]);

      // Should dispatch with the structured arg
      expect(router.dispatch).toHaveBeenCalledWith(
        "ChatDO",
        "room-1",
        "subscribeChannel",
        { channelId: "ch-1", contextId: "ch-1", config: undefined },
      );

      // Should subscribe via facade
      expect(facade.subscribe).toHaveBeenCalledWith({
        channelId: "ch-1",
        participantId: "do:ChatDO:room-1:ch-1",
        className: "ChatDO",
        objectKey: "room-1",
        descriptor,
      });

      expect(result).toEqual({ ok: true, participantId: "do:ChatDO:room-1:ch-1" });
    });

    it("uses explicit contextId when provided", async () => {
      const descriptor = { handle: "h", name: "Bot", type: "bot" };
      router.dispatch.mockResolvedValue(descriptor);

      await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "subscribeChannel",
        "ch-1",
        "ctx-custom",
      ]);

      expect(router.dispatch).toHaveBeenCalledWith(
        "ChatDO",
        "room-1",
        "subscribeChannel",
        { channelId: "ch-1", contextId: "ctx-custom", config: undefined },
      );
    });

    it("passes config to the DO when provided", async () => {
      const descriptor = { handle: "h", name: "Bot", type: "bot" };
      router.dispatch.mockResolvedValue(descriptor);

      const config = { maxTokens: 1000 };
      await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "subscribeChannel",
        "ch-1",
        undefined,
        config,
      ]);

      expect(router.dispatch).toHaveBeenCalledWith(
        "ChatDO",
        "room-1",
        "subscribeChannel",
        { channelId: "ch-1", contextId: "ch-1", config },
      );
    });

    it("extracts descriptor from WorkerActions wrapper", async () => {
      const descriptor = { handle: "h", name: "Bot", type: "bot" };
      router.dispatch.mockResolvedValue({
        actions: [{ descriptor }],
      });

      const result = await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "subscribeChannel",
        "ch-1",
      ]);

      expect(facade.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ descriptor }),
      );
      expect(result).toEqual({ ok: true, participantId: "do:ChatDO:room-1:ch-1" });
    });

    it("extracts descriptor from nested descriptor key", async () => {
      const descriptor = { handle: "h", name: "Bot", type: "bot" };
      router.dispatch.mockResolvedValue({ descriptor });

      const result = await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "subscribeChannel",
        "ch-1",
      ]);

      expect(facade.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ descriptor }),
      );
      expect(result).toEqual({ ok: true, participantId: "do:ChatDO:room-1:ch-1" });
    });

    it("returns error when DO returns no descriptor", async () => {
      router.dispatch.mockResolvedValue({ someOtherData: true });

      const result = await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "subscribeChannel",
        "ch-1",
      ]);

      expect(result).toEqual({ ok: false, error: "No participant descriptor" });
      expect(facade.subscribe).not.toHaveBeenCalled();
    });

    it("returns error when DO returns null", async () => {
      router.dispatch.mockResolvedValue(null);

      const result = await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "subscribeChannel",
        "ch-1",
      ]);

      expect(result).toEqual({ ok: false, error: "No participant descriptor" });
    });
  });

  // ── unsubscribeChannel flow ──────────────────────────────────────────────

  describe("callDO with unsubscribeChannel", () => {
    it("calls DO unsubscribeChannel, stops harnesses, calls facade.unsubscribe", async () => {
      router.dispatch.mockResolvedValue({
        harnessIds: ["harness-1", "harness-2"],
      });

      const result = await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "unsubscribeChannel",
        "ch-1",
      ]);

      // Should dispatch to DO
      expect(router.dispatch).toHaveBeenCalledWith(
        "ChatDO",
        "room-1",
        "unsubscribeChannel",
        "ch-1",
      );

      // Should unsubscribe from facade
      expect(facade.unsubscribe).toHaveBeenCalledWith("do:ChatDO:room-1:ch-1");

      // Should unregister and stop each harness
      expect(router.unregisterHarness).toHaveBeenCalledWith("harness-1");
      expect(router.unregisterHarness).toHaveBeenCalledWith("harness-2");
      expect(harnessManager.stop).toHaveBeenCalledWith("harness-1");
      expect(harnessManager.stop).toHaveBeenCalledWith("harness-2");

      expect(result).toEqual({ ok: true });
    });

    it("unsubscribes even when DO returns no harnessIds", async () => {
      // Actions wrapper with no harnessIds — extractUnsubscribeResult returns { harnessIds: [] }
      router.dispatch.mockResolvedValue({ actions: [] });

      const result = await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "unsubscribeChannel",
        "ch-1",
      ]);

      expect(facade.unsubscribe).toHaveBeenCalledWith("do:ChatDO:room-1:ch-1");
      expect(harnessManager.stop).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });

    it("continues stopping other harnesses if one fails", async () => {
      router.dispatch.mockResolvedValue({
        harnessIds: ["harness-1", "harness-2"],
      });

      harnessManager.stop
        .mockRejectedValueOnce(new Error("process already dead"))
        .mockResolvedValueOnce(undefined);

      const result = await service.handler(ctx, "callDO", [
        "ChatDO",
        "room-1",
        "unsubscribeChannel",
        "ch-1",
      ]);

      // Both should still be attempted
      expect(harnessManager.stop).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ ok: true });
    });
  });

  // ── unknown method ────────────────────────────────────────────────────────

  describe("unknown method", () => {
    it("throws for unknown method", async () => {
      await expect(
        service.handler(ctx, "nonexistent", []),
      ).rejects.toThrow("Unknown workers method: nonexistent");
    });
  });
});

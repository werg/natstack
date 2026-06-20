import { describe, expect, it, vi } from "vitest";
import { createEventsServiceDefinition, EventService } from "./eventsService.js";
import { createVerifiedCaller, type CallerKind, type ServiceContext } from "./serviceDispatcher.js";
import type { PanelTreeSnapshot } from "./types.js";

const emptyPanelTreeSnapshot: PanelTreeSnapshot = { revision: 1, rootPanels: [] };

function makeWsClient(callerId: string, callerKind: CallerKind, connectionId: string) {
  const ws = {
    readyState: 1,
    send: vi.fn(),
    on: vi.fn(),
  };
  const caller = createVerifiedCaller(callerId, callerKind);
  return {
    ws,
    ctx: {
      caller,
      connectionId,
      wsClient: {
        ws,
        caller,
        connectionId,
        authenticated: true,
      },
    } satisfies ServiceContext,
  };
}

describe("EventService", () => {
  it("unsubscribeAll removes only the current connection's event subscriptions", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    const conn1 = makeWsClient("panel-one", "panel", "conn-1");
    const conn2 = makeWsClient("panel-one", "panel", "conn-2");

    await service.handler(conn1.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn2.ctx, "subscribe", ["panel-tree-updated"]);

    await service.handler(conn1.ctx, "unsubscribeAll", []);

    eventService.emit("panel-tree-updated", emptyPanelTreeSnapshot);

    expect(conn1.ws.send).not.toHaveBeenCalled();
    expect(conn2.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:panel-tree-updated",
        payload: emptyPanelTreeSnapshot,
      })
    );
  });

  it("unsubscribeAll does not remove direct-address reachability", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    const conn1 = makeWsClient("panel-one", "panel", "conn-1");
    const conn2 = makeWsClient("panel-one", "panel", "conn-2");

    await service.handler(conn1.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn2.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn1.ctx, "unsubscribeAll", []);

    const delivered = eventService.emitToCaller("panel-one", "focus-address-bar");

    expect(delivered).toBe(true);
    expect(conn1.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:focus-address-bar",
      })
    );
    expect(conn2.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:focus-address-bar",
      })
    );
  });

  it("can direct-address exactly one live connection", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    const conn1 = makeWsClient("panel-one", "panel", "conn-1");
    const conn2 = makeWsClient("panel-one", "panel", "conn-2");

    await service.handler(conn1.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn2.ctx, "subscribe", ["panel-tree-updated"]);

    const delivered = eventService.emitToConnection("panel-one", "conn-2", "focus-address-bar");

    expect(delivered).toBe(true);
    expect(conn1.ws.send).not.toHaveBeenCalled();
    expect(conn2.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:focus-address-bar",
      })
    );
  });

  it("sends a snapshot immediately when subscribing to a stateful event", async () => {
    const eventService = new EventService();
    const snapshot = {
      pending: [
        {
          kind: "capability" as const,
          approvalId: "approval-1",
          callerId: "panel-one",
          callerKind: "panel" as const,
          repoPath: "panels/test",
          effectiveVersion: "ev",
          requestedAt: 1,
          capability: "workspace-repo-write",
          title: "Write project files",
          resource: { type: "git-repo", label: "Repository", value: "panels/test" },
        },
      ],
    };
    const service = createEventsServiceDefinition(eventService, {
      snapshots: {
        "shell-approval:pending-changed": () => snapshot,
      },
    });
    const conn = makeWsClient("shell", "shell", "conn-1");

    await service.handler(conn.ctx, "subscribe", ["shell-approval:pending-changed"]);

    expect(conn.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "ws:event",
        event: "event:shell-approval:pending-changed",
        payload: snapshot,
      })
    );
  });

  // ── Server→DO event push (connectionless subscribers) ──────────────────────

  describe("DO push-subscriber", () => {
    const EVENT = "panel-tree-updated" as const;
    const doCtx = (callerId: string, connectionId = "c1"): ServiceContext => ({
      caller: createVerifiedCaller(callerId, "do"),
      connectionId,
    });

    it("mints a push-subscriber for a no-WS do caller and routes emit through it", async () => {
      const eventService = new EventService();
      const delivered: Array<[string, string, unknown]> = [];
      eventService.setDoPushDelivery(async (callerId, channel, payload) => {
        delivered.push([callerId, channel, payload]);
      });
      const service = createEventsServiceDefinition(eventService);

      await service.handler(doCtx("do:test:EvalDO:k1"), "subscribe", [EVENT]);
      eventService.emit(EVENT, emptyPanelTreeSnapshot);

      expect(delivered).toEqual([
        ["do:test:EvalDO:k1", "event:panel-tree-updated", emptyPanelTreeSnapshot],
      ]);
    });

    it("reaps the push-subscriber once the caller's last topic unsubscribes", async () => {
      const eventService = new EventService();
      const deliver = vi.fn(async () => {});
      eventService.setDoPushDelivery(deliver);
      const service = createEventsServiceDefinition(eventService);
      const ctx = doCtx("do:test:EvalDO:k2");

      await service.handler(ctx, "subscribe", [EVENT]);
      await service.handler(ctx, "unsubscribe", [EVENT]);
      eventService.emit(EVENT, emptyPanelTreeSnapshot);

      expect(deliver).not.toHaveBeenCalled();
    });

    it("reaps the push-subscriber on unsubscribeAll (idle EvalDO eviction path)", async () => {
      const eventService = new EventService();
      const deliver = vi.fn(async () => {});
      eventService.setDoPushDelivery(deliver);
      const service = createEventsServiceDefinition(eventService);
      const ctx = doCtx("do:test:EvalDO:k5");

      await service.handler(ctx, "subscribe", [EVENT]);
      await service.handler(ctx, "unsubscribeAll", []);
      eventService.emit(EVENT, emptyPanelTreeSnapshot);

      expect(deliver).not.toHaveBeenCalled();
    });

    it("self-reaps a push-subscriber whose delivery fails (hibernated/gone DO)", async () => {
      const eventService = new EventService();
      const deliver = vi.fn(async () => {
        throw new Error("DO unreachable");
      });
      eventService.setDoPushDelivery(deliver);
      const service = createEventsServiceDefinition(eventService);

      await service.handler(doCtx("do:test:EvalDO:k3"), "subscribe", [EVENT]);
      eventService.emit(EVENT, emptyPanelTreeSnapshot); // delivery rejects → subscriber destroyed
      await Promise.resolve();
      await Promise.resolve();
      eventService.emit(EVENT, emptyPanelTreeSnapshot); // gone — no second delivery

      expect(deliver).toHaveBeenCalledTimes(1);
    });

    it("still requires a WS or push delivery — bare do caller with no delivery wired throws", async () => {
      const eventService = new EventService(); // no setDoPushDelivery
      const service = createEventsServiceDefinition(eventService);

      await expect(
        service.handler(doCtx("do:test:EvalDO:k4"), "subscribe", [EVENT])
      ).rejects.toThrow(/WS connection or pre-registered subscriber/);
    });
  });
});

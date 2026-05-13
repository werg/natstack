import { describe, expect, it, vi } from "vitest";
import { createEventsServiceDefinition, EventService } from "./eventsService.js";
import type { CallerKind, ServiceContext } from "./serviceDispatcher.js";

function makeWsClient(callerId: string, callerKind: CallerKind, connectionId: string) {
  const ws = {
    readyState: 1,
    send: vi.fn(),
    on: vi.fn(),
  };
  return {
    ws,
    ctx: {
      callerId,
      callerKind,
      connectionId,
      wsClient: {
        ws,
        callerId,
        callerKind,
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
    const conn1 = makeWsClient("panel:one", "panel", "conn-1");
    const conn2 = makeWsClient("panel:one", "panel", "conn-2");

    await service.handler(conn1.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn2.ctx, "subscribe", ["panel-tree-updated"]);

    await service.handler(conn1.ctx, "unsubscribeAll", []);

    eventService.emit("panel-tree-updated", []);

    expect(conn1.ws.send).not.toHaveBeenCalled();
    expect(conn2.ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: "ws:event",
      event: "event:panel-tree-updated",
      payload: [],
    }));
  });

  it("unsubscribeAll does not remove direct-address reachability", async () => {
    const eventService = new EventService();
    const service = createEventsServiceDefinition(eventService);
    const conn1 = makeWsClient("panel:one", "panel", "conn-1");
    const conn2 = makeWsClient("panel:one", "panel", "conn-2");

    await service.handler(conn1.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn2.ctx, "subscribe", ["panel-tree-updated"]);
    await service.handler(conn1.ctx, "unsubscribeAll", []);

    const delivered = eventService.emitTo("panel:one", "focus-address-bar");

    expect(delivered).toBe(true);
    expect(conn1.ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: "ws:event",
      event: "event:focus-address-bar",
    }));
    expect(conn2.ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: "ws:event",
      event: "event:focus-address-bar",
    }));
  });
});

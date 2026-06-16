import { describe, expect, it, vi } from "vitest";
import type { EventService } from "@natstack/shared/eventsService";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";

describe("PanelRuntimeCoordinator", () => {
  function createCoordinator() {
    const eventService = { emit: vi.fn() };
    const closeConnection = vi.fn();
    const coordinator = new PanelRuntimeCoordinator({
      eventService: eventService as unknown as EventService,
    });
    coordinator.setCloseConnection(closeConnection);
    coordinator.registerClient({
      clientSessionId: "desktop-a",
      label: "Desktop A",
      platform: "desktop",
    });
    coordinator.registerClient({
      clientSessionId: "desktop-b",
      label: "Desktop B",
      platform: "desktop",
    });
    return { coordinator, eventService, closeConnection };
  }

  it("stores leases by runtime entity while exposing the owning slot", () => {
    const { coordinator } = createCoordinator();

    const result = coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    expect(result.acquired).toBe(true);
    expect(result.lease).toMatchObject({
      slotId: "slot-a",
      runtimeEntityId: "panel:nav-entity-a",
      clientSessionId: "desktop-a",
      hostConnectionId: "desktop-a",
      connectionId: "conn-a1",
      supportsCdp: true,
    });
    expect(coordinator.getLease("panel:nav-entity-a")?.slotId).toBe("slot-a");
    expect(coordinator.getSnapshot().leases).toMatchObject([
      {
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-entity-a",
      },
    ]);
  });

  it("stores a stable host connection id separately from the per-panel runtime connection", () => {
    const eventService = { emit: vi.fn() };
    const coordinator = new PanelRuntimeCoordinator({
      eventService: eventService as unknown as EventService,
    });
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      label: "Desktop",
      platform: "desktop",
    });

    const first = coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-session",
      connectionId: "runtime-conn-1",
    });
    const second = coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-session",
      connectionId: "runtime-conn-2",
    });

    expect(first.lease.hostConnectionId).toBe("desktop-host");
    expect(second.lease).toMatchObject({
      hostConnectionId: "desktop-host",
      connectionId: "runtime-conn-2",
    });
  });

  it("binds registered host connection ids to the registering shell caller when present", () => {
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      ownerCallerId: "shell:desktop",
      label: "Desktop",
      platform: "desktop",
    });

    expect(coordinator.hasClientHostConnection("desktop-host")).toBe(true);
    expect(coordinator.hasClientHostConnection("desktop-host", "shell:desktop")).toBe(true);
    expect(coordinator.hasClientHostConnection("desktop-host", "shell:other")).toBe(false);
  });

  it("records mobile clients as non-CDP-capable holders", () => {
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "mobile-session",
      hostConnectionId: "mobile-host",
      label: "Phone",
      platform: "mobile",
    });

    const result = coordinator.acquire("panel:mobile-held", {
      slotId: "slot-mobile",
      clientSessionId: "mobile-session",
      connectionId: "mobile-runtime-conn",
    });

    expect(result.lease).toMatchObject({
      hostConnectionId: "mobile-host",
      platform: "mobile",
      supportsCdp: false,
    });
    expect(coordinator.resolveHostForSlot("slot-mobile")).toEqual({
      hostConnectionId: "mobile-host",
      supportsCdp: false,
    });
  });

  it("resolves CDP host connection ids by visible panel slot", () => {
    const { coordinator } = createCoordinator();
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      label: "Desktop",
      platform: "desktop",
    });

    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-session",
      connectionId: "runtime-conn",
    });

    expect(coordinator.hasClientHostConnection("desktop-host")).toBe(true);
    expect(coordinator.resolveHostForSlot("slot-a")).toEqual({
      hostConnectionId: "desktop-host",
      supportsCdp: true,
    });
    expect(coordinator.resolveHostForSlot("slot-missing")).toBeNull();
  });

  it("resolves route targets from either runtime entity id or stable panel slot", () => {
    const { coordinator } = createCoordinator();

    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "runtime-conn",
    });

    expect(coordinator.resolveRouteConnection("panel:nav-entity-a")).toBe("runtime-conn");
    expect(coordinator.resolveRouteRuntimeEntityId("panel:nav-entity-a")).toBe(
      "panel:nav-entity-a"
    );
    expect(coordinator.resolveRouteConnection("slot-a")).toBe("runtime-conn");
    expect(coordinator.resolveRouteRuntimeEntityId("slot-a")).toBe("panel:nav-entity-a");
    expect(coordinator.resolveRouteConnection("slot-missing")).toBeNull();
    expect(coordinator.resolveRouteRuntimeEntityId("slot-missing")).toBeNull();
  });

  it("assigns unheld panels to a registered headless CDP host", () => {
    const eventService = { emit: vi.fn() };
    const coordinator = new PanelRuntimeCoordinator({
      eventService: eventService as unknown as EventService,
    });
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });

    const result = coordinator.ensureDefaultCdpHostForSlot("slot-a", "panel:nav-slot-a");

    expect(result).toMatchObject({
      assigned: true,
      lease: {
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-slot-a",
        clientSessionId: "headless-session",
        hostConnectionId: "headless-host",
        platform: "headless",
        loadOnLeaseAssignment: true,
        supportsCdp: true,
      },
    });
    expect(coordinator.resolveHostForSlot("slot-a")).toEqual({
      hostConnectionId: "headless-host",
      supportsCdp: true,
    });
  });

  it("does not assign unheld panels to headless clients that cannot load assigned leases", () => {
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
    });

    const result = coordinator.ensureDefaultCdpHostForSlot("slot-a", "panel:nav-slot-a", {
      isHostAvailable: () => true,
    });

    expect(result).toEqual({
      assigned: false,
      reason: "no_default_cdp_host",
    });
    expect(coordinator.resolveHostForSlot("slot-a")).toBeNull();
  });

  it("skips unavailable headless clients when assigning the default CDP host", () => {
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "headless-a",
      hostConnectionId: "headless-host-a",
      label: "Headless A",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });
    coordinator.registerClient({
      clientSessionId: "headless-b",
      hostConnectionId: "headless-host-b",
      label: "Headless B",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });

    const result = coordinator.ensureDefaultCdpHostForSlot("slot-a", "panel:nav-slot-a", {
      isHostAvailable: (hostConnectionId) => hostConnectionId === "headless-host-b",
    });

    expect(result).toMatchObject({
      assigned: true,
      lease: {
        clientSessionId: "headless-b",
        hostConnectionId: "headless-host-b",
      },
    });
  });

  it("does not assign a default CDP host when all headless providers are unavailable", () => {
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });

    const result = coordinator.ensureDefaultCdpHostForSlot("slot-a", "panel:nav-slot-a", {
      isHostAvailable: () => false,
    });

    expect(result).toEqual({
      assigned: false,
      reason: "no_default_cdp_host",
    });
    expect(coordinator.resolveHostForSlot("slot-a")).toBeNull();
  });

  it("falls released panel leases back to the registered headless CDP host", () => {
    const eventService = { emit: vi.fn() };
    const coordinator = new PanelRuntimeCoordinator({
      eventService: eventService as unknown as EventService,
    });
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      label: "Desktop",
      platform: "desktop",
    });
    coordinator.acquire("panel:nav-slot-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-session",
      connectionId: "desktop-runtime",
    });

    coordinator.release("panel:nav-slot-a", "desktop-runtime", "released");

    expect(coordinator.getLease("panel:nav-slot-a")).toMatchObject({
      slotId: "slot-a",
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      platform: "headless",
      loadOnLeaseAssignment: true,
      supportsCdp: true,
    });
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-slot-a",
        reason: "acquired",
        next: expect.objectContaining({ clientSessionId: "headless-session" }),
      })
    );
  });

  it("unregisters a host client, releases its leases, and falls back to headless", () => {
    const eventService = { emit: vi.fn() };
    const closeConnection = vi.fn();
    const coordinator = new PanelRuntimeCoordinator({
      eventService: eventService as unknown as EventService,
    });
    coordinator.setCloseConnection(closeConnection);
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      label: "Desktop",
      platform: "desktop",
    });
    coordinator.acquire("panel:nav-slot-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-session",
      connectionId: "desktop-runtime",
    });

    coordinator.unregisterClient("desktop-session");

    expect(coordinator.hasClientHostConnection("desktop-host")).toBe(false);
    expect(closeConnection).toHaveBeenCalledWith(
      "panel:nav-slot-a",
      "desktop-runtime",
      4095,
      "Panel runtime host unregistered"
    );
    expect(coordinator.getLease("panel:nav-slot-a")).toMatchObject({
      slotId: "slot-a",
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      platform: "headless",
      loadOnLeaseAssignment: true,
      supportsCdp: true,
    });
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-slot-a",
        reason: "acquired",
        next: expect.objectContaining({ clientSessionId: "headless-session" }),
      })
    );
  });

  it("unregisters a headless client without reassigning the lease to itself", () => {
    const closeConnection = vi.fn();
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.setCloseConnection(closeConnection);
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });
    coordinator.acquire("panel:nav-slot-a", {
      slotId: "slot-a",
      clientSessionId: "headless-session",
      connectionId: "headless-runtime",
    });

    coordinator.unregisterClient("headless-session");

    expect(coordinator.hasClientHostConnection("headless-host")).toBe(false);
    expect(coordinator.getLease("panel:nav-slot-a")).toBeNull();
    expect(closeConnection).toHaveBeenCalledWith(
      "panel:nav-slot-a",
      "headless-runtime",
      4095,
      "Panel runtime host unregistered"
    );
  });

  it("unloads a slot lease without assigning the default headless host", () => {
    const eventService = { emit: vi.fn() };
    const closeConnection = vi.fn();
    const coordinator = new PanelRuntimeCoordinator({
      eventService: eventService as unknown as EventService,
    });
    coordinator.setCloseConnection(closeConnection);
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });
    coordinator.acquire("panel:nav-slot-a", {
      slotId: "slot-a",
      clientSessionId: "headless-session",
      connectionId: "headless-runtime",
    });

    const previous = coordinator.unloadSlot("slot-a");

    expect(previous).toMatchObject({
      slotId: "slot-a",
      clientSessionId: "headless-session",
      connectionId: "headless-runtime",
    });
    expect(coordinator.resolveHostForSlot("slot-a")).toBeNull();
    expect(closeConnection).toHaveBeenCalledWith(
      "panel:nav-slot-a",
      "headless-runtime",
      4094,
      "Panel runtime unloaded"
    );
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-slot-a",
        reason: "released",
        next: null,
      })
    );
  });

  it("does not reassign panels held by a non-CDP host to the default host", () => {
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });
    coordinator.registerClient({
      clientSessionId: "mobile-session",
      hostConnectionId: "mobile-host",
      label: "Phone",
      platform: "mobile",
    });
    coordinator.acquire("panel:mobile", {
      slotId: "slot-mobile",
      clientSessionId: "mobile-session",
      connectionId: "mobile-conn",
    });

    expect(coordinator.ensureDefaultCdpHostForSlot("slot-mobile", "panel:mobile")).toMatchObject({
      assigned: false,
      reason: "mobile_held",
      lease: { hostConnectionId: "mobile-host", supportsCdp: false },
    });
  });

  it("lets the same client session reacquire on reconnect without takeover", () => {
    const { coordinator, closeConnection } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    const result = coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a2",
    });

    expect(result.acquired).toBe(true);
    expect(result.lease.connectionId).toBe("conn-a2");
    expect(closeConnection).not.toHaveBeenCalled();
  });

  it("does not grant a live runtime lease to a different client session", () => {
    const { coordinator } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    const result = coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-b",
      connectionId: "conn-b1",
    });

    expect(result.acquired).toBe(false);
    expect(result.lease.clientSessionId).toBe("desktop-a");
    expect(result.lease.connectionId).toBe("conn-a1");
  });

  it("emits slot and runtime entity ids separately on takeover", () => {
    const { coordinator, eventService, closeConnection } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    const result = coordinator.takeOver("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-b",
      connectionId: "conn-b1",
    });

    expect(result.acquired).toBe(true);
    expect(closeConnection).toHaveBeenCalledWith(
      "panel:nav-entity-a",
      "conn-a1",
      4091,
      "Panel runtime lease revoked"
    );
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-entity-a",
        reason: "acquired",
        next: expect.objectContaining({ clientSessionId: "desktop-b" }),
      })
    );
  });

  it("closes and releases runtime leases when the entity is retired", () => {
    const { coordinator, eventService, closeConnection } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    coordinator.retireRuntimeEntity("panel:nav-entity-a");

    expect(coordinator.getLease("panel:nav-entity-a")).toBeNull();
    expect(closeConnection).toHaveBeenCalledWith(
      "panel:nav-entity-a",
      "conn-a1",
      4093,
      "Panel runtime entity retired"
    );
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "slot-a",
        runtimeEntityId: "panel:nav-entity-a",
        reason: "retired",
        next: null,
      })
    );
  });
});

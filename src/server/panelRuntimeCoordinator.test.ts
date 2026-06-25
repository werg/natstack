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
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    expect(result.acquired).toBe(true);
    expect(result.lease).toMatchObject({
      slotId: "panel:tree/slot-a",
      runtimeEntityId: "panel:nav-entity-a",
      clientSessionId: "desktop-a",
      hostConnectionId: "desktop-a",
      connectionId: "conn-a1",
      supportsCdp: true,
    });
    expect(coordinator.getLease("panel:nav-entity-a")?.slotId).toBe("panel:tree/slot-a");
    expect(coordinator.getSnapshot().leases).toMatchObject([
      {
        slotId: "panel:tree/slot-a",
        runtimeEntityId: "panel:nav-entity-a",
      },
    ]);
  });

  it("treats non-panel ids as having no panel lease in routing (does not throw)", () => {
    // RPC routing probes EVERY target id here — including worker/DO ids. A non-panel id has no panel
    // lease, so route resolution must return null, NOT throw on the (now-validating) id casts.
    // Regression for the real production crash where resolveRouteLease laundered a `do:…` id.
    const { coordinator } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    // Non-panel targets: graceful null, never a throw.
    expect(coordinator.getLease("do:workers/x:Worker:k")).toBeNull();
    expect(coordinator.resolveRouteLease("do:workers/x:Worker:k")).toBeNull();
    expect(coordinator.resolveRouteRuntimeEntityId("worker:src:w")).toBeNull();

    // Panel targets still resolve — by entity (nav) id AND by slot id.
    expect(coordinator.resolveRouteLease("panel:nav-entity-a")?.slotId).toBe("panel:tree/slot-a");
    expect(coordinator.resolveRouteLease("panel:tree/slot-a")?.runtimeEntityId).toBe(
      "panel:nav-entity-a"
    );
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
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-session",
      connectionId: "runtime-conn-1",
    });
    const second = coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
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

    const result = coordinator.acquire("panel:nav-mobile-held", {
      slotId: "panel:tree/slot-mobile",
      clientSessionId: "mobile-session",
      connectionId: "mobile-runtime-conn",
    });

    expect(result.lease).toMatchObject({
      hostConnectionId: "mobile-host",
      platform: "mobile",
      supportsCdp: false,
    });
    expect(coordinator.resolveHostForSlot("panel:tree/slot-mobile")).toEqual({
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
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-session",
      connectionId: "runtime-conn",
    });

    expect(coordinator.hasClientHostConnection("desktop-host")).toBe(true);
    expect(coordinator.resolveHostForSlot("panel:tree/slot-a")).toEqual({
      hostConnectionId: "desktop-host",
      supportsCdp: true,
    });
    expect(coordinator.resolveHostForSlot("panel:tree/slot-missing")).toBeNull();
  });

  it("resolves route targets from either runtime entity id or stable panel slot", () => {
    const { coordinator } = createCoordinator();

    coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-a",
      connectionId: "runtime-conn",
    });

    expect(coordinator.resolveRouteConnection("panel:nav-entity-a")).toBe("runtime-conn");
    expect(coordinator.resolveRouteRuntimeEntityId("panel:nav-entity-a")).toBe(
      "panel:nav-entity-a"
    );
    expect(coordinator.resolveRouteConnection("panel:tree/slot-a")).toBe("runtime-conn");
    expect(coordinator.resolveRouteRuntimeEntityId("panel:tree/slot-a")).toBe("panel:nav-entity-a");
    expect(coordinator.resolveRouteConnection("panel:tree/slot-missing")).toBeNull();
    expect(coordinator.resolveRouteRuntimeEntityId("panel:tree/slot-missing")).toBeNull();
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

    const result = coordinator.ensureDefaultCdpHostForSlot("panel:tree/slot-a", "panel:nav-slot-a");

    expect(result).toMatchObject({
      assigned: true,
      lease: {
        slotId: "panel:tree/slot-a",
        runtimeEntityId: "panel:nav-slot-a",
        clientSessionId: "headless-session",
        hostConnectionId: "headless-host",
        platform: "headless",
        loadOnLeaseAssignment: true,
        supportsCdp: true,
      },
    });
    expect(coordinator.resolveHostForSlot("panel:tree/slot-a")).toEqual({
      hostConnectionId: "headless-host",
      supportsCdp: true,
    });
  });

  it("prefers the headless host for a programmatic panel even when a desktop host is also a load-on-assignment default", () => {
    // Production config: BOTH desktop and headless register with
    // loadOnLeaseAssignment: true (src/main/index.ts). A programmatic panel
    // (agent/eval/worker — no UI host) reaches host selection via
    // ensureDefaultCdpHostForSlot with no existing lease, and MUST land on the
    // headless host. Page.captureScreenshot hangs on an unpainted panel on the
    // headed desktop host, so desktop-first selection is the 6ab6c7ca regression.
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      label: "Desktop",
      platform: "desktop",
      loadOnLeaseAssignment: true,
    });
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });

    const result = coordinator.ensureDefaultCdpHostForSlot(
      "panel:tree/slot-prog",
      "panel:nav-slot-prog",
      { isHostAvailable: () => true }
    );

    expect(result).toMatchObject({
      assigned: true,
      lease: {
        clientSessionId: "headless-session",
        hostConnectionId: "headless-host",
        platform: "headless",
      },
    });
  });

  it("falls back to the desktop host for a programmatic panel when no headless host is available", () => {
    // Graceful degrade: with only a load-on-assignment desktop host reachable,
    // a programmatic panel still renders on desktop rather than failing.
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      label: "Desktop",
      platform: "desktop",
      loadOnLeaseAssignment: true,
    });

    const result = coordinator.ensureDefaultCdpHostForSlot(
      "panel:tree/slot-prog",
      "panel:nav-slot-prog",
      { isHostAvailable: () => true }
    );

    expect(result).toMatchObject({
      assigned: true,
      lease: {
        clientSessionId: "desktop-session",
        hostConnectionId: "desktop-host",
        platform: "desktop",
      },
    });
  });

  it("keeps a UI-launched panel on its desktop host (self-acquire short-circuits default selection)", () => {
    // A UI panel is loaded by the desktop orchestrator's own acquire() before
    // any default selection runs. ensureDefaultCdpHostForSlot must then report
    // already_held and leave the lease on desktop — it must NOT re-home the
    // panel to the headless host. This is how UI panels keep reaching desktop.
    const coordinator = new PanelRuntimeCoordinator();
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      label: "Desktop",
      platform: "desktop",
      loadOnLeaseAssignment: true,
    });
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });

    // Desktop host self-acquires when it shows the panel in the UI.
    coordinator.acquire("panel:nav-ui", {
      slotId: "panel:tree/slot-ui",
      clientSessionId: "desktop-session",
      connectionId: "desktop-runtime",
    });

    const result = coordinator.ensureDefaultCdpHostForSlot("panel:tree/slot-ui", "panel:nav-ui", {
      isHostAvailable: () => true,
    });

    expect(result).toMatchObject({ assigned: false, reason: "already_held" });
    expect(coordinator.resolveHostForSlot("panel:tree/slot-ui")).toEqual({
      hostConnectionId: "desktop-host",
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

    const result = coordinator.ensureDefaultCdpHostForSlot(
      "panel:tree/slot-a",
      "panel:nav-slot-a",
      {
        isHostAvailable: () => true,
      }
    );

    expect(result).toEqual({
      assigned: false,
      reason: "no_default_cdp_host",
    });
    expect(coordinator.resolveHostForSlot("panel:tree/slot-a")).toBeNull();
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

    const result = coordinator.ensureDefaultCdpHostForSlot(
      "panel:tree/slot-a",
      "panel:nav-slot-a",
      {
        isHostAvailable: (hostConnectionId) => hostConnectionId === "headless-host-b",
      }
    );

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

    const result = coordinator.ensureDefaultCdpHostForSlot(
      "panel:tree/slot-a",
      "panel:nav-slot-a",
      {
        isHostAvailable: () => false,
      }
    );

    expect(result).toEqual({
      assigned: false,
      reason: "no_default_cdp_host",
    });
    expect(coordinator.resolveHostForSlot("panel:tree/slot-a")).toBeNull();
  });

  it("does not fall a released desktop UI lease back to the headless CDP host", () => {
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
      loadOnLeaseAssignment: true,
    });
    coordinator.acquire("panel:nav-slot-a", {
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-session",
      connectionId: "desktop-runtime",
    });

    coordinator.release("panel:nav-slot-a", "desktop-runtime", "released");

    expect(coordinator.getLease("panel:nav-slot-a")).toBeNull();
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "panel:tree/slot-a",
        runtimeEntityId: "panel:nav-slot-a",
        reason: "released",
        next: null,
      })
    );
  });

  it("falls released default CDP desktop leases back to the registered headless CDP host", () => {
    const eventService = { emit: vi.fn() };
    const coordinator = new PanelRuntimeCoordinator({
      eventService: eventService as unknown as EventService,
    });
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      label: "Desktop",
      platform: "desktop",
      loadOnLeaseAssignment: true,
    });

    const defaultDesktop = coordinator.ensureDefaultCdpHostForSlot(
      "panel:tree/slot-a",
      "panel:nav-slot-a"
    );
    expect(defaultDesktop).toMatchObject({
      assigned: true,
      lease: { clientSessionId: "desktop-session", platform: "desktop" },
    });
    if (!defaultDesktop.assigned) throw new Error("expected default desktop lease assignment");

    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });
    coordinator.release("panel:nav-slot-a", defaultDesktop.lease.connectionId, "released");

    expect(coordinator.getLease("panel:nav-slot-a")).toMatchObject({
      slotId: "panel:tree/slot-a",
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      platform: "headless",
      loadOnLeaseAssignment: true,
      supportsCdp: true,
    });
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "panel:tree/slot-a",
        runtimeEntityId: "panel:nav-slot-a",
        reason: "acquired",
        next: expect.objectContaining({ clientSessionId: "headless-session" }),
      })
    );
  });

  it("does not fall an expired desktop UI lease back to the headless CDP host", () => {
    vi.useFakeTimers();
    try {
      const coordinator = new PanelRuntimeCoordinator();
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
        loadOnLeaseAssignment: true,
      });
      coordinator.acquire("panel:nav-slot-a", {
        slotId: "panel:tree/slot-a",
        clientSessionId: "desktop-session",
        connectionId: "desktop-runtime",
      });

      coordinator.markDisconnected("panel:nav-slot-a", "desktop-runtime");
      vi.advanceTimersByTime(3000);

      expect(coordinator.getLease("panel:nav-slot-a")).toBeNull();
      expect(coordinator.resolveHostForSlot("panel:tree/slot-a")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unregisters a UI host client and releases its leases without falling back to headless", () => {
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
      loadOnLeaseAssignment: true,
    });
    coordinator.acquire("panel:nav-slot-a", {
      slotId: "panel:tree/slot-a",
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
    expect(coordinator.getLease("panel:nav-slot-a")).toBeNull();
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "panel:tree/slot-a",
        runtimeEntityId: "panel:nav-slot-a",
        reason: "released",
        next: null,
      })
    );
  });

  it("unregisters a default CDP desktop host lease and falls back to headless", () => {
    const eventService = { emit: vi.fn() };
    const closeConnection = vi.fn();
    const coordinator = new PanelRuntimeCoordinator({
      eventService: eventService as unknown as EventService,
    });
    coordinator.setCloseConnection(closeConnection);
    coordinator.registerClient({
      clientSessionId: "desktop-session",
      hostConnectionId: "desktop-host",
      label: "Desktop",
      platform: "desktop",
      loadOnLeaseAssignment: true,
    });
    const defaultDesktop = coordinator.ensureDefaultCdpHostForSlot(
      "panel:tree/slot-a",
      "panel:nav-slot-a"
    );
    expect(defaultDesktop).toMatchObject({
      assigned: true,
      lease: { clientSessionId: "desktop-session", platform: "desktop" },
    });
    if (!defaultDesktop.assigned) throw new Error("expected default desktop lease assignment");
    coordinator.registerClient({
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });

    coordinator.unregisterClient("desktop-session");

    expect(closeConnection).toHaveBeenCalledWith(
      "panel:nav-slot-a",
      defaultDesktop.lease.connectionId,
      4095,
      "Panel runtime host unregistered"
    );
    expect(coordinator.getLease("panel:nav-slot-a")).toMatchObject({
      slotId: "panel:tree/slot-a",
      clientSessionId: "headless-session",
      hostConnectionId: "headless-host",
      platform: "headless",
      loadOnLeaseAssignment: true,
      supportsCdp: true,
    });
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "panel:tree/slot-a",
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
      slotId: "panel:tree/slot-a",
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
      slotId: "panel:tree/slot-a",
      clientSessionId: "headless-session",
      connectionId: "headless-runtime",
    });

    const previous = coordinator.unloadSlot("panel:tree/slot-a");

    expect(previous).toMatchObject({
      slotId: "panel:tree/slot-a",
      clientSessionId: "headless-session",
      connectionId: "headless-runtime",
    });
    expect(coordinator.resolveHostForSlot("panel:tree/slot-a")).toBeNull();
    expect(closeConnection).toHaveBeenCalledWith(
      "panel:nav-slot-a",
      "headless-runtime",
      4094,
      "Panel runtime unloaded"
    );
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "panel:tree/slot-a",
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
    coordinator.acquire("panel:nav-mobile", {
      slotId: "panel:tree/slot-mobile",
      clientSessionId: "mobile-session",
      connectionId: "mobile-conn",
    });

    expect(
      coordinator.ensureDefaultCdpHostForSlot("panel:tree/slot-mobile", "panel:nav-mobile")
    ).toMatchObject({
      assigned: false,
      reason: "mobile_held",
      lease: { hostConnectionId: "mobile-host", supportsCdp: false },
    });
  });

  it("lets the same client session reacquire on reconnect without takeover", () => {
    const { coordinator, closeConnection } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    const result = coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
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
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    const result = coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
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
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    const result = coordinator.takeOver("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
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
        slotId: "panel:tree/slot-a",
        runtimeEntityId: "panel:nav-entity-a",
        reason: "acquired",
        next: expect.objectContaining({ clientSessionId: "desktop-b" }),
      })
    );
  });

  it("stamps keepLoaded and refuses release/unload while a slot is pinned", () => {
    const { coordinator, eventService, closeConnection } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    // Pin (first CDP client connects) re-stamps the live lease with keepLoaded.
    coordinator.pinSlotLoaded("panel:tree/slot-a");
    expect(coordinator.getLease("panel:nav-entity-a")?.keepLoaded).toBe(true);
    expect(coordinator.getSnapshot().leases[0]?.keepLoaded).toBe(true);
    expect(eventService.emit).toHaveBeenLastCalledWith(
      "panel:runtimeLeaseChanged",
      expect.objectContaining({
        slotId: "panel:tree/slot-a",
        reason: "acquired",
        next: expect.objectContaining({ keepLoaded: true }),
      })
    );

    // While pinned, release and unload are refused: the lease stays in the snapshot.
    coordinator.release("panel:nav-entity-a", "conn-a1", "released");
    expect(coordinator.getLease("panel:nav-entity-a")?.keepLoaded).toBe(true);
    expect(coordinator.unloadSlot("panel:tree/slot-a")).toBeNull();
    expect(coordinator.getLease("panel:nav-entity-a")).not.toBeNull();
    expect(closeConnection).not.toHaveBeenCalled();
  });

  it("resumes normal unload after the pin is released", () => {
    const { coordinator } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });
    coordinator.pinSlotLoaded("panel:tree/slot-a");

    // Last CDP client disconnects → unpin clears keepLoaded and re-enables unload.
    coordinator.unpinSlotLoaded("panel:tree/slot-a");
    expect(coordinator.getLease("panel:nav-entity-a")?.keepLoaded).toBe(false);

    expect(coordinator.unloadSlot("panel:tree/slot-a")).toMatchObject({
      slotId: "panel:tree/slot-a",
    });
    expect(coordinator.getLease("panel:nav-entity-a")).toBeNull();
  });

  it("stamps keepLoaded on leases acquired while the slot is already pinned", () => {
    const { coordinator } = createCoordinator();
    coordinator.pinSlotLoaded("panel:tree/slot-a");

    const result = coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
      clientSessionId: "desktop-a",
      connectionId: "conn-a1",
    });

    expect(result.lease.keepLoaded).toBe(true);
  });

  it("closes and releases runtime leases when the entity is retired", () => {
    const { coordinator, eventService, closeConnection } = createCoordinator();
    coordinator.acquire("panel:nav-entity-a", {
      slotId: "panel:tree/slot-a",
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
        slotId: "panel:tree/slot-a",
        runtimeEntityId: "panel:nav-entity-a",
        reason: "retired",
        next: null,
      })
    );
  });
});

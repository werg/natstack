import { describe, expect, it } from "vitest";
import type {
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
} from "@natstack/shared/panel/panelLease";
import { LeaseTracker } from "./leaseTracker.js";

const ME = "headless-test";

function lease(slotId: string, overrides: Partial<PanelRuntimeLease> = {}): PanelRuntimeLease {
  return {
    slotId,
    runtimeEntityId: `panel:${slotId}-entry`,
    clientSessionId: ME,
    hostConnectionId: ME,
    connectionId: `default-cdp-${slotId}-1`,
    holderLabel: "Headless",
    platform: "headless",
    supportsCdp: true,
    loadOnLeaseAssignment: true,
    acquiredAt: 1,
    ...overrides,
  } as PanelRuntimeLease;
}

function snapshot(leases: PanelRuntimeLease[], counter = 1): RuntimeLeaseSnapshot {
  return { version: { epoch: "e1", counter }, leases };
}

function event(
  slotId: string,
  next: PanelRuntimeLease | null,
  previous: PanelRuntimeLease | null,
  counter: number
): PanelRuntimeLeaseChangedEvent {
  return {
    type: "panel:runtimeLeaseChanged",
    version: { epoch: "e1", counter },
    slotId,
    runtimeEntityId: (next ?? previous)!.runtimeEntityId,
    previous,
    next,
    reason: next ? "acquired" : "released",
  } as PanelRuntimeLeaseChangedEvent;
}

describe("LeaseTracker", () => {
  it("reconciles a snapshot into load intents for own leases only", () => {
    const tracker = new LeaseTracker(ME);
    const intents = tracker.reconcile(
      snapshot([lease("a"), lease("b", { clientSessionId: "someone-else" })])
    );
    expect(intents).toEqual([
      { kind: "load", slotId: "a", runtimeEntityId: "panel:a-entry", connectionId: "default-cdp-a-1" },
    ]);
    expect(tracker.heldSlots()).toEqual(["a"]);
  });

  it("unloads leases that vanish from a later snapshot", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease("a")]));
    const intents = tracker.reconcile(snapshot([], 2));
    expect(intents).toEqual([{ kind: "unload", slotId: "a", reason: "lease-transfer" }]);
  });

  it("treats a connectionId change as unload + reload", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease("a")]));
    const intents = tracker.reconcile(
      snapshot([lease("a", { connectionId: "default-cdp-a-2" })], 2)
    );
    expect(intents).toEqual([
      { kind: "unload", slotId: "a", reason: "stale" },
      { kind: "load", slotId: "a", runtimeEntityId: "panel:a-entry", connectionId: "default-cdp-a-2" },
    ]);
  });

  it("applies acquire/transfer/release events", () => {
    const tracker = new LeaseTracker(ME);
    expect(tracker.apply(event("a", lease("a"), null, 1))).toEqual([
      { kind: "load", slotId: "a", runtimeEntityId: "panel:a-entry", connectionId: "default-cdp-a-1" },
    ]);
    // Transfer to another client.
    expect(
      tracker.apply(event("a", lease("a", { clientSessionId: "desktop-1" }), lease("a"), 2))
    ).toEqual([{ kind: "unload", slotId: "a", reason: "lease-transfer" }]);
    // Release of a lease we don't hold is a no-op.
    expect(tracker.apply(event("a", null, lease("a", { clientSessionId: "desktop-1" }), 3))).toEqual(
      []
    );
  });

  it("drops stale events older than the reconciled version", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease("a")], 10));
    expect(tracker.apply(event("a", null, lease("a"), 5))).toEqual([]);
    expect(tracker.heldSlots()).toEqual(["a"]);
  });

  it("accepts events from a new epoch regardless of counter", () => {
    const tracker = new LeaseTracker(ME);
    tracker.reconcile(snapshot([lease("a")], 10));
    const fresh = {
      ...event("a", null, lease("a"), 1),
      version: { epoch: "e2", counter: 1 },
    };
    expect(tracker.apply(fresh)).toEqual([{ kind: "unload", slotId: "a", reason: "released" }]);
  });

  it("ignores duplicate acquires for the same connectionId", () => {
    const tracker = new LeaseTracker(ME);
    tracker.apply(event("a", lease("a"), null, 1));
    expect(tracker.apply(event("a", lease("a"), null, 2))).toEqual([]);
  });
});

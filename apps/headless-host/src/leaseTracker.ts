/**
 * Pure lease state machine: turns runtime-lease snapshots and change events
 * into load/unload intents for this host. Version-guarded so stale buffered
 * events (delivered after a fresher snapshot reconcile) are ignored.
 *
 * A lease connectionId change for the same slot means the server re-issued
 * the lease (e.g. expiry + default re-assignment): the page must be reloaded
 * with the new connectionId, expressed as unload + load.
 */
import type {
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
  RuntimeLeaseVersion,
} from "@natstack/shared/panel/panelLease";

export type LeaseIntent =
  | { kind: "load"; slotId: string; runtimeEntityId: string; connectionId: string }
  | { kind: "unload"; slotId: string; reason: "lease-transfer" | "released" | "stale" };

interface HeldLease {
  runtimeEntityId: string;
  connectionId: string;
}

function versionNewer(a: RuntimeLeaseVersion, b: RuntimeLeaseVersion | null): boolean {
  if (!b) return true;
  if (a.epoch !== b.epoch) return true; // new epoch: always treat as fresh
  return a.counter > b.counter;
}

export class LeaseTracker {
  private readonly held = new Map<string, HeldLease>();
  private version: RuntimeLeaseVersion | null = null;

  constructor(private readonly clientSessionId: string) {}

  heldSlots(): string[] {
    return [...this.held.keys()];
  }

  heldLease(slotId: string): HeldLease | undefined {
    return this.held.get(slotId);
  }

  /** Full-state reconcile against a snapshot. Returns intents to converge. */
  reconcile(snapshot: RuntimeLeaseSnapshot): LeaseIntent[] {
    this.version = snapshot.version;
    const intents: LeaseIntent[] = [];
    const mine = new Map<string, PanelRuntimeLease>();
    for (const lease of snapshot.leases) {
      if (lease.clientSessionId === this.clientSessionId) mine.set(lease.slotId, lease);
    }
    for (const [slotId, current] of this.held) {
      const next = mine.get(slotId);
      if (!next) {
        this.held.delete(slotId);
        intents.push({ kind: "unload", slotId, reason: "lease-transfer" });
      } else if (next.connectionId !== current.connectionId) {
        this.held.set(slotId, {
          runtimeEntityId: next.runtimeEntityId,
          connectionId: next.connectionId,
        });
        intents.push({ kind: "unload", slotId, reason: "stale" });
        intents.push({
          kind: "load",
          slotId,
          runtimeEntityId: next.runtimeEntityId,
          connectionId: next.connectionId,
        });
      }
    }
    for (const [slotId, lease] of mine) {
      if (!this.held.has(slotId)) {
        this.held.set(slotId, {
          runtimeEntityId: lease.runtimeEntityId,
          connectionId: lease.connectionId,
        });
        intents.push({
          kind: "load",
          slotId,
          runtimeEntityId: lease.runtimeEntityId,
          connectionId: lease.connectionId,
        });
      }
    }
    return intents;
  }

  /** Apply a single lease-changed event. */
  apply(event: PanelRuntimeLeaseChangedEvent): LeaseIntent[] {
    if (!versionNewer(event.version, this.version)) return [];
    this.version = event.version;
    const slotId = event.slotId as string;
    const current = this.held.get(slotId);
    const next = event.next;

    if (next && next.clientSessionId === this.clientSessionId) {
      if (!current) {
        this.held.set(slotId, {
          runtimeEntityId: next.runtimeEntityId,
          connectionId: next.connectionId,
        });
        return [
          {
            kind: "load",
            slotId,
            runtimeEntityId: next.runtimeEntityId,
            connectionId: next.connectionId,
          },
        ];
      }
      if (current.connectionId !== next.connectionId) {
        this.held.set(slotId, {
          runtimeEntityId: next.runtimeEntityId,
          connectionId: next.connectionId,
        });
        return [
          { kind: "unload", slotId, reason: "stale" },
          {
            kind: "load",
            slotId,
            runtimeEntityId: next.runtimeEntityId,
            connectionId: next.connectionId,
          },
        ];
      }
      return [];
    }

    // Lease gone or moved to another client.
    if (current) {
      this.held.delete(slotId);
      return [
        {
          kind: "unload",
          slotId,
          reason: next ? "lease-transfer" : "released",
        },
      ];
    }
    return [];
  }

  /** Forget a slot locally (e.g. after we released the lease ourselves). */
  drop(slotId: string): void {
    this.held.delete(slotId);
  }
}

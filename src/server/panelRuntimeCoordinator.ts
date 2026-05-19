import { randomUUID } from "crypto";
import type { EventService } from "@natstack/shared/eventsService";
import type {
  ClientSession,
  PanelRuntimeAcquireResult,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedReason,
  RuntimeLeaseSnapshot,
  RuntimeLeaseVersion,
} from "@natstack/shared/panel/panelLease";

const LEASE_RECONNECT_GRACE_MS = 3000;

export type RuntimeLeaseClose = (
  panelId: string,
  connectionId: string,
  code: number,
  reason: string
) => void;

export class PanelRuntimeCoordinator {
  private readonly epoch = randomUUID();
  private counter = 0;
  private leases = new Map<string, PanelRuntimeLease>();
  private clients = new Map<string, ClientSession>();
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closeConnection: RuntimeLeaseClose | null = null;

  constructor(private readonly deps: { eventService?: EventService } = {}) {}

  setCloseConnection(fn: RuntimeLeaseClose): void {
    this.closeConnection = fn;
  }

  registerClient(input: {
    clientSessionId: string;
    label: string;
    platform: "desktop" | "mobile";
  }): void {
    const now = Date.now();
    const existing = this.clients.get(input.clientSessionId);
    this.clients.set(input.clientSessionId, {
      clientSessionId: input.clientSessionId,
      label: input.label,
      platform: input.platform,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
    });
  }

  getSnapshot(): RuntimeLeaseSnapshot {
    return {
      version: this.currentVersion(),
      leases: [...this.leases.values()],
    };
  }

  getLease(panelId: string): PanelRuntimeLease | null {
    return this.leases.get(panelId) ?? null;
  }

  acquire(
    panelId: string,
    input: { clientSessionId: string; connectionId: string }
  ): PanelRuntimeAcquireResult {
    const existing = this.leases.get(panelId);
    if (existing && existing.connectionId !== input.connectionId) {
      return { acquired: false, lease: existing };
    }
    return { acquired: true, lease: this.writeLease(panelId, input, "acquired") };
  }

  takeOver(
    panelId: string,
    input: { clientSessionId: string; connectionId: string }
  ): PanelRuntimeAcquireResult {
    const existing = this.leases.get(panelId);
    if (existing && existing.connectionId !== input.connectionId) {
      this.closeConnection?.(panelId, existing.connectionId, 4091, "Panel runtime lease revoked");
      this.emitChange(panelId, existing, null, "revoked");
    }
    return { acquired: true, lease: this.writeLease(panelId, input, "acquired") };
  }

  release(
    panelId: string,
    connectionId: string,
    reason: PanelRuntimeLeaseChangedReason = "released"
  ): void {
    const existing = this.leases.get(panelId);
    if (!existing || existing.connectionId !== connectionId) return;
    this.clearExpiry(panelId);
    this.leases.delete(panelId);
    this.emitChange(panelId, existing, null, reason);
  }

  authorizePanelConnection(
    panelId: string,
    connectionId: string
  ): { ok: true } | { ok: false; reason: string } {
    const lease = this.leases.get(panelId);
    if (!lease) return { ok: false, reason: "Panel runtime has no active lease" };
    if (lease.connectionId !== connectionId) {
      return { ok: false, reason: `Panel runtime is leased by ${lease.holderLabel}` };
    }
    return { ok: true };
  }

  markConnected(panelId: string, connectionId: string): void {
    const lease = this.leases.get(panelId);
    if (!lease || lease.connectionId !== connectionId) return;
    this.clearExpiry(panelId);
    if (lease.expiresAt !== undefined) {
      const next = { ...lease };
      delete next.expiresAt;
      this.leases.set(panelId, next);
      this.emitChange(panelId, lease, next, "acquired");
    }
  }

  markDisconnected(panelId: string, connectionId: string): void {
    const lease = this.leases.get(panelId);
    if (!lease || lease.connectionId !== connectionId) return;
    this.clearExpiry(panelId);
    const expiresAt = Date.now() + LEASE_RECONNECT_GRACE_MS;
    const next = { ...lease, expiresAt };
    this.leases.set(panelId, next);
    this.emitChange(panelId, lease, next, "released");
    this.expiryTimers.set(
      panelId,
      setTimeout(() => {
        this.release(panelId, connectionId, "expired");
      }, LEASE_RECONNECT_GRACE_MS)
    );
  }

  resolveRouteConnection(panelId: string): string | null {
    return this.leases.get(panelId)?.connectionId ?? null;
  }

  private writeLease(
    panelId: string,
    input: { clientSessionId: string; connectionId: string },
    reason: PanelRuntimeLeaseChangedReason
  ): PanelRuntimeLease {
    const client = this.clients.get(input.clientSessionId);
    if (!client) {
      throw new Error(`Unknown runtime client session: ${input.clientSessionId}`);
    }
    const previous = this.leases.get(panelId) ?? null;
    this.clearExpiry(panelId);
    const lease: PanelRuntimeLease = {
      panelId,
      clientSessionId: input.clientSessionId,
      connectionId: input.connectionId,
      holderLabel: client.label,
      platform: client.platform,
      acquiredAt: Date.now(),
    };
    this.leases.set(panelId, lease);
    this.emitChange(panelId, previous, lease, reason);
    return lease;
  }

  private clearExpiry(panelId: string): void {
    const timer = this.expiryTimers.get(panelId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(panelId);
  }

  private currentVersion(): RuntimeLeaseVersion {
    return { epoch: this.epoch, counter: this.counter };
  }

  private nextVersion(): RuntimeLeaseVersion {
    this.counter += 1;
    return this.currentVersion();
  }

  private emitChange(
    panelId: string,
    previous: PanelRuntimeLease | null,
    next: PanelRuntimeLease | null,
    reason: PanelRuntimeLeaseChangedReason
  ): void {
    this.deps.eventService?.emit("panel:runtimeLeaseChanged", {
      type: "panel:runtimeLeaseChanged",
      version: this.nextVersion(),
      panelId,
      previous,
      next,
      reason,
    });
  }
}

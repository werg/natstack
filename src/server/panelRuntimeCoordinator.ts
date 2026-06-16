import { randomUUID } from "crypto";
import type { EventService } from "@natstack/shared/eventsService";
import type {
  ClientSession,
  PanelRuntimeAcquireResult,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  PanelRuntimeLeaseChangedReason,
  RuntimeLeaseSnapshot,
  RuntimeLeaseVersion,
} from "@natstack/shared/panel/panelLease";
import { asPanelEntityId, asPanelSlotId } from "@natstack/shared/panel/ids";
import type { PanelEntityId, PanelSlotId } from "@natstack/shared/panel/ids";

const LEASE_RECONNECT_GRACE_MS = 3000;

type DefaultCdpHostOptions = {
  isHostAvailable?: (hostConnectionId: string) => boolean;
};

export type RuntimeLeaseClose = (
  runtimeEntityId: string,
  connectionId: string,
  code: number,
  reason: string
) => void;

export class PanelRuntimeCoordinator {
  private readonly epoch = randomUUID();
  private counter = 0;
  private leases = new Map<PanelEntityId, PanelRuntimeLease>();
  private clients = new Map<string, ClientSession>();
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closeConnection: RuntimeLeaseClose | null = null;
  private leaseChangeListeners = new Set<(event: PanelRuntimeLeaseChangedEvent) => void>();

  constructor(private readonly deps: { eventService?: EventService } = {}) {}

  setCloseConnection(fn: RuntimeLeaseClose): void {
    this.closeConnection = fn;
  }

  onLeaseChanged(listener: (event: PanelRuntimeLeaseChangedEvent) => void): () => void {
    this.leaseChangeListeners.add(listener);
    return () => {
      this.leaseChangeListeners.delete(listener);
    };
  }

  registerClient(input: {
    clientSessionId: string;
    hostConnectionId?: string;
    ownerCallerId?: string;
    label: string;
    platform: "desktop" | "headless" | "mobile";
    supportsCdp?: boolean;
    loadOnLeaseAssignment?: boolean;
  }): void {
    const now = Date.now();
    const existing = this.clients.get(input.clientSessionId);
    this.clients.set(input.clientSessionId, {
      clientSessionId: input.clientSessionId,
      hostConnectionId:
        input.hostConnectionId ?? existing?.hostConnectionId ?? input.clientSessionId,
      ownerCallerId: input.ownerCallerId ?? existing?.ownerCallerId,
      label: input.label,
      platform: input.platform,
      supportsCdp: input.supportsCdp ?? input.platform !== "mobile",
      loadOnLeaseAssignment: input.loadOnLeaseAssignment ?? false,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
    });
  }

  unregisterClient(clientSessionId: string): void {
    const client = this.clients.get(clientSessionId);
    if (!client) return;
    this.clients.delete(clientSessionId);

    const released: Array<{ entityId: PanelEntityId; lease: PanelRuntimeLease }> = [];
    for (const [entityId, lease] of this.leases) {
      if (lease.clientSessionId !== clientSessionId) continue;
      this.clearExpiry(entityId);
      this.leases.delete(entityId);
      this.closeConnection?.(
        lease.runtimeEntityId,
        lease.connectionId,
        4095,
        "Panel runtime host unregistered"
      );
      this.emitChange(entityId, lease.slotId, lease, null, "released");
      released.push({ entityId, lease });
    }

    for (const { entityId, lease } of released) {
      this.assignDefaultCdpHost(entityId, lease.slotId);
    }
  }

  getSnapshot(): RuntimeLeaseSnapshot {
    return {
      version: this.currentVersion(),
      leases: [...this.leases.values()],
    };
  }

  getLease(runtimeEntityId: string): PanelRuntimeLease | null {
    return this.leases.get(asPanelEntityId(runtimeEntityId)) ?? null;
  }

  hasClientHostConnection(hostConnectionId: string, ownerCallerId?: string): boolean {
    for (const client of this.clients.values()) {
      if (client.hostConnectionId !== hostConnectionId) continue;
      if (ownerCallerId && client.ownerCallerId && client.ownerCallerId !== ownerCallerId) {
        return false;
      }
      return true;
    }
    return false;
  }

  resolveHostForSlot(slotId: string): { hostConnectionId: string; supportsCdp: boolean } | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    for (const lease of this.leases.values()) {
      if (lease.slotId === normalizedSlotId) {
        return { hostConnectionId: lease.hostConnectionId, supportsCdp: lease.supportsCdp };
      }
    }
    return null;
  }

  getDefaultCdpHostClient(options: DefaultCdpHostOptions = {}): ClientSession | null {
    for (const client of this.clients.values()) {
      const hostConnectionId = client.hostConnectionId ?? client.clientSessionId;
      if (client.platform !== "headless" || client.supportsCdp === false) continue;
      if (client.loadOnLeaseAssignment !== true) continue;
      if (options.isHostAvailable && !options.isHostAvailable(hostConnectionId)) continue;
      return client;
    }
    return null;
  }

  ensureDefaultCdpHostForSlot(
    slotId: string,
    runtimeEntityId: string,
    options: DefaultCdpHostOptions = {}
  ):
    | { assigned: true; lease: PanelRuntimeLease }
    | {
        assigned: false;
        reason: "already_held" | "mobile_held" | "no_default_cdp_host";
        lease?: PanelRuntimeLease;
      } {
    const normalizedSlotId = asPanelSlotId(slotId);
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId) ?? null;
    if (existing) {
      if (!existing.supportsCdp) return { assigned: false, reason: "mobile_held", lease: existing };
      return { assigned: false, reason: "already_held", lease: existing };
    }

    for (const lease of this.leases.values()) {
      if (lease.slotId !== normalizedSlotId) continue;
      if (!lease.supportsCdp) return { assigned: false, reason: "mobile_held", lease };
      return { assigned: false, reason: "already_held", lease };
    }

    const client = this.getDefaultCdpHostClient(options);
    if (!client) return { assigned: false, reason: "no_default_cdp_host" };

    return {
      assigned: true,
      lease: this.writeLease(
        entityId,
        {
          slotId,
          clientSessionId: client.clientSessionId,
          connectionId: `default-cdp-${slotId}-${randomUUID()}`,
          hostConnectionId: client.hostConnectionId,
        },
        "acquired"
      ),
    };
  }

  acquire(
    runtimeEntityId: string,
    input: {
      slotId: string;
      clientSessionId: string;
      connectionId: string;
      hostConnectionId?: string;
    }
  ): PanelRuntimeAcquireResult {
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId);
    if (
      existing &&
      existing.connectionId !== input.connectionId &&
      existing.clientSessionId !== input.clientSessionId
    ) {
      return { acquired: false, lease: existing };
    }
    return { acquired: true, lease: this.writeLease(entityId, input, "acquired") };
  }

  takeOver(
    runtimeEntityId: string,
    input: {
      slotId: string;
      clientSessionId: string;
      connectionId: string;
      hostConnectionId?: string;
    }
  ): PanelRuntimeAcquireResult {
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId);
    if (existing && existing.connectionId !== input.connectionId) {
      this.closeConnection?.(
        runtimeEntityId,
        existing.connectionId,
        4091,
        "Panel runtime lease revoked"
      );
      this.emitChange(entityId, existing.slotId, existing, null, "revoked");
    }
    return { acquired: true, lease: this.writeLease(entityId, input, "acquired") };
  }

  release(
    runtimeEntityId: string,
    connectionId: string,
    reason: PanelRuntimeLeaseChangedReason = "released"
  ): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId);
    if (!existing || existing.connectionId !== connectionId) return;
    this.clearExpiry(entityId);
    this.leases.delete(entityId);
    this.emitChange(entityId, existing.slotId, existing, null, reason);
    if ((reason === "released" || reason === "expired") && existing.platform !== "headless") {
      this.assignDefaultCdpHost(entityId, existing.slotId);
    }
  }

  unloadSlot(slotId: string): PanelRuntimeLease | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    for (const [entityId, lease] of this.leases) {
      if (lease.slotId !== normalizedSlotId) continue;
      this.clearExpiry(entityId);
      this.leases.delete(entityId);
      this.closeConnection?.(
        lease.runtimeEntityId,
        lease.connectionId,
        4094,
        "Panel runtime unloaded"
      );
      this.emitChange(entityId, lease.slotId, lease, null, "released");
      return lease;
    }
    return null;
  }

  retireRuntimeEntity(runtimeEntityId: string): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const existing = this.leases.get(entityId);
    if (!existing) return;
    this.clearExpiry(entityId);
    this.leases.delete(entityId);
    this.closeConnection?.(
      runtimeEntityId,
      existing.connectionId,
      4093,
      "Panel runtime entity retired"
    );
    this.emitChange(entityId, existing.slotId, existing, null, "retired");
  }

  authorizePanelConnection(
    runtimeEntityId: string,
    connectionId: string
  ): { ok: true } | { ok: false; reason: string } {
    const lease = this.leases.get(asPanelEntityId(runtimeEntityId));
    if (!lease) return { ok: false, reason: "Panel runtime has no active lease" };
    if (lease.connectionId !== connectionId) {
      return { ok: false, reason: `Panel runtime is leased by ${lease.holderLabel}` };
    }
    return { ok: true };
  }

  markConnected(runtimeEntityId: string, connectionId: string): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const lease = this.leases.get(entityId);
    if (!lease || lease.connectionId !== connectionId) return;
    this.clearExpiry(entityId);
    if (lease.expiresAt !== undefined) {
      const next = { ...lease };
      delete next.expiresAt;
      this.leases.set(entityId, next);
      this.emitChange(entityId, lease.slotId, lease, next, "acquired");
    }
  }

  markDisconnected(runtimeEntityId: string, connectionId: string): void {
    const entityId = asPanelEntityId(runtimeEntityId);
    const lease = this.leases.get(entityId);
    if (!lease || lease.connectionId !== connectionId) return;
    this.clearExpiry(entityId);
    const expiresAt = Date.now() + LEASE_RECONNECT_GRACE_MS;
    const next = { ...lease, expiresAt };
    this.leases.set(entityId, next);
    this.emitChange(entityId, lease.slotId, lease, next, "released");
    this.expiryTimers.set(
      entityId,
      setTimeout(() => {
        this.release(runtimeEntityId, connectionId, "expired");
      }, LEASE_RECONNECT_GRACE_MS)
    );
  }

  resolveRouteLease(targetId: string): PanelRuntimeLease | null {
    const entityLease = this.leases.get(asPanelEntityId(targetId));
    if (entityLease) return entityLease;
    const slotId = asPanelSlotId(targetId);
    for (const lease of this.leases.values()) {
      if (lease.slotId === slotId) return lease;
    }
    return null;
  }

  resolveRouteConnection(targetId: string): string | null {
    return this.resolveRouteLease(targetId)?.connectionId ?? null;
  }

  resolveRouteRuntimeEntityId(targetId: string): string | null {
    return this.resolveRouteLease(targetId)?.runtimeEntityId ?? null;
  }

  private writeLease(
    runtimeEntityId: PanelEntityId,
    input: {
      slotId: string;
      clientSessionId: string;
      connectionId: string;
      hostConnectionId?: string;
    },
    reason: PanelRuntimeLeaseChangedReason
  ): PanelRuntimeLease {
    const client = this.clients.get(input.clientSessionId);
    if (!client) {
      throw new Error(`Unknown runtime client session: ${input.clientSessionId}`);
    }
    const slotId = asPanelSlotId(input.slotId);
    const previous = this.leases.get(runtimeEntityId) ?? null;
    this.clearExpiry(runtimeEntityId);
    const lease: PanelRuntimeLease = {
      slotId,
      runtimeEntityId,
      clientSessionId: input.clientSessionId,
      hostConnectionId: input.hostConnectionId ?? client.hostConnectionId ?? input.clientSessionId,
      connectionId: input.connectionId,
      holderLabel: client.label,
      platform: client.platform,
      supportsCdp: client.supportsCdp ?? client.platform !== "mobile",
      loadOnLeaseAssignment: client.loadOnLeaseAssignment ?? false,
      acquiredAt: Date.now(),
    };
    this.leases.set(runtimeEntityId, lease);
    this.emitChange(runtimeEntityId, slotId, previous, lease, reason);
    return lease;
  }

  private assignDefaultCdpHost(
    runtimeEntityId: PanelEntityId,
    slotId: PanelSlotId
  ): PanelRuntimeLease | null {
    const client = this.getDefaultCdpHostClient();
    if (!client) return null;
    return this.writeLease(
      runtimeEntityId,
      {
        slotId,
        clientSessionId: client.clientSessionId,
        connectionId: `default-cdp-${slotId}-${randomUUID()}`,
        hostConnectionId: client.hostConnectionId,
      },
      "acquired"
    );
  }

  private clearExpiry(runtimeEntityId: PanelEntityId): void {
    const timer = this.expiryTimers.get(runtimeEntityId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(runtimeEntityId);
  }

  private currentVersion(): RuntimeLeaseVersion {
    return { epoch: this.epoch, counter: this.counter };
  }

  private nextVersion(): RuntimeLeaseVersion {
    this.counter += 1;
    return this.currentVersion();
  }

  private emitChange(
    runtimeEntityId: PanelEntityId,
    slotId: PanelSlotId,
    previous: PanelRuntimeLease | null,
    next: PanelRuntimeLease | null,
    reason: PanelRuntimeLeaseChangedReason
  ): void {
    const event: PanelRuntimeLeaseChangedEvent = {
      type: "panel:runtimeLeaseChanged",
      version: this.nextVersion(),
      slotId,
      runtimeEntityId,
      previous,
      next,
      reason,
    };
    this.deps.eventService?.emit("panel:runtimeLeaseChanged", event);
    for (const listener of this.leaseChangeListeners) listener(event);
  }
}

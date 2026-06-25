import { randomUUID } from "crypto";
import type { EventService } from "@natstack/shared/eventsService";
import type {
  ClientSession,
  PanelHostRegistration,
  PanelRuntimeAcquireResult,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  PanelRuntimeLeaseChangedReason,
  RuntimeLeaseSnapshot,
  RuntimeLeaseVersion,
} from "@natstack/shared/panel/panelLease";
import {
  asPanelEntityId,
  asPanelSlotId,
  isPanelEntityId,
  isPanelSlotId,
} from "@natstack/shared/panel/ids";
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
  private defaultCdpLeaseConnections = new Set<string>();
  /**
   * Slots that must stay loaded on their serving host (≥1 CDP client attached).
   * Leases for a pinned slot carry `keepLoaded: true` and are refused for
   * release/unload/expiry so mid-automation operations can't yank the page.
   */
  private keptLoadedSlots = new Set<PanelSlotId>();
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

  /**
   * Pin a slot loaded while a CDP client is connected. Re-stamps any existing
   * lease(s) for the slot with `keepLoaded: true` and emits a lease change so
   * the serving host's tracker keeps the panel loaded (and skips eviction).
   */
  pinSlotLoaded(slotId: string): void {
    const normalizedSlotId = asPanelSlotId(slotId);
    if (this.keptLoadedSlots.has(normalizedSlotId)) return;
    this.keptLoadedSlots.add(normalizedSlotId);
    this.restampSlotKeepLoaded(normalizedSlotId, true);
  }

  /** Release the keep-loaded pin; normal unload/eviction resumes for the slot. */
  unpinSlotLoaded(slotId: string): void {
    const normalizedSlotId = asPanelSlotId(slotId);
    if (!this.keptLoadedSlots.delete(normalizedSlotId)) return;
    this.restampSlotKeepLoaded(normalizedSlotId, false);
  }

  private restampSlotKeepLoaded(slotId: PanelSlotId, keepLoaded: boolean): void {
    for (const [entityId, lease] of this.leases) {
      if (lease.slotId !== slotId) continue;
      if ((lease.keepLoaded ?? false) === keepLoaded) continue;
      const next: PanelRuntimeLease = { ...lease, keepLoaded };
      this.leases.set(entityId, next);
      this.emitChange(entityId, slotId, lease, next, "acquired");
    }
  }

  registerClient(input: PanelHostRegistration): void {
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

    const released: Array<{
      entityId: PanelEntityId;
      lease: PanelRuntimeLease;
      wasDefaultCdpLease: boolean;
    }> = [];
    for (const [entityId, lease] of this.leases) {
      if (lease.clientSessionId !== clientSessionId) continue;
      this.clearExpiry(entityId);
      this.leases.delete(entityId);
      const wasDefaultCdpLease = this.defaultCdpLeaseConnections.delete(lease.connectionId);
      this.closeConnection?.(
        lease.runtimeEntityId,
        lease.connectionId,
        4095,
        "Panel runtime host unregistered"
      );
      this.emitChange(entityId, lease.slotId, lease, null, "released");
      released.push({ entityId, lease, wasDefaultCdpLease });
    }

    for (const { entityId, lease, wasDefaultCdpLease } of released) {
      if (this.shouldReassignDefaultCdpLease(lease, wasDefaultCdpLease)) {
        this.assignDefaultCdpHost(entityId, lease.slotId);
      }
    }
  }

  getSnapshot(): RuntimeLeaseSnapshot {
    return {
      version: this.currentVersion(),
      leases: [...this.leases.values()],
    };
  }

  getLease(runtimeEntityId: string): PanelRuntimeLease | null {
    // Called with arbitrary caller ids during routing (panels, workers, DOs). The lease map is keyed
    // by panel ENTITY ids, so a non-panel id simply has no panel lease — return null, don't throw.
    if (!isPanelEntityId(runtimeEntityId)) return null;
    return this.leases.get(runtimeEntityId) ?? null;
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

  ownsClientSession(clientSessionId: string, ownerCallerId: string): boolean {
    const client = this.clients.get(clientSessionId);
    if (!client) return false;
    return client.ownerCallerId === undefined || client.ownerCallerId === ownerCallerId;
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

  /**
   * Pick the default CDP host for a PROGRAMMATIC panel (no UI launcher).
   *
   * Origin is implicit here: a UI-launched panel reaches its desktop host via
   * the desktop orchestrator's own `acquire()` (the lease already exists, so
   * `ensureDefaultCdpHostForSlot` short-circuits at `already_held` and never
   * calls this). Every call into this selection is therefore agent/eval/worker
   * originated, with no UI host of its own. We MUST prefer the headless host:
   * `Page.captureScreenshot` and other CDP ops hang on an unpainted panel on a
   * headed desktop host. The desktop is kept only as a graceful fallback so
   * programmatic panels still render when no headless host is reachable
   * (matches the "degrade to desktop" requirement). Regression guard: 6ab6c7ca
   * flipped this to desktop-first, sending programmatic panels to the headed
   * host where capture hangs.
   */
  getDefaultCdpHostClient(options: DefaultCdpHostOptions = {}): ClientSession | null {
    const candidates = [...this.clients.values()].sort((a, b) => {
      const rank = (client: ClientSession) => (client.platform === "headless" ? 0 : 1);
      return rank(a) - rank(b);
    });
    for (const client of candidates) {
      const hostConnectionId = client.hostConnectionId ?? client.clientSessionId;
      if (client.supportsCdp === false) continue;
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
        "acquired",
        { defaultCdpLease: true }
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
    // Keep-loaded pin: a CDP client is mid-automation on this slot. Refuse the
    // drop so the lease stays in the snapshot and the host keeps the panel.
    if (this.keptLoadedSlots.has(existing.slotId)) {
      this.clearExpiry(entityId);
      return;
    }
    this.clearExpiry(entityId);
    this.leases.delete(entityId);
    const wasDefaultCdpLease = this.defaultCdpLeaseConnections.delete(existing.connectionId);
    this.emitChange(entityId, existing.slotId, existing, null, reason);
    if (
      (reason === "released" || reason === "expired") &&
      this.shouldReassignDefaultCdpLease(existing, wasDefaultCdpLease)
    ) {
      this.assignDefaultCdpHost(entityId, existing.slotId);
    }
  }

  unloadSlot(slotId: string): PanelRuntimeLease | null {
    const normalizedSlotId = asPanelSlotId(slotId);
    // Keep-loaded pin wins over an explicit unload while CDP automation is live.
    if (this.keptLoadedSlots.has(normalizedSlotId)) return null;
    for (const [entityId, lease] of this.leases) {
      if (lease.slotId !== normalizedSlotId) continue;
      this.clearExpiry(entityId);
      this.leases.delete(entityId);
      this.defaultCdpLeaseConnections.delete(lease.connectionId);
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
    // Runs for EVERY retiring entity (panels, workers, DOs — see runtimeEntityCleanup). Only panel
    // entities can hold a panel lease, so a non-panel id has nothing to retire here — return, don't throw.
    if (!isPanelEntityId(runtimeEntityId)) return;
    const entityId = runtimeEntityId;
    const existing = this.leases.get(entityId);
    if (!existing) return;
    this.clearExpiry(entityId);
    this.leases.delete(entityId);
    this.defaultCdpLeaseConnections.delete(existing.connectionId);
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
    // The router probes EVERY target id here — panel entity, panel slot, worker, or do. Branch on the
    // id KIND (a non-panel target has no panel lease) instead of laundering it through asPanel*, which
    // now throws. A panel entity id matches a lease directly; a panel slot id scans for the slot.
    if (isPanelEntityId(targetId)) {
      const entityLease = this.leases.get(targetId);
      if (entityLease) return entityLease;
    }
    if (isPanelSlotId(targetId)) {
      for (const lease of this.leases.values()) {
        if (lease.slotId === targetId) return lease;
      }
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
    reason: PanelRuntimeLeaseChangedReason,
    options: { defaultCdpLease?: boolean } = {}
  ): PanelRuntimeLease {
    const client = this.clients.get(input.clientSessionId);
    if (!client) {
      throw new Error(`Unknown runtime client session: ${input.clientSessionId}`);
    }
    const slotId = asPanelSlotId(input.slotId);
    const previous = this.leases.get(runtimeEntityId) ?? null;
    this.clearExpiry(runtimeEntityId);
    if (previous) this.defaultCdpLeaseConnections.delete(previous.connectionId);
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
      keepLoaded: this.keptLoadedSlots.has(slotId),
      acquiredAt: Date.now(),
    };
    this.leases.set(runtimeEntityId, lease);
    if (options.defaultCdpLease) this.defaultCdpLeaseConnections.add(lease.connectionId);
    this.emitChange(runtimeEntityId, slotId, previous, lease, reason);
    return lease;
  }

  private assignDefaultCdpHost(
    runtimeEntityId: PanelEntityId,
    slotId: PanelSlotId
  ): PanelRuntimeLease | null {
    const client = this.getDefaultCdpHostClient();
    if (!client) return null;
    const connectionId = `default-cdp-${slotId}-${randomUUID()}`;
    return this.writeLease(
      runtimeEntityId,
      {
        slotId,
        clientSessionId: client.clientSessionId,
        connectionId,
        hostConnectionId: client.hostConnectionId,
      },
      "acquired",
      { defaultCdpLease: true }
    );
  }

  private shouldReassignDefaultCdpLease(
    lease: PanelRuntimeLease,
    wasDefaultCdpLease = this.defaultCdpLeaseConnections.has(lease.connectionId)
  ): boolean {
    return wasDefaultCdpLease && lease.platform !== "headless";
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

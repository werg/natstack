import type { PanelEntityId, PanelSlotId } from "./ids.js";
import type { ClientPlatform } from "@natstack/rpc/protocol/wsProtocol";

export type { ClientPlatform } from "@natstack/rpc/protocol/wsProtocol";

export interface PanelHostRegistration {
  clientSessionId: string;
  hostConnectionId?: string;
  ownerCallerId?: string;
  label: string;
  platform: ClientPlatform;
  supportsCdp?: boolean;
  loadOnLeaseAssignment?: boolean;
}

export interface PanelHost {
  registration: PanelHostRegistration;
  handleRuntimeLeaseChanged(event: PanelRuntimeLeaseChangedEvent): void | Promise<void>;
  syncRuntimeLeases?(): Promise<void>;
}

export function createPanelHostRegistration(
  registration: PanelHostRegistration
): PanelHostRegistration {
  return {
    ...registration,
    hostConnectionId: registration.hostConnectionId ?? registration.clientSessionId,
  };
}

export interface ClientSession extends PanelHostRegistration {
  connectedAt: number;
  lastSeenAt: number;
}

export interface RuntimeLeaseVersion {
  epoch: string;
  counter: number;
}

export interface PanelRuntimeLease {
  slotId: PanelSlotId;
  runtimeEntityId: PanelEntityId;
  clientSessionId: string;
  hostConnectionId: string;
  connectionId: string;
  holderLabel: string;
  platform: ClientPlatform;
  supportsCdp: boolean;
  loadOnLeaseAssignment: boolean;
  /**
   * Pin: while true the host serving this lease MUST keep the panel loaded and
   * MUST NOT capacity-evict it. Set by the coordinator while ≥1 CDP client is
   * connected to the panel target, so mid-automation unloads can't yank the page.
   */
  keepLoaded?: boolean;
  acquiredAt: number;
  expiresAt?: number;
}

export interface PanelRuntimeLeaseRequest {
  slotId: PanelSlotId;
  clientSessionId: string;
  connectionId: string;
  hostConnectionId?: string;
}

export function createPanelRuntimeLeaseRequest(args: {
  slotId: PanelSlotId | string;
  clientSessionId: string;
  connectionId: string;
  hostConnectionId?: string;
}): PanelRuntimeLeaseRequest {
  return {
    slotId: args.slotId as PanelSlotId,
    clientSessionId: args.clientSessionId,
    connectionId: args.connectionId,
    ...(args.hostConnectionId ? { hostConnectionId: args.hostConnectionId } : {}),
  };
}

export function formatPanelRuntimeLeaseDeniedMessage(
  panelId: string,
  lease: Pick<PanelRuntimeLease, "holderLabel"> | null | undefined
): string {
  return `Panel ${panelId} is running on ${lease?.holderLabel ?? "another client"}`;
}

export interface RuntimeLeaseSnapshot {
  version: RuntimeLeaseVersion;
  leases: PanelRuntimeLease[];
}

export type PanelRuntimeLeaseChangedReason =
  | "acquired"
  | "released"
  | "revoked"
  | "expired"
  | "retired";

export interface PanelRuntimeLeaseChangedEvent {
  type: "panel:runtimeLeaseChanged";
  version: RuntimeLeaseVersion;
  slotId: PanelSlotId;
  runtimeEntityId: PanelEntityId;
  previous: PanelRuntimeLease | null;
  next: PanelRuntimeLease | null;
  reason: PanelRuntimeLeaseChangedReason;
}

export type PanelRuntimeAcquireResult =
  | { acquired: true; lease: PanelRuntimeLease }
  | { acquired: false; lease: PanelRuntimeLease };

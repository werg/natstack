import type { PanelEntityId, PanelSlotId } from "./ids.js";
import type { ClientPlatform } from "@natstack/rpc/protocol/wsProtocol";

export type { ClientPlatform } from "@natstack/rpc/protocol/wsProtocol";

export interface ClientSession {
  clientSessionId: string;
  hostConnectionId?: string;
  ownerCallerId?: string;
  label: string;
  platform: ClientPlatform;
  supportsCdp?: boolean;
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
  acquiredAt: number;
  expiresAt?: number;
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

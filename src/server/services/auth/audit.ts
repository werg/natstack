import type { AuditLog } from "@natstack/shared/credentials/audit";
import type { DeviceAuthStore } from "../deviceAuthStore.js";

export interface PairingAuditDeps {
  auditLog?: Pick<AuditLog, "append">;
  deviceAuthStore: DeviceAuthStore;
  getWorkspaceId: () => string;
}

export interface PairingAuditInput {
  type:
    | "device_pairing.invite_created"
    | "device_pairing.redeemed"
    | "device_pairing.device_revoked";
  callerId: string;
  deviceId?: string;
  platform?: string;
  label?: string;
  expiresAt?: number;
  method?: string;
}

export async function auditPairingEvent(
  deps: PairingAuditDeps,
  event: PairingAuditInput
): Promise<void> {
  try {
    await deps.auditLog?.append({
      ...event,
      ts: Date.now(),
      serverId: deps.deviceAuthStore.getServerId(),
      workspaceId: deps.getWorkspaceId(),
    });
  } catch {
    // Audit must not break pairing, grant refresh, or revocation paths.
  }
}

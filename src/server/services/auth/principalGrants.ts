import type { ConnectionGrantService } from "@natstack/shared/connectionGrants";
import type { DeviceAuthStore } from "../deviceAuthStore.js";
import { authError } from "./errors.js";

export type PrincipalGrantTarget = "react-native-app";

export interface PrincipalGrantResponse {
  connectionGrant: string;
  expiresAt: number;
  callerId: string;
  deviceId: string;
  label: string;
  serverId: string;
  serverBootId: string;
  workspaceId: string;
}

export async function refreshPrincipalGrantResponse(
  deps: {
    deviceAuthStore: DeviceAuthStore;
    getServerBootId: () => string;
    getWorkspaceId: () => string;
    connectionGrants?: ConnectionGrantService;
    ensureMobileAppReady?: (source?: string | null) => Promise<{
      ready: boolean;
      reason?: string;
      details?: string[];
    }>;
    registerMobileAppPrincipal?: (
      deviceId: string,
      source?: string | null
    ) => string | null | Promise<string | null>;
  },
  body: {
    deviceId: string;
    refreshToken: string;
    principal?: PrincipalGrantTarget | string;
    source?: string | null;
  }
): Promise<PrincipalGrantResponse> {
  if (!deps.connectionGrants) {
    throw authError(
      "PRINCIPAL_GRANTS_UNAVAILABLE",
      "Device-scoped connection grants are not configured",
      503
    );
  }
  const principal = body.principal ?? "react-native-app";
  if (principal !== "react-native-app") {
    throw authError(
      "UNSUPPORTED_PRINCIPAL",
      `Unsupported principal grant target: ${principal}`,
      400
    );
  }
  const device = deps.deviceAuthStore.validateRefresh(body.deviceId, body.refreshToken);
  const readiness = await deps.ensureMobileAppReady?.(body.source ?? null);
  if (readiness && !readiness.ready) {
    throw authError(
      "PRINCIPAL_UNAVAILABLE",
      [
        readiness.reason ?? "No active React Native workspace app principal is available",
        ...(readiness.details?.length ? readiness.details : []),
      ].join(": "),
      503
    );
  }
  const callerId = await deps.registerMobileAppPrincipal?.(body.deviceId, body.source ?? null);
  if (!callerId) {
    throw authError(
      "PRINCIPAL_UNAVAILABLE",
      "No active React Native workspace app principal is available",
      503
    );
  }
  const granted = deps.connectionGrants.grant(callerId, `native-mobile:${body.deviceId}`);
  return {
    connectionGrant: granted.token,
    expiresAt: granted.expiresAt,
    callerId,
    deviceId: body.deviceId,
    label: device.label,
    serverId: deps.deviceAuthStore.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId(),
  };
}

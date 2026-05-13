import { getCredentials, type Credentials } from "./auth";
import { devBootstrapConfig } from "../generated/devBootstrap";

export interface ConnectionBootstrap extends Credentials {
  autoConnect: boolean;
  source: "stored" | "dev-bootstrap";
}

export async function getConnectionBootstrap(): Promise<ConnectionBootstrap | null> {
  if (__DEV__ && devBootstrapConfig?.serverUrl && devBootstrapConfig.deviceId && devBootstrapConfig.refreshToken) {
    return {
      serverUrl: devBootstrapConfig.serverUrl,
      deviceId: devBootstrapConfig.deviceId,
      refreshToken: devBootstrapConfig.refreshToken,
      serverId: devBootstrapConfig.serverId,
      workspaceId: devBootstrapConfig.workspaceId,
      autoConnect: devBootstrapConfig.autoConnect ?? true,
      source: "dev-bootstrap",
    };
  }

  const stored = await getCredentials();
  if (stored?.serverUrl && stored.deviceId && stored.refreshToken) {
    return {
      ...stored,
      autoConnect: true,
      source: "stored",
    };
  }

  return null;
}

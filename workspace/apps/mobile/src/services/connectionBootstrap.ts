import { completePairing, getCredentials, type Credentials } from "./auth";
import { devBootstrapConfig } from "../generated/devBootstrap";

export interface ConnectionBootstrap extends Credentials {
  autoConnect: boolean;
  source: "stored" | "dev-bootstrap";
}

export async function getConnectionBootstrap(): Promise<ConnectionBootstrap | null> {
  const stored = await getCredentials();
  if (stored?.serverUrl && stored.deviceId) {
    return {
      ...stored,
      autoConnect: true,
      source: "stored",
    };
  }

  if (__DEV__ && devBootstrapConfig?.serverUrl && devBootstrapConfig.pairingCode) {
    const paired = await completePairing(
      devBootstrapConfig.serverUrl,
      devBootstrapConfig.pairingCode,
    );
    return {
      serverUrl: paired.serverUrl,
      deviceId: paired.deviceId,
      serverId: paired.serverId,
      workspaceId: paired.workspaceId,
      autoConnect: devBootstrapConfig.autoConnect ?? true,
      source: "dev-bootstrap",
    };
  }

  return null;
}

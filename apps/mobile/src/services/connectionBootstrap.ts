import { getCredentials, type Credentials } from "./auth";
import { devBootstrapConfig } from "../generated/devBootstrap";

export interface ConnectionBootstrap extends Credentials {
  autoConnect: boolean;
  source: "stored" | "dev-bootstrap";
}

export async function getConnectionBootstrap(): Promise<ConnectionBootstrap | null> {
  if (__DEV__ && devBootstrapConfig?.serverUrl && devBootstrapConfig.shellToken) {
    return {
      serverUrl: devBootstrapConfig.serverUrl,
      token: devBootstrapConfig.shellToken,
      autoConnect: devBootstrapConfig.autoConnect ?? true,
      source: "dev-bootstrap",
    };
  }

  const stored = await getCredentials();
  if (stored?.serverUrl && stored.token) {
    return {
      ...stored,
      autoConnect: true,
      source: "stored",
    };
  }

  return null;
}

import type { Credential, ProviderManifest } from "../../../packages/shared/src/credentials/types.js";

interface CredentialStoreLike {
  load(providerId: string, connectionId: string): Promise<Credential | null> | Credential | null;
  list(providerId?: string): Promise<Credential[]> | Credential[];
}

function buildEnvVarCredential(
  providerId: string,
  envVarName: string,
): Credential | null {
  const accessToken = process.env[envVarName];
  if (!accessToken) {
    return null;
  }

  return {
    providerId,
    connectionId: `env:${envVarName}`,
    connectionLabel: `Environment variable ${envVarName}`,
    accountIdentity: {
      providerUserId: envVarName,
    },
    accessToken,
    scopes: [],
  };
}

export function getEnvVarCredential(
  providerId: string,
  manifest?: ProviderManifest,
): Credential | null {
  const envFlow = manifest?.flows.find((flow) => flow.type === "env-var" && flow.envVar);
  if (!envFlow?.envVar) {
    return null;
  }
  return buildEnvVarCredential(providerId, envFlow.envVar);
}

export async function listProviderConnections(
  credentialStore: CredentialStoreLike,
  manifest?: ProviderManifest,
): Promise<Credential[]> {
  const stored = await credentialStore.list(manifest?.id);
  const envCredential = manifest ? getEnvVarCredential(manifest.id, manifest) : null;

  if (!envCredential) {
    return stored;
  }

  if (stored.some((credential) => credential.connectionId === envCredential.connectionId)) {
    return stored;
  }

  return [...stored, envCredential];
}

export async function resolveProviderConnection(
  credentialStore: CredentialStoreLike,
  providerId: string,
  manifest?: ProviderManifest,
  connectionId?: string | null,
): Promise<Credential | null> {
  const envCredential = manifest ? getEnvVarCredential(providerId, manifest) : null;

  if (connectionId) {
    if (envCredential?.connectionId === connectionId) {
      return envCredential;
    }
    return credentialStore.load(providerId, connectionId);
  }

  const stored = await credentialStore.list(providerId);
  if (stored[0]) {
    return stored[0];
  }

  return envCredential;
}

import type { Credential, ProviderManifest } from "../../../packages/shared/src/credentials/types.js";
import { createProviderBinding, credentialMatchesProviderBinding } from "../../../packages/shared/src/credentials/providerBinding.js";

interface CredentialStoreLike {
  load(providerId: string, connectionId: string): Promise<Credential | null> | Credential | null;
  list(providerId?: string): Promise<Credential[]> | Credential[];
}

function buildEnvVarCredential(
  providerId: string,
  envVarName: string,
  manifest?: ProviderManifest,
): Credential | null {
  const accessToken = process.env[envVarName];
  if (!accessToken) {
    return null;
  }
  const binding = manifest ? createProviderBinding(manifest) : null;

  return {
    providerId,
    providerFingerprint: binding?.fingerprint,
    providerAudience: binding?.audience,
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
  return buildEnvVarCredential(providerId, envFlow.envVar, manifest);
}

export async function listProviderConnections(
  credentialStore: CredentialStoreLike,
  manifest?: ProviderManifest,
): Promise<Credential[]> {
  const stored = (await credentialStore.list(manifest?.id))
    .filter((credential) => manifest ? credentialMatchesProviderBinding(credential, manifest) : true);
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
    const credential = await credentialStore.load(providerId, connectionId);
    if (!credential) {
      return null;
    }
    return manifest && !credentialMatchesProviderBinding(credential, manifest) ? null : credential;
  }

  const stored = await credentialStore.list(providerId);
  const matchingStored = manifest
    ? stored.filter((credential) => credentialMatchesProviderBinding(credential, manifest))
    : stored;
  if (matchingStored[0]) {
    return matchingStored[0];
  }

  return envCredential;
}

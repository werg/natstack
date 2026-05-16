import type { CredentialClient, StoredCredentialSummary } from "../../runtime/src/shared/credentials.js";
import type { UrlCredentialDescriptor } from "./providers.js";

export interface UrlCredentialClient {
  credentialId: string;
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Build a URL-bound credentialed fetcher. Caller supplies the
 * `CredentialClient` (e.g. a DO's `this.credentials` or a workerd
 * worker's `runtime.credentials`) so this helper isn't tied to a
 * specific RPC caller — important for DOs where the canonical caller
 * is `this.rpc` rather than the legacy module-level singleton.
 */
export async function getUrlCredentialClient(
  credentials: CredentialClient,
  descriptor: UrlCredentialDescriptor,
): Promise<UrlCredentialClient> {
  const credential = await findCredential(credentials, descriptor);
  if (!credential) {
    throw new Error(
      `No URL-bound credential found for ${descriptor.displayName}. Store one with an audience matching ${descriptor.audiences[0]?.url ?? descriptor.id}.`,
    );
  }
  return {
    credentialId: credential.id,
    fetch(url, init) {
      return credentials.fetch(url, init, { credentialId: credential.id });
    },
  };
}

async function findCredential(
  credentials: CredentialClient,
  descriptor: UrlCredentialDescriptor,
): Promise<StoredCredentialSummary | null> {
  for (const audience of descriptor.audiences) {
    const credential = await credentials.resolveCredential({
      url: audience.url,
      credentialId: descriptor.credentialId,
    });
    if (credential) {
      return credential;
    }
  }
  return null;
}

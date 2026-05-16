import { resolveCredential, type StoredCredentialSummary } from "../../runtime/src/worker/credentials.js";
import type { UrlCredentialDescriptor } from "./providers.js";

export interface UrlCredentialClient {
  credentialId: string;
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}

export async function getUrlCredentialClient(descriptor: UrlCredentialDescriptor): Promise<UrlCredentialClient> {
  const credential = await findCredential(descriptor);
  if (!credential) {
    throw new Error(
      `No URL-bound credential found for ${descriptor.displayName}. Store one with an audience matching ${descriptor.audiences[0]?.url ?? descriptor.id}.`,
    );
  }
  return {
    credentialId: credential.id,
    fetch(url, init) {
      const headers = new Headers(init?.headers);
      headers.set("X-NatStack-Use-Credential", credential.id);
      return fetch(url, { ...init, headers });
    },
  };
}

async function findCredential(descriptor: UrlCredentialDescriptor): Promise<StoredCredentialSummary | null> {
  for (const audience of descriptor.audiences) {
    const credential = await resolveCredential({
      url: audience.url,
      credentialId: descriptor.credentialId,
    });
    if (credential) {
      return credential;
    }
  }
  return null;
}

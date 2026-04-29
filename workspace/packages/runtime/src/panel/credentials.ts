import type { RpcCaller } from "@natstack/rpc";
import {
  createCredentialClient,
  type BeginOAuthPkceCredentialResult,
  type CompleteOAuthPkceCredentialRequest,
  type CreateOAuthPkceCredentialRequest,
  type CredentialClient,
  type GrantUrlBoundCredentialRequest,
  type ResolveUrlBoundCredentialRequest,
  type StoredCredentialSummary,
  type StoreUrlBoundCredentialRequest,
} from "../shared/credentials.js";

let client: CredentialClient | null = null;

function requireClient(): CredentialClient {
  if (!client) {
    throw new Error("Panel credentials have not been initialized");
  }
  return client;
}

export function initPanelCredentials(rpc: RpcCaller): void {
  if (!client) {
    client = createCredentialClient(rpc);
  }
}

export async function store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary> {
  return requireClient().store(input);
}

export async function beginCreateWithOAuthPkce(
  input: CreateOAuthPkceCredentialRequest,
): Promise<BeginOAuthPkceCredentialResult> {
  return requireClient().beginCreateWithOAuthPkce(input);
}

export async function completeCreateWithOAuthPkce(
  input: CompleteOAuthPkceCredentialRequest,
): Promise<StoredCredentialSummary> {
  return requireClient().completeCreateWithOAuthPkce(input);
}

export async function listStoredCredentials(): Promise<StoredCredentialSummary[]> {
  return requireClient().listStoredCredentials();
}

export async function revokeCredential(credentialId: string): Promise<void> {
  await requireClient().revokeCredential(credentialId);
}

export async function grantCredential(input: GrantUrlBoundCredentialRequest): Promise<StoredCredentialSummary> {
  return requireClient().grantCredential(input);
}

export async function resolveCredential(
  input: ResolveUrlBoundCredentialRequest,
): Promise<StoredCredentialSummary | null> {
  return requireClient().resolveCredential(input);
}

export async function fetch(
  url: string | URL,
  init?: RequestInit,
  opts?: { credentialId?: string },
): Promise<Response> {
  return requireClient().fetch(url, init, opts);
}

export function hookForUrl(
  url: string | URL,
  opts?: { credentialId?: string },
): (init?: RequestInit) => Promise<Response> {
  return requireClient().hookForUrl(url, opts);
}

export type {
  BeginOAuthPkceCredentialResult,
  CompleteOAuthPkceCredentialRequest,
  CreateOAuthPkceCredentialRequest,
  CredentialClient,
  GrantUrlBoundCredentialRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "../shared/credentials.js";

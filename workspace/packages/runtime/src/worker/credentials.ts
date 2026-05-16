import {
  createCredentialClient,
  type ClientConfigStatus,
  type ConfigureClientRequest,
  type ConnectCredentialRequest,
  type CredentialClient,
  type DeleteClientConfigRequest,
  type GetClientConfigStatusRequest,
  type GitHttpClient,
  type RequestCredentialInputRequest,
  type ResolveUrlBoundCredentialRequest,
  type StoredCredentialSummary,
  type StoreUrlBoundCredentialRequest,
} from "../shared/credentials.js";
import { workerHostRpcCaller } from "./hostRpc.js";

const client: CredentialClient = createCredentialClient(workerHostRpcCaller);

export async function store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary> {
  return client.store(input);
}

export async function connect(
  input: ConnectCredentialRequest,
): Promise<StoredCredentialSummary> {
  return client.connect(input);
}

export async function configureClient(
  input: ConfigureClientRequest,
): Promise<ClientConfigStatus> {
  return client.configureClient(input);
}

export async function requestCredentialInput(
  input: RequestCredentialInputRequest,
): Promise<StoredCredentialSummary> {
  return client.requestCredentialInput(input);
}

export async function getClientConfigStatus(
  input: GetClientConfigStatusRequest,
): Promise<ClientConfigStatus> {
  return client.getClientConfigStatus(input);
}

export async function deleteClientConfig(
  input: DeleteClientConfigRequest | string,
): Promise<void> {
  await client.deleteClientConfig(input);
}

export async function listStoredCredentials(): Promise<StoredCredentialSummary[]> {
  return client.listStoredCredentials();
}

export async function revokeCredential(credentialId: string): Promise<void> {
  await client.revokeCredential(credentialId);
}

export async function resolveCredential(
  input: ResolveUrlBoundCredentialRequest,
): Promise<StoredCredentialSummary | null> {
  return client.resolveCredential(input);
}

export function gitHttp(opts?: { credentialId?: string }): GitHttpClient {
  return client.gitHttp(opts);
}

export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialClient,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  GitHttpClient,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "../shared/credentials.js";

import type { RpcCaller } from "@natstack/rpc";
import type {
  BeginOAuthPkceCredentialResult,
  BeginOAuthClientPkceCredentialRequest,
  CompleteOAuthPkceCredentialRequest,
  CreateOAuthPkceCredentialRequest,
  GetOAuthClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  OAuthClientConfigStatus,
  RequestCredentialInputRequest,
  RequestOAuthClientConfigRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "@natstack/shared/credentials/types";

export type {
  BeginOAuthPkceCredentialResult,
  BeginOAuthClientPkceCredentialRequest,
  CompleteOAuthPkceCredentialRequest,
  CreateOAuthPkceCredentialRequest,
  GetOAuthClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  OAuthClientConfigStatus,
  RequestCredentialInputRequest,
  RequestOAuthClientConfigRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "@natstack/shared/credentials/types";

export interface CredentialClient {
  store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
  beginCreateWithOAuthPkce(input: CreateOAuthPkceCredentialRequest): Promise<BeginOAuthPkceCredentialResult>;
  beginCreateWithOAuthClientPkce(input: BeginOAuthClientPkceCredentialRequest): Promise<BeginOAuthPkceCredentialResult>;
  completeCreateWithOAuthPkce(input: CompleteOAuthPkceCredentialRequest): Promise<StoredCredentialSummary>;
  requestOAuthClientConfig(input: RequestOAuthClientConfigRequest): Promise<OAuthClientConfigStatus>;
  requestCredentialInput(input: RequestCredentialInputRequest): Promise<StoredCredentialSummary>;
  getOAuthClientConfigStatus(input: GetOAuthClientConfigStatusRequest): Promise<OAuthClientConfigStatus>;
  listStoredCredentials(): Promise<StoredCredentialSummary[]>;
  revokeCredential(credentialId: string): Promise<void>;
  grantCredential(input: GrantUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
  resolveCredential(input: ResolveUrlBoundCredentialRequest): Promise<StoredCredentialSummary | null>;
  fetch(
    url: string | URL,
    init?: RequestInit,
    opts?: { credentialId?: string },
  ): Promise<Response>;
  hookForUrl(
    url: string | URL,
    opts?: { credentialId?: string },
  ): (init?: RequestInit) => Promise<Response>;
}

export function createCredentialClient(rpc: RpcCaller): CredentialClient {
  return {
    async store(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.storeCredential", input);
    },
    async beginCreateWithOAuthPkce(input) {
      return rpc.call<BeginOAuthPkceCredentialResult>("main", "credentials.beginCreateWithOAuthPkce", input);
    },
    async beginCreateWithOAuthClientPkce(input) {
      return rpc.call<BeginOAuthPkceCredentialResult>("main", "credentials.beginCreateWithOAuthClientPkce", input);
    },
    async completeCreateWithOAuthPkce(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.completeCreateWithOAuthPkce", input);
    },
    async requestOAuthClientConfig(input) {
      return rpc.call<OAuthClientConfigStatus>("main", "credentials.requestOAuthClientConfig", input);
    },
    async requestCredentialInput(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.requestCredentialInput", input);
    },
    async getOAuthClientConfigStatus(input) {
      return rpc.call<OAuthClientConfigStatus>("main", "credentials.getOAuthClientConfigStatus", input);
    },
    async listStoredCredentials() {
      return rpc.call<StoredCredentialSummary[]>("main", "credentials.listStoredCredentials");
    },
    async revokeCredential(credentialId) {
      await rpc.call<void>("main", "credentials.revokeCredential", { credentialId });
    },
    async grantCredential(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.grantCredential", input);
    },
    async resolveCredential(input) {
      return rpc.call<StoredCredentialSummary | null>("main", "credentials.resolveCredential", input);
    },
    async fetch(url, init, opts) {
      return proxyFetch(rpc, url, init, opts);
    },
    hookForUrl(url, opts) {
      return (init?: RequestInit) => proxyFetch(rpc, url, init, opts);
    },
  };
}

async function proxyFetch(
  rpc: RpcCaller,
  url: string | URL,
  init?: RequestInit,
  opts?: { credentialId?: string },
): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = init?.body === undefined || init.body === null
    ? undefined
    : typeof init.body === "string"
      ? init.body
      : init.body instanceof URLSearchParams
        ? init.body.toString()
        : (() => {
            throw new Error("credentials.fetch currently supports string and URLSearchParams request bodies");
          })();
  const result = await rpc.call<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  }>("main", "credentials.proxyFetch", {
    url: url.toString(),
    method: init?.method ?? "GET",
    headers,
    body,
    credentialId: opts?.credentialId,
  });
  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

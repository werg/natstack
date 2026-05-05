import type { RpcCaller } from "@natstack/rpc";
import type {
  ConfigureOAuthClientRequest,
  ConnectOAuthCredentialRequest,
  DeleteOAuthClientConfigRequest,
  GetOAuthClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  OAuthClientConfigStatus,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "@natstack/shared/credentials/types";

export type {
  ConfigureOAuthClientRequest,
  ConnectOAuthCredentialRequest,
  DeleteOAuthClientConfigRequest,
  GetOAuthClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  OAuthClientConfigStatus,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "@natstack/shared/credentials/types";

export interface CredentialClient {
  store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
  connectOAuth(input: ConnectOAuthCredentialRequest): Promise<StoredCredentialSummary>;
  configureOAuthClient(input: ConfigureOAuthClientRequest): Promise<OAuthClientConfigStatus>;
  requestCredentialInput(input: RequestCredentialInputRequest): Promise<StoredCredentialSummary>;
  getOAuthClientConfigStatus(input: GetOAuthClientConfigStatusRequest): Promise<OAuthClientConfigStatus>;
  deleteOAuthClientConfig(input: DeleteOAuthClientConfigRequest | string): Promise<void>;
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
  gitHttp(opts?: { credentialId?: string }): GitHttpClient;
}

export interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | AsyncIterable<Uint8Array>;
}

export interface GitHttpResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: AsyncIterableIterator<Uint8Array>;
}

export interface GitHttpClient {
  request(request: GitHttpRequest): Promise<GitHttpResponse>;
}

export function createCredentialClient(rpc: RpcCaller): CredentialClient {
  return {
    async store(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.storeCredential", input);
    },
    async connectOAuth(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.connectOAuth", input);
    },
    async configureOAuthClient(input) {
      return rpc.call<OAuthClientConfigStatus>("main", "credentials.configureOAuthClient", input);
    },
    async requestCredentialInput(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.requestCredentialInput", input);
    },
    async getOAuthClientConfigStatus(input) {
      return rpc.call<OAuthClientConfigStatus>("main", "credentials.getOAuthClientConfigStatus", input);
    },
    async deleteOAuthClientConfig(input) {
      const request = typeof input === "string" ? { configId: input } : input;
      await rpc.call<void>("main", "credentials.deleteOAuthClientConfig", request);
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
    gitHttp(opts) {
      return createGitHttpClient(rpc, opts);
    },
  };
}

function createGitHttpClient(rpc: RpcCaller, opts?: { credentialId?: string }): GitHttpClient {
  return {
    async request(request) {
      const body = request.body ? await collectGitBody(request.body) : undefined;
      const result = await rpc.call<ProxyGitHttpResponse>("main", "credentials.proxyGitHttp", {
        url: request.url,
        method: request.method ?? "GET",
        headers: request.headers ?? {},
        bodyBase64: body ? bytesToBase64(body) : undefined,
        credentialId: opts?.credentialId,
      } satisfies ProxyGitHttpRequest);
      const responseBody = base64ToBytes(result.bodyBase64);
      return {
        url: result.url,
        method: result.method,
        statusCode: result.statusCode,
        statusMessage: result.statusMessage,
        headers: result.headers,
        body: (async function* () {
          yield responseBody;
        })(),
      };
    },
  };
}

async function collectGitBody(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

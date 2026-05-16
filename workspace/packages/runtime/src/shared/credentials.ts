import type { RpcCaller } from "@natstack/rpc";
import type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "@natstack/shared/credentials/types";

export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "@natstack/shared/credentials/types";

export interface CredentialClient {
  store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
  connect(input: ConnectCredentialRequest): Promise<StoredCredentialSummary>;
  configureClient(input: ConfigureClientRequest): Promise<ClientConfigStatus>;
  requestCredentialInput(input: RequestCredentialInputRequest): Promise<StoredCredentialSummary>;
  getClientConfigStatus(input: GetClientConfigStatusRequest): Promise<ClientConfigStatus>;
  deleteClientConfig(input: DeleteClientConfigRequest | string): Promise<void>;
  listStoredCredentials(): Promise<StoredCredentialSummary[]>;
  revokeCredential(credentialId: string): Promise<void>;
  resolveCredential(input: ResolveUrlBoundCredentialRequest): Promise<StoredCredentialSummary | null>;
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
    async connect(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.connect", input);
    },
    async configureClient(input) {
      return rpc.call<ClientConfigStatus>("main", "credentials.configureClient", input);
    },
    async requestCredentialInput(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.requestCredentialInput", input);
    },
    async getClientConfigStatus(input) {
      return rpc.call<ClientConfigStatus>("main", "credentials.getClientConfigStatus", input);
    },
    async deleteClientConfig(input) {
      const request = typeof input === "string" ? { configId: input } : input;
      await rpc.call<void>("main", "credentials.deleteClientConfig", request);
    },
    async listStoredCredentials() {
      return rpc.call<StoredCredentialSummary[]>("main", "credentials.listStoredCredentials");
    },
    async revokeCredential(credentialId) {
      await rpc.call<void>("main", "credentials.revokeCredential", { credentialId });
    },
    async resolveCredential(input) {
      return rpc.call<StoredCredentialSummary | null>("main", "credentials.resolveCredential", input);
    },
    gitHttp(opts) {
      return createGitHttpClient(rpc, opts);
    },
  };
}

function createGitHttpClient(rpc: RpcCaller, opts?: { credentialId?: string }): GitHttpClient {
  void rpc;
  return {
    async request(request) {
      const body = request.body ? await collectGitBody(request.body) : undefined;
      const headers = new Headers(request.headers ?? {});
      if (opts?.credentialId) {
        headers.set("X-NatStack-Use-Credential", opts.credentialId);
      }
      const response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers,
        body: body as BodyInit | undefined,
      });
      return {
        url: response.url,
        method: request.method ?? "GET",
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: response.body ? toAsyncIterable(response.body) : emptyAsyncIterable(),
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

async function* toAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* emptyAsyncIterable(): AsyncIterableIterator<Uint8Array> {}

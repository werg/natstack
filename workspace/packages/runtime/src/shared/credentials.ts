import type { RpcCaller } from "@natstack/rpc";
import type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
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
  GrantUrlBoundCredentialRequest,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
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
  const encoded = await encodeRequestBody(init?.body);
  const requestedUrl = url.toString();
  const args = {
    url: requestedUrl,
    method: init?.method ?? "GET",
    headers,
    body: encoded.body,
    bodyBase64: encoded.bodyBase64,
    credentialId: opts?.credentialId,
  };

  // Every bridge has `streamCall` — HTTP delivers real streaming via
  // `/rpc/stream`; transport-based bridges wrap their buffered call
  // in a uniform Response API. Callers don't branch on transport.
  const response = await rpc.streamCall(
    "main",
    "credentials.proxyFetch",
    [args],
    { signal: init?.signal ?? undefined },
  );
  // The HTTP bridge already constructed a Response with `url` set
  // from the upstream's HEAD frame. The transport-based bridge does
  // the same. We just need to make sure `response.url` reflects the
  // requested URL when nothing else set it (some test mocks).
  if (!response.url) {
    try {
      Object.defineProperty(response, "url", {
        value: requestedUrl,
        writable: false,
        configurable: true,
      });
    } catch {
      // ignore — runtime locked the descriptor
    }
  }
  return response;
}


/**
 * Encode a `RequestInit.body` for transport over the `credentials.proxyFetch`
 * RPC. String / URLSearchParams bodies cross the wire as UTF-8 text; binary
 * bodies (Uint8Array, ArrayBuffer, Blob, typed arrays) cross as base64.
 * Streams aren't supported — the RPC has no streaming envelope.
 */
async function encodeRequestBody(
  body: BodyInit | null | undefined,
): Promise<{ body?: string; bodyBase64?: string }> {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };
  if (body instanceof ArrayBuffer) {
    return { bodyBase64: bytesToBase64(new Uint8Array(body)) };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return { bodyBase64: bytesToBase64(bytes) };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return { bodyBase64: bytesToBase64(new Uint8Array(await body.arrayBuffer())) };
  }
  throw new Error(
    "credentials.fetch supports string, URLSearchParams, ArrayBuffer, typed-array, and Blob request bodies",
  );
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

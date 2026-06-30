import { type RpcCaller, bytesToBase64, base64ToBytes } from "@natstack/rpc";
import type { ClientConfigStatus, ConfigureClientRequest, ConnectCredentialRequest, CredentialAccessGrantSummary, CredentialAccessSubjectSummary, CredentialBinding, CredentialBindingUse, CredentialGrantResourceHint, CredentialInjection, DeleteClientConfigRequest, GetClientConfigStatusRequest, GrantUrlBoundCredentialRequest, ManagedCredentialSummary, ProxyGitHttpRequest, ProxyGitHttpResponse, RequestCredentialInputRequest, ResolveUrlBoundCredentialRequest, StoredCredentialSummary, StoreUrlBoundCredentialRequest, UrlAudience, } from "@natstack/shared/credentials/types";
export type { ClientConfigStatus, ConfigureClientRequest, ConnectCredentialRequest, CredentialAccessGrantSummary, CredentialAccessSubjectSummary, CredentialBinding, CredentialBindingUse, CredentialGrantResourceHint, CredentialInjection, DeleteClientConfigRequest, GetClientConfigStatusRequest, GrantUrlBoundCredentialRequest, ManagedCredentialSummary, ProxyGitHttpRequest, ProxyGitHttpResponse, RequestCredentialInputRequest, ResolveUrlBoundCredentialRequest, StoredCredentialSummary, StoreUrlBoundCredentialRequest, UrlAudience, } from "@natstack/shared/credentials/types";
export interface CredentialClient {
    store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
    connect(input: ConnectCredentialRequest): Promise<StoredCredentialSummary>;
    configureClient(input: ConfigureClientRequest): Promise<ClientConfigStatus>;
    requestCredentialInput(input: RequestCredentialInputRequest): Promise<StoredCredentialSummary>;
    getClientConfigStatus(input: GetClientConfigStatusRequest): Promise<ClientConfigStatus>;
    deleteClientConfig(input: DeleteClientConfigRequest | string): Promise<void>;
    listStoredCredentials(): Promise<StoredCredentialSummary[]>;
    inspectStoredCredentials(): Promise<ManagedCredentialSummary[]>;
    revokeCredential(credentialId: string): Promise<void>;
    resolveCredential(input: ResolveUrlBoundCredentialRequest): Promise<StoredCredentialSummary | null>;
    fetch(url: string | URL, init?: RequestInit, opts?: {
        credentialId?: string;
    }): Promise<Response>;
    hookForUrl(url: string | URL, opts?: {
        credentialId?: string;
    }): (init?: RequestInit) => Promise<Response>;
    gitHttp(opts?: {
        credentialId?: string;
    }): GitHttpClient;
    /**
     * Resolve a URL-bound credential by walking a list of candidate
     * audiences and return a fetch handle pre-bound to whichever
     * credential matched first. Throws if no credential matches.
     *
     * Integrations (Gmail, Calendar, GitHub, …) use this as their
     * entrypoint: pass the descriptor, get back a handle, call
     * `handle.fetch(path)` without thinking about credentialId
     * resolution.
     *
     * If `descriptor.credentialId` is set, that specific credential is
     * required; otherwise the first audience match wins. The optional
     * `label` is used only for the "no credential found" error
     * message — pass the human-readable provider name.
     */
    forAudience(descriptor: UrlAudienceDescriptor): Promise<UrlCredentialHandle>;
}
/**
 * Minimal descriptor consumed by `CredentialClient.forAudience`.
 * Integration packages can extend this with display metadata
 * (id / displayName / providerId) for their own UIs without the
 * runtime caring about those fields.
 */
export interface UrlAudienceDescriptor {
    audiences: UrlAudience[];
    credentialId?: string;
    /** Human-readable name used in "no credential found" error messages. */
    label?: string;
}
/**
 * Fetch handle pre-bound to a specific URL-credential. `fetch` injects
 * the credential automatically — callers don't pass `credentialId`.
 * `credentialId` is exposed for cases that need to refer to the
 * credential elsewhere (push-state correlation, audit, etc.).
 */
export interface UrlCredentialHandle {
    credentialId: string;
    fetch(url: string | URL, init?: RequestInit): Promise<Response>;
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
            return rpc.call<StoredCredentialSummary>("main", "credentials.storeCredential", [input]);
        },
        async connect(input) {
            return rpc.call<StoredCredentialSummary>("main", "credentials.connect", [input]);
        },
        async configureClient(input) {
            return rpc.call<ClientConfigStatus>("main", "credentials.configureClient", [input]);
        },
        async requestCredentialInput(input) {
            return rpc.call<StoredCredentialSummary>("main", "credentials.requestCredentialInput", [input]);
        },
        async getClientConfigStatus(input) {
            return rpc.call<ClientConfigStatus>("main", "credentials.getClientConfigStatus", [input]);
        },
        async deleteClientConfig(input) {
            const request = typeof input === "string" ? { configId: input } : input;
            await rpc.call<void>("main", "credentials.deleteClientConfig", [request]);
        },
        async listStoredCredentials() {
            return rpc.call<StoredCredentialSummary[]>("main", "credentials.listStoredCredentials", []);
        },
        async inspectStoredCredentials() {
            return rpc.call<ManagedCredentialSummary[]>("main", "credentials.inspectStoredCredentials", []);
        },
        async revokeCredential(credentialId) {
            await rpc.call<void>("main", "credentials.revokeCredential", [{ credentialId }]);
        },
        async resolveCredential(input) {
            return rpc.call<StoredCredentialSummary | null>("main", "credentials.resolveCredential", [input]);
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
        async forAudience(descriptor) {
            const credential = await resolveByAudienceList(this, descriptor);
            if (!credential) {
                const label = descriptor.label ?? descriptor.audiences[0]?.url ?? "<unknown>";
                const where = descriptor.audiences.map((a) => a.url).join(", ");
                throw new Error(`No URL-bound credential found for ${label}. Store one with an audience matching ${where}.`);
            }
            const credentialId = credential.id;
            return {
                credentialId,
                fetch: (url, init) => proxyFetch(rpc, url, init, { credentialId }),
            };
        },
    };
}
/**
 * Walk a list of candidate audiences and return the first credential
 * that matches one of them (or null if none do). Honors an explicit
 * `credentialId` pin in the descriptor.
 */
async function resolveByAudienceList(client: Pick<CredentialClient, "resolveCredential">, descriptor: UrlAudienceDescriptor): Promise<StoredCredentialSummary | null> {
    for (const audience of descriptor.audiences) {
        const credential = await client.resolveCredential({
            url: audience.url,
            credentialId: descriptor.credentialId,
        });
        if (credential)
            return credential;
    }
    return null;
}
function createGitHttpClient(rpc: RpcCaller, opts?: {
    credentialId?: string;
}): GitHttpClient {
    return {
        async request(request) {
            const body = request.body ? await collectGitBody(request.body) : undefined;
            const result = await rpc.call<ProxyGitHttpResponse>("main", "credentials.proxyGitHttp", [{
                    url: request.url,
                    method: request.method ?? "GET",
                    headers: request.headers ?? {},
                    bodyBase64: body ? bytesToBase64(body) : undefined,
                    credentialId: opts?.credentialId,
                } satisfies ProxyGitHttpRequest]);
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
async function proxyFetch(rpc: RpcCaller, url: string | URL, init?: RequestInit, opts?: {
    credentialId?: string;
}): Promise<Response> {
    // Build a real Request so the platform synthesizes Content-Type for
    // string / URLSearchParams / Blob bodies the same way native fetch
    // does. Otherwise credentialed POSTs of those bodies would arrive
    // upstream with no Content-Type and servers would reject them.
    const requestedUrl = url.toString();
    const probe = new Request(requestedUrl, init);
    const headers = Object.fromEntries(probe.headers.entries());
    const encoded = await encodeRequestBody(init?.body);
    const args = {
        url: requestedUrl,
        method: init?.method ?? "GET",
        headers,
        body: encoded.body,
        bodyBase64: encoded.bodyBase64,
        credentialId: opts?.credentialId,
    };
    // Every client has `stream` — HTTP delivers real streaming via
    // `/rpc/stream`; transport-based bridges wrap their buffered call
    // in a uniform Response API. Callers don't branch on transport.
    const response = await rpc.stream("main", "credentials.proxyFetch", [args], { signal: init?.signal ?? undefined });
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
        }
        catch {
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
async function encodeRequestBody(body: BodyInit | null | undefined): Promise<{
    body?: string;
    bodyBase64?: string;
}> {
    if (body === undefined || body === null)
        return {};
    if (typeof body === "string")
        return { body };
    if (body instanceof URLSearchParams)
        return { body: body.toString() };
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
    throw new Error("credentials.fetch supports string, URLSearchParams, ArrayBuffer, typed-array, and Blob request bodies");
}

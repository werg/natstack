type RpcCallPayload = {
  method: string;
  args: unknown[];
};

type RpcResponse = {
  result?: unknown;
  error?: unknown;
  errorCode?: unknown;
};

type WorkerGlobals = typeof globalThis & {
  __natstack_rpc?: (payload: RpcCallPayload) => Promise<unknown>;
  __natstackEnv?: Record<string, string>;
};

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

async function callHostRpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const globals = globalThis as WorkerGlobals;
  const payload: RpcCallPayload = { method, args };

  if (typeof globals.__natstack_rpc === "function") {
    return globals.__natstack_rpc(payload) as Promise<T>;
  }

  const env = globals.__natstackEnv;
  const serverUrl = env?.["SERVER_URL"];
  if (!serverUrl) {
    throw new Error("NatStack worker RPC is unavailable: missing __natstack_rpc and SERVER_URL");
  }

  const authToken = env["RPC_AUTH_TOKEN"];
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  const response = await globalThis.fetch(`${serverUrl}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "call",
      targetId: "main",
      method,
      args,
    }),
  });

  const body = await response.json() as RpcResponse;
  if (body.error) {
    const error = new Error(String(body.error));
    if (typeof body.errorCode !== "undefined") {
      (error as Error & { code?: unknown }).code = body.errorCode;
    }
    throw error;
  }

  return body.result as T;
}

const client: CredentialClient = createCredentialClient({
  call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
    void targetId;
    return callHostRpc<T>(method, ...args);
  },
});

export async function store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary> {
  return client.store(input);
}

export async function beginCreateWithOAuthPkce(
  input: CreateOAuthPkceCredentialRequest,
): Promise<BeginOAuthPkceCredentialResult> {
  return client.beginCreateWithOAuthPkce(input);
}

export async function completeCreateWithOAuthPkce(
  input: CompleteOAuthPkceCredentialRequest,
): Promise<StoredCredentialSummary> {
  return client.completeCreateWithOAuthPkce(input);
}

export async function listStoredCredentials(): Promise<StoredCredentialSummary[]> {
  return client.listStoredCredentials();
}

export async function revokeCredential(credentialId: string): Promise<void> {
  await client.revokeCredential(credentialId);
}

export async function grantCredential(input: GrantUrlBoundCredentialRequest): Promise<StoredCredentialSummary> {
  return client.grantCredential(input);
}

export async function resolveCredential(
  input: ResolveUrlBoundCredentialRequest,
): Promise<StoredCredentialSummary | null> {
  return client.resolveCredential(input);
}

export async function fetch(
  url: string | URL,
  init?: RequestInit,
  opts?: { credentialId?: string },
): Promise<Response> {
  return client.fetch(url, init, opts);
}

export function hookForUrl(
  url: string | URL,
  opts?: { credentialId?: string },
): (init?: RequestInit) => Promise<Response> {
  return client.hookForUrl(url, opts);
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

type RpcCallPayload = {
  method: string;
  args: unknown[];
};

type RpcResponse = {
  result?: unknown;
  error?: unknown;
  errorCode?: unknown;
};

type ConsentRpcResult = {
  connectionId: string;
  apiBase: string[];
};

type WorkerGlobals = typeof globalThis & {
  __natstack_rpc?: (payload: RpcCallPayload) => Promise<unknown>;
  __natstackEnv?: Record<string, string>;
};

const CONNECTION_HEADER = "X-Natstack-Connection";

export type CredentialHandle = {
  connectionId: string;
  apiBase: string[];
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
};

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

  const response = await fetch(`${serverUrl}/rpc`, {
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

function parseConsentResult(value: unknown): ConsentRpcResult {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid credentials.requestConsent response");
  }

  const result = value as Record<string, unknown>;
  const connectionId = result["connectionId"];
  const apiBase = result["apiBase"];

  if (typeof connectionId !== "string") {
    throw new Error("Invalid credentials.requestConsent response: connectionId must be a string");
  }
  if (!Array.isArray(apiBase) || apiBase.some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid credentials.requestConsent response: apiBase must be a string[]");
  }

  return {
    connectionId,
    apiBase: [...apiBase],
  };
}

export async function requestConsent(
  providerId: string,
  opts?: { scopes?: string[]; accountHint?: string; role?: string },
): Promise<CredentialHandle> {
  const result = parseConsentResult(
    await callHostRpc("credentials.requestConsent", { providerId, ...opts }),
  );

  return {
    connectionId: result.connectionId,
    apiBase: result.apiBase,
    fetch: (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set(CONNECTION_HEADER, result.connectionId);
      return fetch(url, {
        ...init,
        headers,
      });
    },
  };
}

export async function revokeConsent(
  providerId: string,
  connectionId?: string,
): Promise<void> {
  await callHostRpc("credentials.revokeConsent", { providerId, connectionId });
}

import type { RpcCaller } from "@natstack/rpc";

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

export async function callWorkerHostRpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const globals = globalThis as WorkerGlobals;
  const payload: RpcCallPayload = { method, args };

  if (typeof globals.__natstack_rpc === "function") {
    return globals.__natstack_rpc(payload) as Promise<T>;
  }

  const env = globals.__natstackEnv;
  const serverUrl = env?.["GATEWAY_URL"];
  if (!serverUrl) {
    throw new Error("NatStack worker RPC is unavailable: missing __natstack_rpc and GATEWAY_URL");
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

export const workerHostRpcCaller: RpcCaller = {
  call<T>(_targetId: string, method: string, ...args: unknown[]): Promise<T> {
    return callWorkerHostRpc<T>(method, ...args);
  },
};

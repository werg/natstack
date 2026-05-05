import type { RpcBridge } from "@natstack/rpc";

let _rpc: RpcBridge | null = null;

export function _initOAuthBridge(rpc: RpcBridge): void {
  _rpc = rpc;
}

function getRpc(): RpcBridge {
  if (!_rpc) throw new Error("OAuth bridge not initialized");
  return _rpc;
}

export async function createLoopbackCallback(opts: {
  host?: string;
  port?: number;
  callbackPath?: string;
} = {}): Promise<{
  redirectUri: string;
  expectState(state: string): Promise<void>;
  waitForCallback(): Promise<{ code: string; state: string; url: string }>;
  close(): Promise<void>;
}> {
  const rpc = getRpc();
  const created = await rpc.call<{ callbackId: string; redirectUri: string }>(
    "main",
    "oauthLoopback.createLoopbackCallback",
    opts,
  );
  return {
    redirectUri: created.redirectUri,
    expectState(state) {
      return rpc.call<void>(
        "main",
        "oauthLoopback.expectLoopbackCallbackState",
        { callbackId: created.callbackId, state },
      );
    },
    waitForCallback() {
      return rpc.call<{ code: string; state: string; url: string }>(
        "main",
        "oauthLoopback.waitForLoopbackCallback",
        created.callbackId,
      );
    },
    async close() {
      await rpc.call<void>("main", "oauthLoopback.closeLoopbackCallback", created.callbackId);
    },
  };
}

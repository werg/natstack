/**
 * SandboxConfig factories for non-panel contexts (workers, Node.js headless).
 *
 * These wrap the raw RPC handle returned by db.open into a proper DbHandle
 * proxy, matching the pattern used by the panel runtime's createDbClient().
 */

import type { DbHandle } from "@workspace/eval";
import type { SandboxConfig } from "@workspace/agentic-core";

interface RpcLike {
  call(target: string, method: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * Wrap a raw database handle string (returned by `rpc.call("main", "db.open")`)
 * into a DbHandle-compatible proxy that delegates exec/run/get/query/close
 * back through RPC.
 */
function createRpcDbProxy(rpc: RpcLike, handle: string): DbHandle {
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Database connection is closed");
  };
  return {
    async exec(sql: string): Promise<void> {
      assertOpen();
      await rpc.call("main", "db.exec", handle, sql);
    },
    async run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
      assertOpen();
      return rpc.call("main", "db.run", handle, sql, params) as Promise<{ changes: number; lastInsertRowid: number | bigint }>;
    },
    async get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null | undefined> {
      assertOpen();
      return rpc.call("main", "db.get", handle, sql, params) as Promise<T | null | undefined>;
    },
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      assertOpen();
      return rpc.call("main", "db.query", handle, sql, params) as Promise<T[]>;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await rpc.call("main", "db.close", handle);
    },
  };
}

/**
 * Create a SandboxConfig for worker/DO contexts.
 *
 * Uses the worker's RPC bridge for all three capabilities.
 * db.open returns a raw handle string from the main process, which
 * is wrapped into a DbHandle proxy.
 */
export function createWorkerSandboxConfig(rpc: RpcLike): SandboxConfig {
  return {
    rpc: { call: (t: string, m: string, ...a: unknown[]) => rpc.call(t, m, ...a) },
    loadImport: async (specifier: string, ref: string | undefined, externals: string[]) => {
      if (ref?.startsWith("npm:")) {
        const version = ref.slice(4) || "latest";
        const result = await rpc.call("main", "build.getBuildNpm", specifier, version, externals) as { bundle: string };
        return result.bundle;
      }
      const result = await rpc.call("main", "build.getBuild", specifier, ref, { library: true, externals }) as { bundle: string };
      return result.bundle;
    },
    db: {
      async open(name: string): Promise<DbHandle> {
        const handle = await rpc.call("main", "db.open", name) as string;
        return createRpcDbProxy(rpc, handle);
      },
    },
  };
}

/**
 * Create a SandboxConfig for Node.js headless server contexts.
 *
 * Uses a direct RPC client connection. Same loadImport and db wrapping logic.
 */
export function createNodeSandboxConfig(rpcClient: RpcLike): SandboxConfig {
  return {
    rpc: { call: (t: string, m: string, ...a: unknown[]) => rpcClient.call(t, m, ...a) },
    loadImport: async (specifier: string, ref: string | undefined, externals: string[]) => {
      if (ref?.startsWith("npm:")) {
        const version = ref.slice(4) || "latest";
        const result = await rpcClient.call("main", "build.getBuildNpm", specifier, version, externals) as { bundle: string };
        return result.bundle;
      }
      const result = await rpcClient.call("main", "build.getBuild", specifier, ref, { library: true, externals }) as { bundle: string };
      return result.bundle;
    },
    db: {
      async open(name: string): Promise<DbHandle> {
        const handle = await rpcClient.call("main", "db.open", name) as string;
        return createRpcDbProxy(rpcClient, handle);
      },
    },
  };
}

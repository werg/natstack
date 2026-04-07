/**
 * SandboxConfig factory for non-panel contexts (workers, Node.js servers).
 *
 * Given any RPC bridge that can reach the main process's `build.*` and `db.*`
 * services, produce a SandboxConfig that satisfies the eval substrate.
 *
 * The other half of the eval substrate — `__natstackRequire__` and the
 * ambient module map — is set up at worker bundle boot by the build system
 * (see `src/server/buildV2/builder.ts buildWorker` + the worker's
 * `natstack.exposeModules` manifest entry). This factory therefore only needs
 * to provide the I/O surfaces (`rpc`, `db`, `loadImport`); the require side
 * is already in place by the time eval runs.
 *
 * Worker DOs use their workerd RPC bridge here; standalone Node servers use
 * a direct RPC client. Both implement the same `RpcLike` shape and produce
 * the same SandboxConfig — there is no per-context branching.
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
 * Create a SandboxConfig for non-panel contexts.
 *
 * Routes `loadImport` to `main`'s build service, wraps `db.open` results in a
 * DbHandle proxy that delegates back through RPC, and exposes the same RPC
 * bridge for direct calls. Same shape regardless of whether the caller is a
 * workerd DO or a Node server.
 */
export function createRpcSandboxConfig(rpc: RpcLike): SandboxConfig {
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

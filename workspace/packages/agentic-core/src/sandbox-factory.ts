/**
 * SandboxConfig factory for panel contexts.
 *
 * Worker and Node.js factories live in @workspace/agentic-session
 * (they need DbHandle from @workspace/eval which is a heavier dep).
 */

import type { DbHandle } from "@workspace/eval";
import type { SandboxConfig } from "./types.js";

interface RpcLike {
  call(target: string, method: string, ...args: unknown[]): Promise<unknown>;
}

interface DbLike {
  open(name: string): Promise<DbHandle>;
}

/**
 * Create a SandboxConfig for panel contexts.
 *
 * Extracts the inline wiring that was previously in chat/index.tsx:248-263
 * into a reusable function. Both workspace and npm imports go through RPC
 * to the build service on the main process.
 */
export function createPanelSandboxConfig(rpc: RpcLike, db: DbLike): SandboxConfig {
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
    db: { open: (name: string) => db.open(name) },
  };
}

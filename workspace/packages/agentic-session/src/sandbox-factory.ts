import type { SandboxConfig } from "@workspace/agentic-core";

interface RpcLike {
  call(target: string, method: string, ...args: unknown[]): Promise<unknown>;
}

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
  };
}


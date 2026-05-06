/**
 * Hello Worker — sample workerd worker demonstrating NatStack runtime integration.
 *
 * Shows: fs access, workspace tree, and basic HTTP handling.
 */

import { createWorkerRuntime, handleWorkerRpc } from "@workspace/runtime/worker";
import type { WorkerEnv, ExecutionContext } from "@workspace/runtime/worker";

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);

    // Handle incoming RPC calls
    const rpcResponse = await handleWorkerRpc(runtime, request);
    if (rpcResponse) return rpcResponse;

    const url = new URL(request.url);

    if (url.pathname === "/tree") {
      const tree = await runtime.getWorkspaceTree();
      return new Response(JSON.stringify(tree, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/readfile") {
      const filePath = url.searchParams.get("path") ?? "/package.json";
      try {
        const content = await runtime.fs.readFile(filePath, "utf8");
        return new Response(content as string, {
          headers: { "Content-Type": "text/plain" },
        });
      } catch (err) {
        return new Response(`Error: ${err}`, { status: 500 });
      }
    }

    return new Response(`Hello from NatStack Worker!\n\nRoutes:\n  /tree - workspace tree\n  /readfile?path=/package.json - read a file\n`, {
      headers: { "Content-Type": "text/plain" },
    });
  },
};

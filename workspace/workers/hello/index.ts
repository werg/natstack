/**
 * Hello Worker — sample workerd worker demonstrating NatStack runtime integration.
 *
 * Shows: fs access, database, workspace tree, and basic HTTP handling.
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

    if (url.pathname === "/db") {
      const db = await runtime.db.open("hello-worker-test");
      await db.exec("CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, ts TEXT)");
      await db.run("INSERT INTO visits (ts) VALUES (?)", [new Date().toISOString()]);
      const count = await db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM visits");
      await db.close();
      return new Response(`Visit count: ${count?.cnt ?? 0}`, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    return new Response(`Hello from NatStack Worker!\n\nRoutes:\n  /tree - workspace tree\n  /readfile?path=/package.json - read a file\n  /db - database demo\n`, {
      headers: { "Content-Type": "text/plain" },
    });
  },
};

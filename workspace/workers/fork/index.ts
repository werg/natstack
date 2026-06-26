/**
 * Fork Worker — stateless fetch handler that orchestrates semantic conversation forks.
 *
 * Uses platform primitives via RPC:
 * - `runtime.callMain("runtime.cloneContext", ...)` clones the channel + kept agents
 *   into a fresh isolated context (storage + file snapshot), gated by context.boundary
 * - `runtime.callMain("runtime.destroyContext", ...)` for rollback cleanup
 * - `runtime.rpc.call("do:source:className:objectKey", method, ...args)` for DO method calls
 */

import { createWorkerRuntime, handleWorkerRpc } from "@workspace/runtime/worker";
import type { WorkerEnv, ExecutionContext } from "@workspace/runtime/worker";
import { fork, type ForkOpts } from "@workspace/channel-fork";

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);

    // Handle incoming RPC calls
    const rpcResponse = await handleWorkerRpc(runtime, request);
    if (rpcResponse) return rpcResponse;

    const url = new URL(request.url);

    if (url.pathname === "/fork" && request.method === "POST") {
      const opts = (await request.json()) as ForkOpts;
      try {
        const result = await fork(runtime, opts);
        return Response.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    return new Response("Fork worker. POST /fork to fork a channel.", { status: 200 });
  },
};

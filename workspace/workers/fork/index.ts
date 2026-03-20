/**
 * Fork Worker — stateless fetch handler that orchestrates semantic conversation forks.
 *
 * Uses platform primitives:
 * - `runtime.callMain("workerd.cloneDO", ...)` for filesystem SQLite clones
 * - `runtime.callMain("workerd.destroyDO", ...)` for rollback cleanup
 * - `fetch(workerdUrl + "/_w/...")` for DO method calls (same as postToDO)
 */

import { createWorkerRuntime } from "@workspace/runtime/worker";
import type { WorkerEnv, ExecutionContext } from "@workspace/runtime/worker";
import { fork } from "./fork.js";
import type { ForkOpts } from "./fork.js";

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/fork" && request.method === "POST") {
      const opts = await request.json() as ForkOpts;
      const runtime = createWorkerRuntime(env);
      const workerdPort = await runtime.callMain<number | null>("workerd.getPort");
      if (!workerdPort) {
        return Response.json({ error: "workerd not running" }, { status: 503 });
      }
      try {
        const result = await fork(runtime, workerdPort, opts);
        return Response.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    return new Response("Fork worker. POST /fork to fork a channel.", { status: 200 });
  },
};

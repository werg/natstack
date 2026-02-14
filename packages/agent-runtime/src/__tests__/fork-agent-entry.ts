/**
 * Minimal agent entry point for fork integration testing.
 *
 * This script is bundled by esbuild and spawned via child_process.fork()
 * in ipc-fork.test.ts. It validates the full IPC lifecycle:
 *   init → ready → RPC echo → shutdown → shutdown-complete → exit(0)
 *
 * Intentionally avoids runAgent() and its heavy dependencies (pubsub, DB, AI)
 * to focus on the IPC abstraction layer.
 */

import { getAgentIpcChannel } from "../ipc-channel.js";
import { createIpcTransport } from "../ipc-transport.js";
import { isParentPortEnvelope, type ParentPortEnvelope } from "../transport.js";
import type { RpcMessage } from "@natstack/rpc";

const SELF_ID = "agent:test-fork:handle";

const ipc = getAgentIpcChannel();
ipc.ref?.();

// Phase 1: Wait for init, send ready
ipc.on("message", (msg) => {
  if (typeof msg !== "object" || msg === null) return;
  const m = msg as Record<string, unknown>;

  if (m["type"] === "init") {
    ipc.postMessage({ type: "ready" });
    return;
  }

  if (m["type"] === "shutdown") {
    ipc.postMessage({ type: "shutdown-complete" });
    // Small delay to ensure message is flushed before exit
    setTimeout(() => process.exit(0), 10);
  }
});

// Phase 2: Set up RPC transport — echo requests back as responses
const transport = createIpcTransport(ipc, SELF_ID);

transport.onAnyMessage((sourceId, message) => {
  if (message.type === "request") {
    const req = message as Extract<RpcMessage, { type: "request" }>;
    const response: RpcMessage = {
      type: "response",
      requestId: req.requestId,
      result: { echo: true, method: req.method, args: req.args },
    };
    void transport.send(sourceId, response);
  }
});

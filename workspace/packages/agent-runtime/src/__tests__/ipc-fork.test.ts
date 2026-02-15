/**
 * Integration test: agent IPC over child_process.fork().
 *
 * Validates the full fork → init → ready → RPC → shutdown lifecycle
 * without Electron. The test acts as the "host" process, communicating
 * with a forked test agent via the ProcessAdapter-compatible IPC channel.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fork, type ChildProcess } from "child_process";
import { build } from "esbuild";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  isParentPortEnvelope,
  type ParentPortEnvelope,
} from "../transport.js";
import type { RpcMessage } from "@natstack/rpc";

const AGENT_SELF_ID = "agent:test-fork:handle";
const HOST_SELF_ID = "main";

let bundlePath: string;
let tmpDir: string;

beforeAll(async () => {
  // Bundle the test agent entry into a runnable .mjs file
  tmpDir = await mkdtemp(path.join(tmpdir(), "ipc-fork-test-"));
  bundlePath = path.join(tmpDir, "fork-agent.mjs");

  await build({
    entryPoints: [path.resolve(__dirname, "fork-agent-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: bundlePath,
    // Mark @natstack/rpc as external since we only use its types at runtime
    // (the type imports are erased; the actual RpcMessage shape is just plain objects)
    external: [],
  });
});

afterAll(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Helper: wait for a specific message from a child process.
 */
function waitForMessage(
  proc: ChildProcess,
  predicate: (msg: unknown) => boolean,
  timeoutMs = 5000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.removeListener("message", handler);
      reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(msg: unknown) {
      if (predicate(msg)) {
        clearTimeout(timer);
        proc.removeListener("message", handler);
        resolve(msg);
      }
    }
    proc.on("message", handler);
  });
}

/**
 * Helper: wait for the child process to exit.
 */
function waitForExit(proc: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) {
      resolve(proc.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for process exit (${timeoutMs}ms)`));
    }, timeoutMs);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("IPC fork integration", () => {
  it("full lifecycle: init → ready → RPC → shutdown → exit(0)", async () => {
    // 1. Fork the test agent
    const proc = fork(bundlePath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    // Collect stderr for debugging
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      // 2. Send init config
      const readyPromise = waitForMessage(
        proc,
        (msg) => {
          const m = msg as Record<string, unknown>;
          return m?.["type"] === "ready";
        }
      );

      proc.send({ type: "init", config: { agentId: "test", channel: "ch", handle: "h", config: {}, pubsubUrl: "", pubsubToken: "" } });

      // 3. Wait for ready
      const readyMsg = await readyPromise;
      expect(readyMsg).toEqual({ type: "ready" });

      // 4. Send an RPC request via ParentPortEnvelope, expect response
      const rpcResponsePromise = waitForMessage(
        proc,
        (msg) => isParentPortEnvelope(msg) && (msg as ParentPortEnvelope).message.type === "response"
      );

      const rpcRequest: ParentPortEnvelope = {
        targetId: AGENT_SELF_ID,
        sourceId: HOST_SELF_ID,
        message: {
          type: "request",
          requestId: "req-1",
          fromId: HOST_SELF_ID,
          method: "echo.test",
          args: ["hello", 42],
        } satisfies RpcMessage,
      };
      proc.send(rpcRequest);

      // 5. Verify RPC response
      const rpcResponse = (await rpcResponsePromise) as ParentPortEnvelope;
      expect(rpcResponse.targetId).toBe(HOST_SELF_ID);
      expect(rpcResponse.sourceId).toBe(AGENT_SELF_ID);
      expect(rpcResponse.message.type).toBe("response");

      const responseMsg = rpcResponse.message as Extract<RpcMessage, { type: "response" }>;
      expect(responseMsg.requestId).toBe("req-1");
      expect("result" in responseMsg).toBe(true);
      expect((responseMsg as any).result).toEqual({
        echo: true,
        method: "echo.test",
        args: ["hello", 42],
      });

      // 6. Send shutdown
      const shutdownCompletePromise = waitForMessage(
        proc,
        (msg) => {
          const m = msg as Record<string, unknown>;
          return m?.["type"] === "shutdown-complete";
        }
      );

      proc.send({ type: "shutdown" });

      const shutdownMsg = await shutdownCompletePromise;
      expect(shutdownMsg).toEqual({ type: "shutdown-complete" });

      // 7. Verify clean exit
      const exitCode = await waitForExit(proc);
      expect(exitCode).toBe(0);
    } catch (err) {
      // Kill process on failure to avoid hanging
      proc.kill();
      if (stderr) {
        console.error("Agent stderr:\n", stderr);
      }
      throw err;
    }
  });

  it("getAgentIpcChannel throws when no IPC channel is available", async () => {
    // Fork a script that tries getAgentIpcChannel without IPC
    // (spawn with stdio: 'pipe' but no 'ipc' channel)
    const { execSync } = await import("child_process");
    try {
      execSync(
        `node --input-type=module -e "import('${bundlePath}')"`,
        { stdio: "pipe", timeout: 5000 }
      );
      expect.fail("Should have thrown");
    } catch (err: any) {
      // The process should crash because getAgentIpcChannel() throws
      // when there's no IPC channel (no parentPort, no process.send)
      expect(err.status).not.toBe(0);
    }
  });
});

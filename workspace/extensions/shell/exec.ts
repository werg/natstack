import { spawn } from "node:child_process";
import { nodeSetTimeout } from "./nodeTimers.js";
import type { ExecRequest, ExecResult } from "./types.js";

function appendCapped(current: Buffer[], chunk: Buffer, maxBytes: number): { truncated: boolean } {
  const used = current.reduce((sum, item) => sum + item.byteLength, 0);
  const remaining = maxBytes - used;
  if (remaining <= 0) return { truncated: true };
  if (chunk.byteLength <= remaining) {
    current.push(chunk);
    return { truncated: false };
  }
  current.push(chunk.subarray(0, remaining));
  return { truncated: true };
}

export function runExec(req: Omit<ExecRequest, "cwd" | "env"> & { cwd: string; env: NodeJS.ProcessEnv }): Promise<ExecResult> {
  const started = Date.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let truncated = false;
  let timedOut = false;

  return new Promise((resolve, reject) => {
    const child = req.shell
      ? spawn("/bin/sh", ["-c", [req.command, ...req.args].join(" ")], {
        cwd: req.cwd,
        env: req.env,
        stdio: ["pipe", "pipe", "pipe"],
      })
      : spawn(req.command, req.args, {
        cwd: req.cwd,
        env: req.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

    const timeout = nodeSetTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      nodeSetTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref();
    }, req.timeoutMs);
    timeout.unref();

    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      truncated = appendCapped(stdout, chunk, req.maxOutputBytes).truncated || truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      truncated = appendCapped(stderr, chunk, req.maxOutputBytes).truncated || truncated;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - started,
        ...(timedOut ? { timedOut } : {}),
        ...(truncated ? { truncated } : {}),
      });
    });
    if (req.stdin) child.stdin.end(req.stdin);
    else child.stdin.end();
  });
}

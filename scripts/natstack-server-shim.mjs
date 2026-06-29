#!/usr/bin/env node
// `natstack-server` bin for the npm-published packages. Pins NATSTACK_APP_ROOT
// to the installed package root so getAppRoot()/getPackagesDir()/template lookup
// resolve against the package rather than the user's shell cwd (the standalone
// server otherwise defaults NATSTACK_APP_ROOT to process.cwd() — see
// src/server/index.ts:506), then runs the bundled headless server.
import { spawn } from "node:child_process";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env };
if (!env["NATSTACK_APP_ROOT"]) env["NATSTACK_APP_ROOT"] = packageRoot;

const server = path.join(packageRoot, "dist", "server.mjs");
const child = spawn(process.execPath, [server, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

const signalHandlers = [];
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    if (!child.killed) child.kill(signal);
  };
  signalHandlers.push([signal, handler]);
  process.on(signal, handler);
}
child.on("exit", (code, signal) => {
  for (const [forwardedSignal, handler] of signalHandlers) {
    process.off(forwardedSignal, handler);
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

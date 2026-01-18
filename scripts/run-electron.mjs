import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");

const extraArgs = process.argv.slice(2);
const args = [".", ...extraArgs];

const child = spawn(electronBinary, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    // Increase Node.js memory limit for main process (4GB)
    NODE_OPTIONS: "--max-old-space-size=4096",
  },
});

// Forward signals to the Electron process for proper shutdown
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");

const extraArgs = process.argv.slice(2);
const args = [];

const rendererMaxOldSpace = Number.parseInt(
  process.env.NATSTACK_RENDERER_MAX_OLD_SPACE_MB ?? "",
  10
);
if (Number.isFinite(rendererMaxOldSpace) && rendererMaxOldSpace > 0) {
  args.push(`--js-flags=--max-old-space-size=${rendererMaxOldSpace}`);
}

args.push(".", ...extraArgs);

const child = spawn(electronBinary, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    // Increase Node.js memory limit for main process (3GB)
    NODE_OPTIONS: "--max-old-space-size=3072",
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

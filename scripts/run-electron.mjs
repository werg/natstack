import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");

// Check if --no-sandbox flag is needed (for development environments where sandbox doesn't work)
// Pass ELECTRON_NO_SANDBOX=1 environment variable to disable sandbox
const extraArgs = process.argv.slice(2);
const args = [".", ...extraArgs];
if (process.env.ELECTRON_NO_SANDBOX === "1") {
  console.warn("⚠️  Running with --no-sandbox (security reduced). Only use in development!");
  args.unshift("--no-sandbox");
}

const child = spawn(electronBinary, args, {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

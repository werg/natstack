import { spawn } from "node:child_process";
import process from "node:process";
import { resolveElectronExecutableForNatStack } from "./branded-electron.mjs";

const electronBinary = resolveElectronExecutableForNatStack();

const rawExtraArgs = process.argv.slice(2);
const autoApprove = rawExtraArgs.includes("--auto-approve");
const extraArgs = rawExtraArgs.filter((arg) => arg !== "--auto-approve");

function initialElectronArgs() {
  const args = [];
  const rendererMaxOldSpace = Number.parseInt(
    process.env.NATSTACK_RENDERER_MAX_OLD_SPACE_MB ?? "",
    10
  );
  if (Number.isFinite(rendererMaxOldSpace) && rendererMaxOldSpace > 0) {
    args.push(`--js-flags=--max-old-space-size=${rendererMaxOldSpace}`);
  }

  args.push(".", ...extraArgs);
  return args;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

let child = null;
const activeChildren = new Set();
let nextArgs = initialElectronArgs();

async function runElectron(args) {
  return new Promise((resolve) => {
    let relaunchArgs = null;
    let settled = false;
    const currentChild = spawn(electronBinary, args, {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        // Increase Node.js memory limit for main process (3GB)
        NODE_OPTIONS: "--max-old-space-size=3072",
        NATSTACK_DEV_RUNNER_IPC: "1",
        ...(autoApprove ? { NATSTACK_AUTO_APPROVE: "1" } : {}),
      },
    });
    child = currentChild;
    activeChildren.add(currentChild);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    currentChild.on("message", (message) => {
      if (message && message.type === "natstack:dev-relaunch" && isStringArray(message.args)) {
        relaunchArgs = message.args;
      }
    });

    currentChild.on("exit", (code, signal) => {
      activeChildren.delete(currentChild);
      if (child === currentChild) child = null;
      finish({ code, signal, relaunchArgs });
    });
  });
}

// Forward signals to the active Electron process for proper shutdown.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    for (const activeChild of activeChildren) {
      if (!activeChild.killed) {
        activeChild.kill(signal);
      }
    }
  });
}

for (;;) {
  const result = await runElectron(nextArgs);
  if (result.relaunchArgs) {
    nextArgs = result.relaunchArgs;
    continue;
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.code ?? 0);
  }
}

/**
 * Launch headless Chromium with a loopback-only CDP endpoint (port 0) and
 * parse the DevTools WebSocket URL from stderr.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("HeadlessHost:launch");

const WS_URL_PATTERN = /DevTools listening on (ws:\/\/[^\s]+)/;
const LAUNCH_TIMEOUT_MS = 30_000;

export interface LaunchedChromium {
  wsEndpoint: string;
  process: ChildProcess;
  kill(): void;
}

export async function launchChromium(opts: {
  executablePath: string;
  profileDir: string;
  extraArgs?: string[];
}): Promise<LaunchedChromium> {
  fs.mkdirSync(opts.profileDir, { recursive: true });
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--mute-audio",
    "--window-size=1280,800",
    ...(opts.extraArgs ?? []),
  ];
  const child = spawn(opts.executablePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Chromium did not report a DevTools endpoint within ${LAUNCH_TIMEOUT_MS}ms:\n${stderr.slice(-2000)}`));
    }, LAUNCH_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = WS_URL_PATTERN.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited (code ${code}) before reporting an endpoint:\n${stderr.slice(-2000)}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  log.info(`Chromium up: ${wsEndpoint}`);
  return {
    wsEndpoint,
    process: child,
    kill: () => {
      if (!child.killed) child.kill("SIGKILL");
    },
  };
}

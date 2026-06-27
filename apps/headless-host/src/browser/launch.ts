/**
 * Launch headless Chromium with a loopback-only CDP endpoint (port 0) and
 * parse the DevTools WebSocket URL from stderr.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("HeadlessHost:launch");

const WS_URL_PATTERN = /DevTools listening on (ws:\/\/[^\s]+)/;
const LAUNCH_TIMEOUT_MS = 30_000;

export interface LaunchedChromium {
  wsEndpoint: string;
  process: ChildProcess;
  kill(): void;
}

function snapNameFromExecutablePath(executablePath: string): string | null {
  const normalized = path.resolve(executablePath);
  if (path.dirname(normalized) !== "/snap/bin") return null;
  return path.basename(normalized) || null;
}

function isHiddenHomePath(candidate: string, homeDir: string): boolean {
  const relative = path.relative(homeDir, path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).some((segment) => segment.startsWith("."));
}

export function resolveChromiumProfileDir(opts: {
  executablePath: string;
  profileDir: string;
  homeDir?: string;
}): string {
  const homeDir = opts.homeDir ?? os.homedir();
  const snapName = snapNameFromExecutablePath(opts.executablePath);
  if (!snapName || !isHiddenHomePath(opts.profileDir, homeDir)) return opts.profileDir;
  return path.join(homeDir, "snap", snapName, "common", "natstack", "headless-host");
}

export async function launchChromium(opts: {
  executablePath: string;
  profileDir: string;
  extraArgs?: string[];
}): Promise<LaunchedChromium> {
  const profileDir = resolveChromiumProfileDir({
    executablePath: opts.executablePath,
    profileDir: opts.profileDir,
  });
  if (profileDir !== opts.profileDir) {
    log.info(`Using snap-accessible Chromium profile dir: ${profileDir}`);
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
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

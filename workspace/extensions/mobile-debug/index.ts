import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@natstack/extension";
import type { ApprovalDetailFormat } from "@natstack/shared/approvals";

export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@natstack/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/mobile-debug": Api;
  }
}

const defaultPackage = "com.natstack.mobile.internal";
const defaultActivity = "com.natstack.mobile.MainActivity";

class MobileDebugError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MobileDebugError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function activate(ctx: ExtensionContext) {
  const workspace = await ctx.workspace.getInfo();
  if (!tryResolveRepoRoot(workspace.path)) {
    ctx.health.degraded({
      summary: "Mobile debug activated without a NatStack repo root",
      reasons: ["Build and install helpers require a checkout containing apps/mobile/android."],
    });
  }
  return {
    async doctor() {
      const adb = await hasCommand("adb");
      const devices = adb ? await listAdbDevices() : [];
      const ready = devices.filter((device) => device.state === "device");
      const repoRoot = tryResolveRepoRoot(workspace.path);
      const apkPath = repoRoot ? defaultApkPath(repoRoot) : null;
      const issues: string[] = [];
      if (!repoRoot)
        issues.push("Could not locate NatStack repo root containing apps/mobile/android");
      if (!adb) issues.push("adb is not on PATH");
      if (devices.some((device) => device.state === "unauthorized"))
        issues.push("Accept the Android USB debugging prompt");
      if (ready.length === 0) issues.push("No ready Android device");
      if (ready.length > 1) issues.push("Multiple ready devices; pass a serial");
      if (apkPath && !fs.existsSync(apkPath)) issues.push("Internal APK has not been built");
      return { adb, device: ready[0], apkSigned: !!apkPath && fs.existsSync(apkPath), issues };
    },

    async listDevices() {
      return listAdbDevices();
    },

    async buildAndroid(raw?: { variant?: "internal" | "release" }) {
      const repoRoot = requireRepoRoot(workspace.path);
      const started = Date.now();
      const variant = raw?.variant ?? "internal";
      const gradleTask = variant === "release" ? "assembleRelease" : "assembleInternal";
      await run(path.join(repoRoot, "apps", "mobile", "android", "gradlew"), [gradleTask], {
        cwd: path.join(repoRoot, "apps", "mobile", "android"),
        errorCode: "EBUILD",
      });
      return {
        apkPath:
          variant === "release"
            ? path.join(
                repoRoot,
                "apps",
                "mobile",
                "android",
                "app",
                "build",
                "outputs",
                "apk",
                "release",
                "app-release.apk"
              )
            : defaultApkPath(repoRoot),
        durationMs: Date.now() - started,
      };
    },

    async installAndroid(raw?: {
      device?: string;
      apk?: string;
      resetApp?: boolean;
      launch?: boolean;
    }) {
      const repoRoot = requireRepoRoot(workspace.path);
      const args = [
        raw?.resetApp ? "--reset-app" : null,
        raw?.launch ? "--launch" : null,
        raw?.device ? "--device" : null,
        raw?.device ?? null,
        raw?.apk ? "--apk" : null,
        raw?.apk ?? null,
        raw?.apk ? "--no-build" : null,
      ].filter((value): value is string => !!value);
      const script = path.join(repoRoot, "scripts", "cli", "mobile-install.mjs");
      const command = formatCommand(process.execPath, [script, ...args]);
      await requireApproval(ctx, {
        id: `mobile.install.${raw?.device ?? "default"}`,
        title: "Install Android app",
        summary: [
          "Build/install runs app code on the attached Android device.",
          "",
          markdownShellBlock(command),
        ].join("\n"),
        details: [
          { label: "Command", value: markdownShellBlock(command), format: "markdown" },
          ...(raw?.device ? [{ label: "Device", value: raw.device }] : []),
          ...(raw?.apk ? [{ label: "APK", value: raw.apk }] : []),
        ],
      });
      await run(process.execPath, [script, ...args], { cwd: repoRoot });
      return { packageName: defaultPackage };
    },

    async launchAndroid(raw?: { device?: string; packageName?: string }) {
      await adb(raw?.device, ["shell", "monkey", "-p", raw?.packageName ?? defaultPackage, "1"]);
    },

    async clearAndroidApp(raw?: { device?: string; packageName?: string }) {
      const packageName = raw?.packageName ?? defaultPackage;
      const command = formatCommand(
        "adb",
        adbArgs(raw?.device, ["shell", "pm", "clear", packageName])
      );
      await requireApproval(ctx, {
        id: `mobile.clear.${raw?.device ?? "default"}.${packageName}`,
        title: "Clear Android app data",
        summary: [
          "This deletes the app's local pairing credentials and state.",
          "",
          markdownShellBlock(command),
        ].join("\n"),
        details: [
          { label: "Command", value: markdownShellBlock(command), format: "markdown" },
          { label: "Package", value: packageName },
          ...(raw?.device ? [{ label: "Device", value: raw.device }] : []),
        ],
      });
      await adb(raw?.device, ["shell", "pm", "clear", packageName]);
    },

    async adbReverse(raw: { device?: string; ports: Array<[number, number]> }) {
      for (const [devicePort, hostPort] of raw.ports) {
        await adb(raw.device, ["reverse", `tcp:${devicePort}`, `tcp:${hostPort}`]);
      }
    },

    async screenshot(raw?: { device?: string }) {
      const result = await adbCapture(raw?.device, ["exec-out", "screencap", "-p"]);
      return { pngBase64: Buffer.from(result.stdout, "binary").toString("base64") };
    },

    async verify(raw?: { device?: string; packageName?: string }) {
      const devices = await listAdbDevices();
      const device = pickDevice(devices, raw?.device);
      const packageName = raw?.packageName ?? defaultPackage;
      const packageInstalled = await adbExitOk(device.serial, ["shell", "pm", "path", packageName]);
      const issues: string[] = packageInstalled ? [] : [`${packageName} is not installed`];
      const rendering = packageInstalled
        ? await adbExitOk(device.serial, ["shell", "pidof", packageName])
        : false;
      let screenshot: Awaited<ReturnType<typeof adbCapture>> | null = null;
      if (rendering) {
        try {
          screenshot = await adbCapture(device.serial, ["exec-out", "screencap", "-p"]);
        } catch (error) {
          issues.push(
            `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return {
        installed: packageInstalled,
        bundleActive: rendering,
        rendering,
        screenshotPng: screenshot
          ? Buffer.from(screenshot.stdout, "binary").toString("base64")
          : undefined,
        issues,
      };
    },

    logcat(raw?: { device?: string; packageName?: string; filter?: string }) {
      const args = raw?.packageName ? ["shell", "pidof", raw.packageName] : null;
      const streamArgs = raw?.filter
        ? ["logcat", "-v", "time", raw.filter]
        : ["logcat", "-v", "time"];
      return streamAdb(raw?.device, args, streamArgs);
    },

    async shell(raw: { device?: string; command: string; args?: string[] }) {
      const command = formatCommand(
        "adb",
        adbArgs(raw.device, ["shell", raw.command, ...(raw.args ?? [])])
      );
      await requireApproval(ctx, {
        id: `mobile.shell.${raw.device ?? "default"}.${raw.command}`,
        title: "Run Android shell command",
        summary: [
          "Run this command on the attached Android device:",
          "",
          markdownShellBlock(command),
        ].join("\n"),
        details: [
          { label: "Command", value: markdownShellBlock(command), format: "markdown" },
          ...(raw.device ? [{ label: "Device", value: raw.device }] : []),
        ],
      });
      return streamProcess("adb", adbArgs(raw.device, ["shell", raw.command, ...(raw.args ?? [])]));
    },
  };
}

type ApprovalDetail = { label: string; value: string; format?: ApprovalDetailFormat };

async function requireApproval(
  ctx: ExtensionContext,
  raw: {
    id: string;
    title: string;
    summary: string;
    details?: ApprovalDetail[];
  }
) {
  const choice = await ctx.approvals.request({
    subject: { id: raw.id.replace(/[^A-Za-z0-9._:/-]/g, "-"), label: raw.title },
    title: raw.title,
    summary: truncate(raw.summary, 1000),
    ...(raw.details?.length
      ? {
          details: raw.details.map((detail) => ({
            ...detail,
            value: truncate(detail.value, 1000),
          })),
        }
      : {}),
    severity: "dangerous",
    defaultAction: "deny",
    promptOptions: "scoped",
  });
  if (choice.kind !== "choice" || choice.choice !== "allow") {
    throw new MobileDebugError("EACCES", `${raw.title} denied by user`);
  }
}

function markdownShellBlock(value: string): string {
  return `\`\`\`sh\n${truncate(value, 700).replace(/```/g, "'''")}\n\`\`\``;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuoteForDisplay).join(" ");
}

function shellQuoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

async function listAdbDevices(): Promise<
  Array<{ serial: string; state: "device" | "unauthorized" | "offline"; model?: string }>
> {
  const result = await adbCapture(undefined, ["devices", "-l"]);
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, stateRaw] = line.split(/\s+/, 2);
      const model = line.match(/\bmodel:([^\s]+)/)?.[1];
      const state = stateRaw === "device" || stateRaw === "unauthorized" ? stateRaw : "offline";
      return { serial: serial!, state, ...(model ? { model } : {}) };
    });
}

function isDesktopLocalHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "0.0.0.0" ||
    /^127\./.test(lower) ||
    lower === "::1" ||
    lower === "[::1]"
  );
}

// Loopback only — private-LAN / Tailscale / .local cleartext trust is
// decommissioned (the data plane is WebRTC; local is loopback). 10.0.2.2 is the
// Android emulator's host loopback alias.
function isLoopbackOrEmulatorHost(host: string): boolean {
  const lower = host.toLowerCase();
  return isDesktopLocalHost(lower) || lower === "10.0.2.2";
}

function pickDevice(devices: Array<{ serial: string; state: string }>, requested?: string) {
  if (requested) {
    const match = devices.find((device) => device.serial === requested);
    if (!match) throw new MobileDebugError("ENODEVICE", `adb does not see ${requested}`);
    if (match.state !== "device")
      throw new MobileDebugError("EUNAUTHORIZED", `${requested} is ${match.state}`);
    return match;
  }
  const ready = devices.filter((device) => device.state === "device");
  if (ready.length === 0 && devices.some((device) => device.state === "unauthorized")) {
    throw new MobileDebugError("EUNAUTHORIZED", "Accept the Android USB debugging prompt");
  }
  if (ready.length === 0) throw new MobileDebugError("ENODEVICE", "No ready Android device");
  if (ready.length > 1)
    throw new MobileDebugError("ENODEVICE", "Multiple Android devices; pass a serial");
  return ready[0]!;
}

function adbArgs(device: string | undefined, args: string[]): string[] {
  return device ? ["-s", device, ...args] : args;
}

async function adb(device: string | undefined, args: string[]) {
  await run("adb", adbArgs(device, args), { cwd: process.cwd() });
}

async function adbExitOk(device: string | undefined, args: string[]): Promise<boolean> {
  const result = await runCapture("adb", adbArgs(device, args), {
    cwd: process.cwd(),
    reject: false,
  });
  return result.exitCode === 0;
}

async function adbCapture(device: string | undefined, args: string[]) {
  const result = await runCapture("adb", adbArgs(device, args), {
    cwd: process.cwd(),
    encoding: "binary",
  });
  if (result.exitCode !== 0)
    throw new MobileDebugError("EADB", result.stderr || result.stdout || "adb failed");
  return result;
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    const result = await runCapture(command, ["version"], { cwd: process.cwd(), reject: false });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function run(
  command: string,
  args: string[],
  opts: { cwd: string; errorCode?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: process.env, stdio: "ignore" });
    const errorCode = opts.errorCode ?? "EADB";
    child.on("error", (error) => reject(new MobileDebugError(errorCode, error.message)));
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new MobileDebugError(errorCode, `${command} ${args.join(" ")} exited ${code}`))
    );
  });
}

function runCapture(
  command: string,
  args: string[],
  opts: { cwd: string; reject?: boolean; encoding?: BufferEncoding; errorCode?: string }
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errorCode = opts.errorCode ?? "EADB";
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => reject(new MobileDebugError(errorCode, error.message)));
    child.on("exit", (code) => {
      const result = {
        exitCode: code,
        stdout: Buffer.concat(stdout).toString(opts.encoding ?? "utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 || opts.reject === false) resolve(result);
      else
        reject(
          new MobileDebugError(errorCode, result.stderr || result.stdout || `${command} failed`)
        );
    });
  });
}

function streamAdb(
  device: string | undefined,
  pidProbeArgs: string[] | null,
  streamArgs: string[]
): Response {
  if (!pidProbeArgs) return streamProcess("adb", adbArgs(device, streamArgs));
  return streamAdbAfterPidProbe(device, pidProbeArgs, streamArgs);
}

function streamAdbAfterPidProbe(
  device: string | undefined,
  pidProbeArgs: string[],
  streamArgs: string[]
): Response {
  const encoder = new TextEncoder();
  let child: ReturnType<typeof spawn> | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const probe = spawn("adb", adbArgs(device, pidProbeArgs), {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = probe;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      probe.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      probe.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      probe.on("error", (err) => controller.error(err));
      probe.on("exit", (code) => {
        if (cancelled) return;
        const pid = firstPid(Buffer.concat(stdout).toString("utf8"));
        if (code !== 0 || !pid) {
          const message =
            Buffer.concat(stderr).toString("utf8").trim() || "package process is not running";
          controller.enqueue(encoder.encode(`${message}\n`));
          controller.close();
          return;
        }
        const scopedArgs = pidScopedLogcatArgs(streamArgs, pid);
        const streamChild = spawn("adb", adbArgs(device, scopedArgs), {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child = streamChild;
        streamChild.stdout?.on("data", (chunk) => controller.enqueue(Buffer.from(chunk)));
        streamChild.stderr?.on("data", (chunk) => controller.enqueue(encoder.encode(String(chunk))));
        streamChild.on("error", (err) => controller.error(err));
        streamChild.on("exit", () => controller.close());
      });
    },
    cancel() {
      cancelled = true;
      child?.kill("SIGTERM");
    },
  });
  return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
}

export function pidScopedLogcatArgs(streamArgs: string[], pid: string): string[] {
  if (streamArgs[0] !== "logcat") return streamArgs;
  return ["logcat", `--pid=${pid}`, ...streamArgs.slice(1)];
}

function firstPid(raw: string): string | null {
  return raw.split(/\s+/).find((part) => /^\d+$/.test(part)) ?? null;
}

function streamProcess(command: string, args: string[]): Response {
  const encoder = new TextEncoder();
  const child = spawn(command, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout?.on("data", (chunk) => controller.enqueue(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk) => controller.enqueue(encoder.encode(String(chunk))));
      child.on("error", (err) => controller.error(err));
      child.on("exit", () => controller.close());
    },
    cancel() {
      child.kill("SIGTERM");
    },
  });
  return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
}

function requireRepoRoot(workspacePath: string): string {
  const repoRoot = tryResolveRepoRoot(workspacePath);
  if (!repoRoot) throw new MobileDebugError("EBUILD", "Could not locate NatStack repo root");
  return repoRoot;
}

function tryResolveRepoRoot(workspacePath: string): string | null {
  let current = process.env["NATSTACK_REPO_ROOT"] ?? process.cwd();
  for (const start of [current, workspacePath]) {
    current = path.resolve(start);
    while (true) {
      if (fs.existsSync(path.join(current, "apps", "mobile", "android"))) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

function defaultApkPath(repoRoot: string): string {
  return path.join(
    repoRoot,
    "apps",
    "mobile",
    "android",
    "app",
    "build",
    "outputs",
    "apk",
    "internal",
    "app-internal.apk"
  );
}

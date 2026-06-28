import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@natstack/extension";
import type { ApprovalDetailFormat } from "@natstack/shared/approvals";
import type { Remote } from "@natstack/shared/remotes";

export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@natstack/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/mobile-debug": Api;
  }
}

const defaultPackage = "com.natstack.mobile.internal";
const defaultActivity = "com.natstack.mobile.MainActivity";
const pairingInviteTtlMs = 5 * 60_000;

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

    async connectToServer(raw: {
      device?: string;
      remoteId: string;
      workspace?: string;
      fire?: boolean;
    }) {
      await requireApproval(ctx, {
        id: `mobile.connect.${raw.remoteId}.${raw.device ?? "default"}`,
        title: "Pair Android device to server",
        summary: "This grants the attached phone a durable credential for the selected server.",
      });
      const device = pickDevice(await listAdbDevices(), raw.device);
      const remotes = await ctx.rpc.call<Remote[]>("main", "remoteCred.remotes.list");
      const remote = remotes.find((entry) => entry.id === raw.remoteId);
      if (!remote?.server)
        throw new MobileDebugError("EPAIR", `Remote ${raw.remoteId} has no server`);
      const resolution = await resolvePhoneReachableServerUrl(device.serial, remote);
      const invite = await ctx.rpc.call<{
        code: string;
        deepLink: string | null;
        connectUrl: string;
        serverUrl: string;
      }>("main", "remoteCred.createPairingInviteForRemote", {
        remoteId: raw.remoteId,
        ttlMs: pairingInviteTtlMs,
      });
      const deepLink = createConnectDeepLink(resolution.serverUrl, invite.code, raw.workspace);
      if (raw.fire !== false) {
        await adb(device.serial, [
          "shell",
          "am",
          "start",
          "-a",
          "android.intent.action.VIEW",
          "-d",
          deepLink,
        ]);
      }
      return {
        paired: raw.fire !== false,
        deviceId: device.serial,
        serverUrl: resolution.serverUrl,
        deepLink,
        qr: deepLink,
      };
    },

    async verify(raw?: { device?: string; remoteId?: string; packageName?: string }) {
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
      let serverReachable: boolean | undefined;
      let serverUrl: string | undefined;
      let paired: boolean | undefined;
      let deviceId: string | undefined;
      if (raw?.remoteId) {
        try {
          const remotes = await ctx.rpc.call<Remote[]>("main", "remoteCred.remotes.list");
          const remote = remotes.find((entry) => entry.id === raw.remoteId);
          if (!remote?.server)
            throw new MobileDebugError("EPAIR", `Remote ${raw.remoteId} has no server`);
          const resolution = await resolvePhoneReachableServerUrl(device.serial, remote);
          serverReachable = true;
          serverUrl = resolution.serverUrl;
          const identity = await readAndroidPublicIdentity(device.serial, packageName);
          if (!identity.deviceId) {
            paired = false;
            issues.push(
              identity.issue ??
                "Mobile app has no stored public device id; reconnect it to the server."
            );
          } else {
            deviceId = identity.deviceId;
            const serverDevices = await ctx.rpc.call<Array<{ deviceId: string }>>(
              "main",
              "remoteCred.listDevicesForRemote",
              { remoteId: raw.remoteId }
            );
            paired = serverDevices.some((record) => record.deviceId === identity.deviceId);
            if (!paired) {
              issues.push(
                `Mobile device ${identity.deviceId} is not present in ${raw.remoteId}'s paired-device set.`
              );
            }
          }
        } catch (error) {
          if (serverReachable !== true) serverReachable = false;
          paired = false;
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
      return {
        installed: packageInstalled,
        paired,
        deviceId,
        bundleActive: rendering,
        rendering,
        screenshotPng: screenshot
          ? Buffer.from(screenshot.stdout, "binary").toString("base64")
          : undefined,
        serverReachable,
        serverUrl,
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

async function readAndroidPublicIdentity(
  device: string,
  packageName: string
): Promise<{ deviceId?: string; serverId?: string; serverUrl?: string; issue?: string }> {
  const result = await runCapture(
    "adb",
    adbArgs(device, [
      "shell",
      "run-as",
      packageName,
      "cat",
      "shared_prefs/natstack-mobile-host.xml",
    ]),
    { cwd: process.cwd(), reject: false }
  );
  if (result.exitCode !== 0) {
    return {
      issue: `Cannot read mobile app public identity with run-as ${packageName}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    };
  }
  return {
    deviceId: sharedPrefString(result.stdout, "public.deviceId"),
    serverId: sharedPrefString(result.stdout, "public.serverId"),
    serverUrl: sharedPrefString(result.stdout, "public.serverUrl"),
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

async function probeFromDevice(device: string | undefined, url: string): Promise<boolean> {
  const probeUrl = `${url.replace(/\/+$/, "")}/healthz`;
  return adbExitOk(device, [
    "shell",
    "sh",
    "-c",
    `toybox wget -q -O - ${quote(probeUrl)} >/dev/null 2>&1 || curl -fsS ${quote(probeUrl)} >/dev/null 2>&1`,
  ]);
}

async function resolvePhoneReachableServerUrl(
  device: string,
  remote: Remote
): Promise<{ serverUrl: string; method: "direct" | "adb-reverse"; source: string }> {
  const candidates = phoneUrlCandidates(remote);
  for (const candidate of candidates) {
    if (isDesktopLocalOrigin(candidate.url)) continue;
    if (await probeFromDevice(device, candidate.url)) {
      return { serverUrl: candidate.url, method: "direct", source: candidate.source };
    }
  }

  const reverse = adbReverseCandidate(remote);
  if (reverse) {
    await adb(device, ["reverse", `tcp:${reverse.devicePort}`, `tcp:${reverse.hostPort}`]);
    if (await probeFromDevice(device, reverse.url)) {
      return { serverUrl: reverse.url, method: "adb-reverse", source: reverse.source };
    }
  }

  const attempted = candidates
    .filter((candidate) => !isDesktopLocalOrigin(candidate.url))
    .map((candidate) => candidate.url)
    .concat(reverse ? [reverse.url] : []);
  throw new MobileDebugError(
    "EUNREACHABLE",
    attempted.length
      ? `Device cannot reach any server /healthz candidate: ${attempted.join(", ")}`
      : "Remote has no phone-reachable server URL candidates"
  );
}

function phoneUrlCandidates(remote: Remote): Array<{ url: string; source: string }> {
  const candidates: Array<{ url: string; source: string }> = [];
  const add = (raw: string | undefined, source: string) => {
    const origin = normalizeHttpOrigin(raw);
    if (!origin) return;
    if (origin.startsWith("http://") && !isTrustedCleartextHost(new URL(origin).hostname)) return;
    if (!candidates.some((candidate) => candidate.url === origin)) {
      candidates.push({ url: origin, source });
    }
  };

  add(remote.server?.publicUrl, "server.publicUrl");

  const base = firstParsedHttpUrl([
    remote.server?.publicUrl,
    remote.server?.url,
    remote.server?.hubUrl,
  ]);
  const basePort = remote.server?.gatewayPort ?? (base ? explicitPort(base) : undefined);
  for (const reach of remote.reach ?? []) {
    add(urlFromReach(reach.kind, reach.value, base?.protocol, basePort), `reach.${reach.kind}`);
  }

  add(remote.server?.url, "server.url");
  add(remote.server?.hubUrl, "server.hubUrl");
  return candidates;
}

function adbReverseCandidate(
  remote: Remote
): { url: string; hostPort: number; devicePort: number; source: string } | null {
  for (const [raw, source] of [
    [remote.server?.url, "server.url"],
    [remote.server?.hubUrl, "server.hubUrl"],
  ] as const) {
    const parsed = parseHttpUrl(raw);
    if (!parsed || !isDesktopLocalHost(parsed.hostname)) continue;
    const hostPort = explicitPort(parsed) ?? (parsed.protocol === "https:" ? 443 : 80);
    return {
      url: originForHost("http:", "localhost", hostPort),
      hostPort,
      devicePort: hostPort,
      source: `${source}.adbReverse`,
    };
  }
  return null;
}

function urlFromReach(
  kind: Remote["reach"][number]["kind"],
  value: string,
  baseProtocol: string | undefined,
  basePort: number | undefined
): string | undefined {
  const parsed = parseHttpUrl(value);
  if (parsed) return parsed.origin;

  const hostPort = parseReachHostPort(value);
  if (!hostPort) return undefined;
  const protocol = protocolForReach(kind, hostPort.host, baseProtocol);
  const port = hostPort.port ?? basePort;
  return originForHost(protocol, hostPort.host, port);
}

function protocolForReach(
  kind: Remote["reach"][number]["kind"],
  host: string,
  baseProtocol: string | undefined
): "http:" | "https:" {
  if (kind === "tailscale-magicdns") return "https:";
  if (kind === "lan-hostname" || kind === "lan-ip" || kind === "tailscale-ip") return "http:";
  if (baseProtocol === "http:" && isTrustedCleartextHost(host)) return "http:";
  return "https:";
}

function parseReachHostPort(raw: string): { host: string; port?: number } | null {
  try {
    const parsed = new URL(`http://${raw}`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/")
      return null;
    const port = parsed.port ? Number(parsed.port) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
    return { host: parsed.hostname, ...(port ? { port } : {}) };
  } catch {
    return null;
  }
}

function firstParsedHttpUrl(values: Array<string | undefined>): URL | null {
  for (const value of values) {
    const parsed = parseHttpUrl(value);
    if (parsed) return parsed;
  }
  return null;
}

function normalizeHttpOrigin(raw: string | undefined): string | undefined {
  const parsed = parseHttpUrl(raw);
  return parsed?.origin;
}

function parseHttpUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
}

function originForHost(
  protocol: "http:" | "https:",
  host: string,
  port: number | undefined
): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const defaultPort = protocol === "https:" ? 443 : 80;
  const portPart = port && port !== defaultPort ? `:${port}` : "";
  return `${protocol}//${normalizedHost}${portPart}`;
}

function explicitPort(url: URL): number | undefined {
  if (!url.port) return undefined;
  const parsed = Number(url.port);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isDesktopLocalOrigin(raw: string): boolean {
  const parsed = parseHttpUrl(raw);
  return !!parsed && isDesktopLocalHost(parsed.hostname);
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

function isTrustedCleartextHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (isDesktopLocalHost(lower) || lower === "10.0.2.2") return true;
  if (/^10\./.test(lower) || /^192\.168\./.test(lower)) return true;
  const m172 = lower.match(/^172\.(\d+)\./);
  if (m172) {
    const octet = Number(m172[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  const m100 = lower.match(/^100\.(\d+)\./);
  if (m100) {
    const octet = Number(m100[1]);
    if (octet >= 64 && octet <= 127) return true;
  }
  if (lower === "ts.net" || lower.endsWith(".ts.net")) return true;
  if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(lower)) return true;
  return lower.endsWith(".local");
}

function createConnectDeepLink(
  serverUrl: string,
  code: string,
  workspace: string | undefined
): string {
  const params = new URLSearchParams({ url: serverUrl, code });
  if (workspace) params.set("workspace", workspace);
  return `natstack://connect?${params.toString()}`;
}

function sharedPrefString(xml: string, key: string): string | undefined {
  const pattern = new RegExp(`<string\\s+name="${escapeRegExp(key)}">([\\s\\S]*?)</string>`);
  const match = xml.match(pattern);
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  return streamProcess("adb", adbArgs(device, streamArgs));
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

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

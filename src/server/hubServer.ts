import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { getCentralConfigPaths } from "@natstack/shared/workspace/loader";
import { CentralDataManager } from "@natstack/shared/centralData";
import { getWorkspaceDir } from "@natstack/env-paths";
import { TokenManager, constantTimeStringEqual } from "@natstack/shared/tokenManager";
import { resolveHostConfig } from "@natstack/shared/hostConfig";
import { selectedWorkspaceUrl, WORKSPACE_ROUTE_PREFIX } from "@natstack/shared/connect";
import {
  getAdminTokenPath,
  loadPersistedAdminToken,
  savePersistedAdminToken,
} from "@natstack/shared/centralAuth";
import { DEFAULT_PAIRING_CODE_TTL_MS, DeviceAuthStore } from "./services/deviceAuthStore.js";
import { shellCallerId } from "./services/auth/model.js";
import { authError } from "./services/auth/errors.js";

declare const __filename: string;

export interface HubServerArgs {
  appRoot?: string;
  logLevel?: string;
  readyFile?: string;
  ephemeral?: boolean;
  servePanels?: boolean;
  gatewayPort?: number;
  panelPort?: number;
  host?: string;
  bindHost?: string;
  printCredentials?: boolean;
  requireMobileReady?: boolean;
  requireElectronReady?: boolean;
  headlessHostAutospawn?: boolean;
}

interface WorkspaceRuntime {
  name: string;
  advertisedName: string;
  port: number;
  publicUrl: string;
  child: ChildProcess;
  ready: Record<string, unknown>;
}

interface PendingWorkspaceRuntime {
  promise: Promise<WorkspaceRuntime>;
}

interface HubRuntimeState {
  appRoot: string;
  args: HubServerArgs;
  centralData: CentralDataManager;
  deviceAuthStore: DeviceAuthStore;
  tokenManager: TokenManager;
  serverBootId: string;
  adminToken: string;
  tokenSource: "env" | "persisted" | "generated";
  gatewayPort: number;
  protocol: "http" | "https";
  externalHost: string;
  bindHost: string;
  publicUrl: string | null;
  connectUrl: string;
  authStorePath: string;
  startupPairingCode: string | null;
  startupQrPairingCode: string | null;
  runtimes: Map<string, WorkspaceRuntime | PendingWorkspaceRuntime>;
  shuttingDown: boolean;
}

const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function parseEnvPort(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res: http.ServerResponse, status: number, payload: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function remoteErrorPayload(error: unknown): { error: string; code?: string } {
  const record = asRecord(error);
  const code = typeof record?.["code"] === "string" ? record["code"] : undefined;
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
  };
}

function bearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function requireAdmin(req: http.IncomingMessage, state: HubRuntimeState): boolean {
  const token = bearerToken(req);
  return !!token && constantTimeStringEqual(token, state.adminToken);
}

function validateDeviceCredential(state: HubRuntimeState, payload: Record<string, unknown>): void {
  const deviceId = payload["deviceId"];
  const refreshToken = payload["refreshToken"];
  if (typeof deviceId !== "string" || typeof refreshToken !== "string") {
    throw authError("DEVICE_CREDENTIAL_REQUIRED", "Device credential is required", 401);
  }
  state.deviceAuthStore.validateRefresh(deviceId, refreshToken);
}

function connectionInfo(state: HubRuntimeState): Record<string, unknown> {
  return {
    serverUrl: state.connectUrl,
    publicUrl: state.publicUrl,
    connectUrl: state.connectUrl,
    protocol: state.protocol,
    externalHost: state.externalHost,
    gatewayPort: state.gatewayPort,
    serverId: state.deviceAuthStore.getServerId(),
    serverBootId: state.serverBootId,
    workspaceId: null,
  };
}

function responseForCredential(
  state: HubRuntimeState,
  credential: { deviceId: string; refreshToken: string; label: string; platform?: string }
): Record<string, unknown> {
  return {
    ...credential,
    shellToken: state.tokenManager.ensureToken(shellCallerId(credential.deviceId), "shell"),
    callerId: shellCallerId(credential.deviceId),
    serverId: state.deviceAuthStore.getServerId(),
    serverBootId: state.serverBootId,
    workspaceId: null,
  };
}

function listHubWorkspaces(state: HubRuntimeState): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = state.centralData
    .listWorkspaces()
    .map((entry) => ({
      name: entry.name,
      lastOpened: entry.lastOpened,
      running: isRuntimeRunning(state, entry.name),
    }));
  if (!state.args.ephemeral && entries.length === 0) {
    entries.push({
      name: "default",
      lastOpened: 0,
      running: isRuntimeRunning(state, "default"),
    });
  }
  if (state.args.ephemeral && !entries.some((entry) => entry["name"] === "dev")) {
    entries.unshift({
      name: "dev",
      lastOpened: Date.now(),
      running: isRuntimeRunning(state, "dev"),
      ephemeral: true,
    });
  }
  return entries;
}

function isRuntimeRunning(state: HubRuntimeState, name: string): boolean {
  const runtime = state.runtimes.get(name);
  return !!runtime && "child" in runtime && runtime.child.exitCode === null;
}

function workspaceConfigExists(name: string): boolean {
  return fs.existsSync(path.join(getWorkspaceDir(name), "source", "meta/natstack.yml"));
}

function normalizeWorkspaceName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Workspace name is required");
  }
  const name = raw.trim();
  if (!WORKSPACE_NAME_RE.test(name)) {
    throw new Error("Workspace name must contain only letters, numbers, hyphens, and underscores");
  }
  return name;
}

function workspaceEndpointUrl(state: HubRuntimeState, name: string): string {
  return selectedWorkspaceUrl(state.connectUrl, name).toString().replace(/\/$/, "");
}

function isRefreshShellPath(upstreamPath: string): boolean {
  return new URL(upstreamPath, "http://workspace.local").pathname === "/_r/s/auth/refresh-shell";
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) {
      throw authError("REQUEST_BODY_TOO_LARGE", "Request body too large", 413);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function handleAuthRoute(
  state: HubRuntimeState,
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    if (req.method === "GET" && route === "devices") {
      if (!requireAdmin(req, state)) {
        sendJson(res, 401, { error: "Unauthorized", code: "UNAUTHORIZED" });
        return;
      }
      sendJson(res, 200, {
        serverId: state.deviceAuthStore.getServerId(),
        devices: state.deviceAuthStore
          .listDevices()
          .map(({ refreshTokenHash: _secret, ...device }) => device),
      });
      return;
    }

    if (req.method !== "POST") {
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    const body = (await readJson(req)) as Record<string, unknown>;

    if (route === "complete-pairing") {
      const code = typeof body["code"] === "string" ? body["code"] : "";
      const credential = state.deviceAuthStore.completePairing({
        code,
        label:
          typeof body["label"] === "string" && body["label"].trim()
            ? body["label"].trim()
            : "NatStack client",
        platform: typeof body["platform"] === "string" ? body["platform"] : undefined,
      });
      sendJson(res, 200, responseForCredential(state, credential));
      return;
    }

    if (route === "refresh-shell") {
      const deviceId = typeof body["deviceId"] === "string" ? body["deviceId"] : "";
      const refreshToken = typeof body["refreshToken"] === "string" ? body["refreshToken"] : "";
      const device = state.deviceAuthStore.validateRefresh(deviceId, refreshToken);
      sendJson(res, 200, {
        shellToken: state.tokenManager.ensureToken(shellCallerId(deviceId), "shell"),
        callerId: shellCallerId(deviceId),
        deviceId,
        label: device.label,
        serverId: state.deviceAuthStore.getServerId(),
        serverBootId: state.serverBootId,
        workspaceId: null,
      });
      return;
    }

    if (route === "issue-device") {
      if (!requireAdmin(req, state)) {
        sendJson(res, 401, { error: "Unauthorized", code: "UNAUTHORIZED" });
        return;
      }
      const credential = state.deviceAuthStore.issueDevice({
        label:
          typeof body["label"] === "string" && body["label"].trim()
            ? body["label"].trim()
            : "NatStack client",
        platform: typeof body["platform"] === "string" ? body["platform"] : undefined,
      });
      sendJson(res, 200, responseForCredential(state, credential));
      return;
    }

    if (route === "create-pairing-code") {
      if (!requireAdmin(req, state)) {
        sendJson(res, 401, { error: "Unauthorized", code: "UNAUTHORIZED" });
        return;
      }
      const ttlMs = typeof body["ttlMs"] === "number" ? body["ttlMs"] : DEFAULT_PAIRING_CODE_TTL_MS;
      const code = state.deviceAuthStore.createPairingCode(ttlMs);
      const info = connectionInfo(state);
      // No `deepLink`: the pairing deep link is now the WebRTC QR (room+fp+sig),
      // minted by the answerer (TODO(webrtc-answerer)). The pairing `code` below
      // still authorizes the principal after the DTLS pin verifies.
      sendJson(res, 200, {
        ...info,
        code,
        expiresInMs: ttlMs,
        expiresAt: Date.now() + ttlMs,
      });
      return;
    }

    if (route === "revoke-device") {
      if (!requireAdmin(req, state)) {
        sendJson(res, 401, { error: "Unauthorized", code: "UNAUTHORIZED" });
        return;
      }
      const deviceId = typeof body["deviceId"] === "string" ? body["deviceId"] : "";
      const revoked = state.deviceAuthStore.revokeDevice(deviceId);
      state.tokenManager.revokeToken(shellCallerId(deviceId));
      sendJson(res, 200, { revoked });
      return;
    }

    sendJson(res, 404, { error: "Unknown auth route", code: "NOT_FOUND" });
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? 401 : 400;
    sendJson(res, status, remoteErrorPayload(error));
  }
}

async function handleWorkspaceRoute(
  state: HubRuntimeState,
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    validateDeviceCredential(state, body);

    if (route === "list") {
      sendJson(res, 200, { workspaces: listHubWorkspaces(state) });
      return;
    }

    if (route === "select") {
      const name = normalizeWorkspaceName(body["name"]);
      const runtime = await ensureWorkspaceRuntime(state, name);
      sendJson(res, 200, {
        workspaceName: runtime.advertisedName,
        serverUrl: runtime.publicUrl,
        running: true,
      });
      return;
    }

    sendJson(res, 404, { error: "Unknown workspace route", code: "NOT_FOUND" });
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? 401 : 400;
    sendJson(res, status, remoteErrorPayload(error));
  }
}

async function handleRpc(
  state: HubRuntimeState,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    const token = bearerToken(req);
    const caller = token ? state.tokenManager.validateToken(token) : null;
    if (!caller) {
      sendJson(res, 401, { error: "Unauthorized", code: "UNAUTHORIZED" });
      return;
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    const method = typeof body["method"] === "string" ? body["method"] : "";
    const args = Array.isArray(body["args"]) ? body["args"] : [];

    if (method === "workspace.list") {
      sendJson(res, 200, { result: listHubWorkspaces(state) });
      return;
    }
    if (method === "workspace.select") {
      const name = normalizeWorkspaceName(args[0]);
      const runtime = await ensureWorkspaceRuntime(state, name);
      sendJson(res, 200, {
        result: {
          workspaceName: runtime.advertisedName,
          serverUrl: runtime.publicUrl,
          running: true,
        },
      });
      return;
    }
    if (method === "auth.getConnectionInfo") {
      sendJson(res, 200, { result: connectionInfo(state) });
      return;
    }
    if (method === "auth.createPairingInvite") {
      const opts = asRecord(args[0]) ?? {};
      const ttlMs = typeof opts["ttlMs"] === "number" ? opts["ttlMs"] : DEFAULT_PAIRING_CODE_TTL_MS;
      const code = state.deviceAuthStore.createPairingCode(ttlMs);
      // No `deepLink`: pairing is the WebRTC QR (room+fp+sig) minted by the
      // answerer (TODO(webrtc-answerer)); the `code` authorizes the principal.
      sendJson(res, 200, {
        result: {
          ...connectionInfo(state),
          code,
          expiresInMs: ttlMs,
          expiresAt: Date.now() + ttlMs,
        },
      });
      return;
    }
    if (method === "auth.listDevices") {
      sendJson(res, 200, {
        result: {
          serverId: state.deviceAuthStore.getServerId(),
          devices: state.deviceAuthStore
            .listDevices()
            .map(({ refreshTokenHash: _secret, ...device }) => device),
        },
      });
      return;
    }
    if (method === "auth.revokeDevice") {
      const deviceId = typeof args[0] === "string" ? args[0] : "";
      const revoked = state.deviceAuthStore.revokeDevice(deviceId);
      state.tokenManager.revokeToken(shellCallerId(deviceId));
      sendJson(res, 200, { result: { revoked } });
      return;
    }

    sendJson(res, 200, { error: `Unknown hub RPC method: ${method}` });
  } catch (error) {
    sendJson(res, 500, remoteErrorPayload(error));
  }
}

function parseWorkspaceProxyUrl(rawUrl: string): { name: string; upstreamPath: string } | null {
  try {
    const url = new URL(rawUrl, "http://hub.local");
    if (!url.pathname.startsWith(WORKSPACE_ROUTE_PREFIX)) return null;
    const rest = url.pathname.slice(WORKSPACE_ROUTE_PREFIX.length);
    const [encodedName = "", ...remaining] = rest.split("/");
    if (!encodedName) return null;
    const name = normalizeWorkspaceName(decodeURIComponent(encodedName));
    const pathRemainder = remaining.length > 0 ? `/${remaining.join("/")}` : "/";
    return { name, upstreamPath: `${pathRemainder}${url.search}` };
  } catch {
    return null;
  }
}

async function existingWorkspaceRuntime(
  state: HubRuntimeState,
  advertisedName: string
): Promise<WorkspaceRuntime | null> {
  const current = state.runtimes.get(advertisedName);
  if (!current) return null;
  const runtime = "promise" in current ? await current.promise : current;
  return runtime.child.exitCode === null ? runtime : null;
}

async function runtimeForProxyRequest(
  state: HubRuntimeState,
  parsed: { name: string; upstreamPath: string },
  req: http.IncomingMessage
): Promise<{ runtime: WorkspaceRuntime; body?: Buffer } | null> {
  const existing = await existingWorkspaceRuntime(state, parsed.name);
  if (existing) return { runtime: existing };

  if (req.method !== "POST" || !isRefreshShellPath(parsed.upstreamPath)) {
    return null;
  }

  const body = await readBody(req, 64 * 1024);
  const payload = (body.length > 0 ? JSON.parse(body.toString("utf8")) : {}) as Record<
    string,
    unknown
  >;
  validateDeviceCredential(state, payload);
  const runtime = await ensureWorkspaceRuntime(state, parsed.name);
  return { runtime, body };
}

async function proxyHttpRequest(
  state: HubRuntimeState,
  parsed: { name: string; upstreamPath: string },
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let resolved: { runtime: WorkspaceRuntime; body?: Buffer } | null;
  try {
    resolved = await runtimeForProxyRequest(state, parsed, req);
  } catch (error) {
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 400;
    sendJson(res, status, remoteErrorPayload(error));
    return;
  }
  if (!resolved) {
    sendText(res, 404, "Workspace is not running");
    return;
  }
  const { runtime, body } = resolved;
  const headers = { ...req.headers, host: `127.0.0.1:${runtime.port}` };
  if (body) {
    headers["content-length"] = String(body.byteLength);
    delete headers["transfer-encoding"];
  }
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: runtime.port,
      method: req.method,
      path: parsed.upstreamPath,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) sendText(res, 502, `Workspace proxy error: ${error.message}`);
    else res.destroy(error);
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
}

async function proxyUpgrade(
  state: HubRuntimeState,
  parsed: { name: string; upstreamPath: string },
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<void> {
  try {
    const runtime = await existingWorkspaceRuntime(state, parsed.name);
    if (!runtime) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const upstream = http.request({
      host: "127.0.0.1",
      port: runtime.port,
      method: req.method,
      path: parsed.upstreamPath,
      headers: { ...req.headers, host: `127.0.0.1:${runtime.port}` },
    });
    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      socket.write(
        `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`
      );
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) socket.write(`${key}: ${item}\r\n`);
        } else if (value !== undefined) {
          socket.write(`${key}: ${value}\r\n`);
        }
      }
      socket.write("\r\n");
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on("error", () => {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    upstream.end();
  } catch {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
}

async function ensureWorkspaceRuntime(
  state: HubRuntimeState,
  advertisedName: string
): Promise<WorkspaceRuntime> {
  const current = state.runtimes.get(advertisedName);
  if (current) return "promise" in current ? current.promise : current;
  const promise = startWorkspaceRuntime(state, advertisedName);
  state.runtimes.set(advertisedName, { promise });
  try {
    const runtime = await promise;
    state.runtimes.set(advertisedName, runtime);
    return runtime;
  } catch (error) {
    state.runtimes.delete(advertisedName);
    throw error;
  }
}

async function startWorkspaceRuntime(
  state: HubRuntimeState,
  advertisedName: string
): Promise<WorkspaceRuntime> {
  const isEphemeralDevWorkspace = state.args.ephemeral && advertisedName === "dev";
  const shouldAutoApproveDefaultStartup =
    advertisedName === "default" &&
    !state.centralData.hasWorkspace("default") &&
    !workspaceConfigExists("default");
  const childWorkspaceName = isEphemeralDevWorkspace
    ? `dev-${randomBytes(4).toString("hex")}`
    : advertisedName;
  const readyDir = fs.mkdtempSync(path.join(os.tmpdir(), `natstack-workspace-${advertisedName}-`));
  const readyFile = path.join(readyDir, "ready.json");
  const publicUrl = workspaceEndpointUrl(state, advertisedName);
  const childArgs = [
    ...process.argv.slice(1, 2),
    "--workspace",
    childWorkspaceName,
    "--app-root",
    state.appRoot,
    "--ready-file",
    readyFile,
    "--host",
    "127.0.0.1",
    "--bind-host",
    "127.0.0.1",
    "--protocol",
    "http",
    "--serve-panels",
    "--init",
  ];
  if (state.args.logLevel) childArgs.push("--log-level", state.args.logLevel);
  if (state.args.requireMobileReady) childArgs.push("--require-mobile-ready");
  if (state.args.requireElectronReady) childArgs.push("--require-electron-ready");

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NATSTACK_APP_ROOT: state.appRoot,
    NATSTACK_HOST: "127.0.0.1",
    NATSTACK_BIND_HOST: "127.0.0.1",
    NATSTACK_PROTOCOL: "http",
    NATSTACK_NO_VPN_DETECT: "1",
    NATSTACK_WORKSPACE: childWorkspaceName,
    NATSTACK_AUTH_STORE_PATH: state.authStorePath,
    NATSTACK_DISABLE_STARTUP_PAIRING: "1",
    NATSTACK_FORCE_WORKSPACE_SERVER: "1",
    NATSTACK_HUB_URL: state.connectUrl,
  };
  delete childEnv["NATSTACK_GATEWAY_PORT"];
  delete childEnv["NATSTACK_WORKSPACE_DIR"];
  delete childEnv["NATSTACK_REQUIRE_PUBLIC_URL"];
  if (isEphemeralDevWorkspace) {
    childEnv["NATSTACK_WORKSPACE_EPHEMERAL"] = "1";
  } else {
    delete childEnv["NATSTACK_WORKSPACE_EPHEMERAL"];
  }
  if (shouldAutoApproveDefaultStartup) {
    childEnv["NATSTACK_AUTO_APPROVE_STARTUP_UNITS"] = "1";
  } else {
    delete childEnv["NATSTACK_AUTO_APPROVE_STARTUP_UNITS"];
  }

  const child = spawn(process.execPath, [...process.execArgv, ...childArgs], {
    cwd: state.appRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) =>
    process.stdout.write(`[workspace:${advertisedName}] ${chunk}`)
  );
  child.stderr?.on("data", (chunk) =>
    process.stderr.write(`[workspace:${advertisedName}:err] ${chunk}`)
  );
  child.on("exit", () => {
    const current = state.runtimes.get(advertisedName);
    if (current && "child" in current && current.child === child) {
      state.runtimes.delete(advertisedName);
    }
  });

  const ready = await waitForReadyFile(readyFile, child);
  const port = typeof ready["gatewayPort"] === "number" ? ready["gatewayPort"] : null;
  if (!port) {
    child.kill();
    throw new Error(`Workspace "${advertisedName}" did not report a gateway port`);
  }
  state.centralData.touchWorkspace(childWorkspaceName);
  try {
    fs.rmSync(readyDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { name: childWorkspaceName, advertisedName, port, publicUrl, child, ready };
}

async function waitForReadyFile(
  readyFile: string,
  child: ChildProcess
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Workspace runtime exited before readiness (code ${child.exitCode})`);
    }
    try {
      return JSON.parse(fs.readFileSync(readyFile, "utf8")) as Record<string, unknown>;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for workspace runtime readiness: ${readyFile}`);
}

function resolveAdminToken(): { adminToken: string; tokenSource: HubRuntimeState["tokenSource"] } {
  const envToken = process.env["NATSTACK_ADMIN_TOKEN"];
  if (envToken) return { adminToken: envToken, tokenSource: "env" };
  const persisted = loadPersistedAdminToken();
  if (persisted) return { adminToken: persisted, tokenSource: "persisted" };
  const adminToken = randomBytes(32).toString("hex");
  try {
    savePersistedAdminToken(adminToken);
  } catch (error) {
    console.warn(`[Hub] Failed to persist admin token at ${getAdminTokenPath()}:`, error);
  }
  return { adminToken, tokenSource: "generated" };
}

export async function runHubServer(input: { args: HubServerArgs; appRoot: string }): Promise<void> {
  const args = input.args;
  const appRoot = input.appRoot;
  const centralData = new CentralDataManager();
  const tokenManager = new TokenManager();
  const { adminToken, tokenSource } = resolveAdminToken();
  tokenManager.setAdminToken(adminToken);
  const centralPaths = getCentralConfigPaths();
  const authStorePath =
    process.env["NATSTACK_AUTH_STORE_PATH"] ??
    path.join(centralPaths.configDir, "server-auth", "devices.json");
  const deviceAuthStore = new DeviceAuthStore(authStorePath);
  const startupPairingCode = deviceAuthStore.createPairingCode(DEFAULT_PAIRING_CODE_TTL_MS);
  const startupQrPairingCode = deviceAuthStore.createPairingCode(DEFAULT_PAIRING_CODE_TTL_MS);
  const serverBootId = `boot_${randomBytes(18).toString("base64url")}`;
  const requestedGatewayPort = args.gatewayPort ?? parseEnvPort("NATSTACK_GATEWAY_PORT");
  const hostConfig = resolveHostConfig({
    workerdPort: 0,
    gatewayPort: requestedGatewayPort ?? 0,
    host: args.host,
    bindHost: args.bindHost,
  });

  let state: HubRuntimeState | null = null;
  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      if (!state) {
        sendText(res, 503, "Hub starting");
        return;
      }
      const rawUrl = req.url ?? "/";
      const proxied = parseWorkspaceProxyUrl(rawUrl);
      if (proxied) {
        await proxyHttpRequest(state, proxied, req, res);
        return;
      }
      const url = new URL(rawUrl, "http://hub.local");
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          mode: "hub",
          serverId: state.deviceAuthStore.getServerId(),
          serverBootId: state.serverBootId,
          gatewayPort: state.gatewayPort,
          version: process.env["npm_package_version"],
        });
        return;
      }
      if (url.pathname.startsWith("/_r/s/auth/")) {
        await handleAuthRoute(state, url.pathname.slice("/_r/s/auth/".length), req, res);
        return;
      }
      if (url.pathname.startsWith("/_r/s/workspaces/")) {
        await handleWorkspaceRoute(state, url.pathname.slice("/_r/s/workspaces/".length), req, res);
        return;
      }
      if (url.pathname === "/rpc") {
        await handleRpc(state, req, res);
        return;
      }
      sendText(res, 404, "Not Found");
    })().catch((error) => {
      if (!res.headersSent) sendJson(res, 500, remoteErrorPayload(error));
      else res.destroy(error);
    });
  };

  // Loopback HTTP only — the public/TLS ingress is decommissioned.
  const server = http.createServer(requestHandler);

  server.on("upgrade", (req, socket, head) => {
    if (!state) {
      socket.destroy();
      return;
    }
    const proxied = parseWorkspaceProxyUrl(req.url ?? "/");
    if (!proxied) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    void proxyUpgrade(state, proxied, req, socket, head);
  });

  const gatewayPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedGatewayPort ?? 0, hostConfig.bindHost, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Hub listen failed"));
      else resolve(address.port);
    });
  });

  // No public ingress: the hub is loopback HTTP only. connectUrl is the loopback
  // gateway URL; remote reach is the per-workspace WebRTC pipe (answerer seam).
  const gatewayUrl = `${hostConfig.protocol}://${hostConfig.externalHost}:${gatewayPort}`;
  const connectUrl = gatewayUrl.replace(/\/$/, "");
  state = {
    appRoot,
    args,
    centralData,
    deviceAuthStore,
    tokenManager,
    serverBootId,
    adminToken,
    tokenSource,
    gatewayPort,
    protocol: hostConfig.protocol,
    externalHost: hostConfig.externalHost,
    bindHost: hostConfig.bindHost,
    publicUrl: null,
    connectUrl,
    authStorePath,
    startupPairingCode,
    startupQrPairingCode,
    runtimes: new Map(),
    shuttingDown: false,
  };

  console.log("natstack-server hub ready:");
  console.log(`  Gateway:     ${gatewayUrl} (loopback)`);
  console.log(`  Token file:  ${getAdminTokenPath()}${tokenSource === "env" ? " (env)" : ""}`);
  console.log(`  Pairing code: ${startupPairingCode}`);
  console.log(`  QR pairing code: ${startupQrPairingCode}`);
  // No Pair URL: pairing is the WebRTC QR (room+fp+sig) minted by the answerer
  // (TODO(webrtc-answerer)); the pairing codes above authorize the principal.

  if (args.readyFile) {
    const payload = {
      mode: "hub",
      gatewayUrl,
      publicUrl: null,
      connectUrl,
      adminToken,
      pairingCode: startupPairingCode,
      qrPairingCode: startupQrPairingCode,
      pairingCodes: {
        desktop: startupPairingCode,
        mobile: startupQrPairingCode,
        qr: startupQrPairingCode,
      },
      serverId: deviceAuthStore.getServerId(),
      serverBootId,
      gatewayPort,
      workspaces: listHubWorkspaces(state),
    };
    fs.mkdirSync(path.dirname(args.readyFile), { recursive: true });
    fs.writeFileSync(args.readyFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  if (args.printCredentials) {
    console.log(`\nNATSTACK_ADMIN_TOKEN=${adminToken}`);
    console.log(`NATSTACK_PAIRING_CODE=${startupPairingCode}`);
    console.log(`NATSTACK_QR_PAIRING_CODE=${startupQrPairingCode}`);
  }

  async function shutdown(): Promise<void> {
    if (!state || state.shuttingDown) return;
    state.shuttingDown = true;
    console.log("[Hub] Shutting down...");
    for (const runtime of state.runtimes.values()) {
      if ("child" in runtime) runtime.child.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

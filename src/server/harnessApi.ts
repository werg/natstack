/**
 * Harness HTTP API — HTTP endpoints for DO-initiated harness management.
 *
 * DOs call these endpoints directly via fetch() to spawn, command, and stop
 * harness processes. This replaces the action-return pattern where DOs
 * returned WorkerActions for the server to execute.
 *
 * Endpoints:
 * - POST /harness/spawn — spawn a new harness process
 * - POST /harness/{id}/command — send a command to a running harness
 * - POST /harness/{id}/stop — stop a harness process
 * - POST /harness/fork-channel — create a forked channel
 */

import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HarnessManager } from "./harnessManager.js";
import type { DODispatch, DORef } from "./doDispatch.js";
import type { ContextFolderManager } from "../shared/contextFolderManager.js";
import type { PubSubServer } from "@natstack/pubsub-server";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("HarnessApi");

export interface TokenValidationResult {
  valid: boolean;
  callerId?: string;
  callerKind?: string;
}

export interface HarnessApiDeps {
  harnessManager: HarnessManager;
  doDispatch: DODispatch;
  contextFolderManager: ContextFolderManager;
  pubsub: PubSubServer;
  /** Validate auth tokens — returns caller identity on success. */
  validateToken: (token: string) => TokenValidationResult;
}

/**
 * Handle an HTTP request to the harness API.
 * Returns true if the request was handled, false if it's not a harness route.
 */
export async function handleHarnessApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HarnessApiDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  if (!pathname.startsWith("/harness") && pathname !== "/validate-token") return false;

  // Auth check
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const auth = token ? deps.validateToken(token) : { valid: false };
  if (!token || !auth.valid) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  // Parse JSON body for POST
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    body = await readJsonBody(req);
  }

  try {
    // POST /validate-token — validate a caller token, returns identity
    if (pathname === "/validate-token" && req.method === "POST") {
      const tokenToValidate = body["token"] as string;
      if (!tokenToValidate) {
        sendJson(res, 400, { error: "Missing token" });
        return true;
      }
      const result = deps.validateToken(tokenToValidate);
      sendJson(res, 200, result);
      return true;
    }

    // POST /harness/spawn
    if (pathname === "/harness/spawn" && req.method === "POST") {
      await handleSpawn(body, deps, res);
      return true;
    }

    // POST /harness/fork-channel
    if (pathname === "/harness/fork-channel" && req.method === "POST") {
      await handleForkChannel(body, deps, res);
      return true;
    }

    // POST /harness/{id}/command
    const commandMatch = pathname.match(/^\/harness\/([^/]+)\/command$/);
    if (commandMatch && req.method === "POST") {
      await handleCommand(decodeURIComponent(commandMatch[1]!), body, deps, res);
      return true;
    }

    // POST /harness/{id}/stop
    const stopMatch = pathname.match(/^\/harness\/([^/]+)\/stop$/);
    if (stopMatch && req.method === "POST") {
      await handleStop(decodeURIComponent(stopMatch[1]!), deps, res);
      return true;
    }

    // GET /harness/{id}/status
    const statusMatch = pathname.match(/^\/harness\/([^/]+)\/status$/);
    if (statusMatch && req.method === "GET") {
      handleStatus(decodeURIComponent(statusMatch[1]!), deps, res);
      return true;
    }

    sendJson(res, 404, { error: "Not found" });
    return true;
  } catch (err) {
    log.error("Harness API error:", err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleSpawn(
  body: Record<string, unknown>,
  deps: HarnessApiDeps,
  res: ServerResponse,
): Promise<void> {
  const doRef = body["doRef"] as DORef;
  let harnessId = body["harnessId"] as string | undefined;
  const type = body["type"] as string;
  const channelId = body["channelId"] as string;
  const contextId = body["contextId"] as string;
  const config = body["config"] as Record<string, unknown> | undefined;
  const senderParticipantId = body["senderParticipantId"] as string | undefined;
  const initialTurn = body["initialTurn"] as {
    input: { content: string; senderId: string };
    triggerMessageId: string;
    triggerPubsubId: number;
  } | undefined;

  if (!doRef || !type || !channelId || !contextId) {
    sendJson(res, 400, { error: "Missing required fields: doRef, type, channelId, contextId" });
    return;
  }

  // Generate harness ID if not provided
  if (!harnessId) {
    harnessId = `harness-${randomUUID()}`;
  }

  log.info(`Spawning harness ${harnessId} for DO ${doRef.source}:${doRef.className}/${doRef.objectKey}`);

  // Register harness in DO's SQLite
  await deps.doDispatch.dispatch(doRef, "registerHarness", harnessId, channelId, type);

  try {
    // Ensure context folder
    const contextFolderPath = await deps.contextFolderManager.ensureContextFolder(contextId);

    // Serialize HarnessConfig for the child process
    const configEnv: Record<string, string> = config
      ? { HARNESS_CONFIG: JSON.stringify(config) }
      : {};
    const extraEnv = (config?.["extraEnv"] as Record<string, string>) ?? {};

    // Spawn the harness process
    await deps.harnessManager.spawn({
      id: harnessId,
      type,
      workerId: `${doRef.source}:${doRef.className}:${doRef.objectKey}`,
      channel: channelId,
      contextId,
      contextFolderPath,
      extraEnv: { ...extraEnv, ...configEnv },
    });

    // Wait for harness to authenticate (bridge becomes available)
    const bridge = await deps.harnessManager.waitForBridge(harnessId);

    // Notify the DO that harness is ready
    await deps.doDispatch.dispatch(doRef, "onHarnessEvent", harnessId, { type: "ready" });

    // If initial turn provided, record it and start
    if (initialTurn) {
      await deps.doDispatch.dispatch(
        doRef, "recordTurnStart",
        harnessId, channelId, initialTurn.input,
        initialTurn.triggerMessageId, initialTurn.triggerPubsubId,
        senderParticipantId,
      );

      // Fire-and-forget start-turn (the AI turn blocks for minutes —
      // we don't hold the HTTP response open for that)
      bridge.call(harnessId, "startTurn", initialTurn.input).catch((err) => {
        log.error(`Initial start-turn failed for ${harnessId}:`, err);
      });
    }

    log.info(`Harness ${harnessId} spawned and ready for DO ${doRef.source}:${doRef.className}/${doRef.objectKey}`);
    sendJson(res, 200, { ok: true, harnessId });
  } catch (err) {
    log.error(`Spawn failed for ${harnessId}:`, err);
    try { await deps.harnessManager.stop(harnessId); } catch { /* already stopped */ }
    sendJson(res, 500, { error: String(err) });
  }
}

async function handleCommand(
  harnessId: string,
  body: Record<string, unknown>,
  deps: HarnessApiDeps,
  res: ServerResponse,
): Promise<void> {
  const command = body["command"] as { type: string; [key: string]: unknown };
  if (!command || !command.type) {
    sendJson(res, 400, { error: "Missing command" });
    return;
  }

  const bridge = deps.harnessManager.getHarnessBridge(harnessId);
  if (!bridge) {
    sendJson(res, 404, { error: `No bridge for harness ${harnessId}` });
    return;
  }

  const { method, args } = commandToRpc(command);

  if (command.type === "start-turn") {
    // Fire-and-forget: startTurn blocks for minutes
    bridge.call(harnessId, method, ...args).catch((err) => {
      log.error(`start-turn failed for ${harnessId}:`, err);
    });
    sendJson(res, 200, { ok: true });
  } else {
    try {
      await bridge.call(harnessId, method, ...args);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  }
}

async function handleStop(
  harnessId: string,
  deps: HarnessApiDeps,
  res: ServerResponse,
): Promise<void> {
  await deps.harnessManager.stop(harnessId);
  sendJson(res, 200, { ok: true });
}

function handleStatus(
  harnessId: string,
  deps: HarnessApiDeps,
  res: ServerResponse,
): void {
  const harness = deps.harnessManager.getHarness(harnessId);
  if (harness) {
    sendJson(res, 200, { status: harness.status, type: harness.type });
  } else {
    sendJson(res, 404, { error: "Harness not found" });
  }
}

async function handleForkChannel(
  body: Record<string, unknown>,
  deps: HarnessApiDeps,
  res: ServerResponse,
): Promise<void> {
  const doRef = body["doRef"] as DORef;
  const sourceChannel = body["sourceChannel"] as string;
  const forkPointId = body["forkPointId"] as number;

  if (!doRef || !sourceChannel || forkPointId == null) {
    sendJson(res, 400, { error: "Missing required fields" });
    return;
  }

  const forkedChannelId = `fork:${sourceChannel}:${randomUUID().slice(0, 8)}`;

  const messageStore = deps.pubsub.getMessageStore();
  messageStore.createChannel(forkedChannelId, "default", "system");
  messageStore.setChannelFork(forkedChannelId, sourceChannel, forkPointId);

  // Notify the DO
  await deps.doDispatch.dispatch(doRef, "onChannelForked", sourceChannel, forkedChannelId, forkPointId);

  sendJson(res, 200, { forkedChannelId });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map a HarnessCommand to RPC method name and args */
function commandToRpc(cmd: { type: string; [key: string]: unknown }): { method: string; args: unknown[] } {
  switch (cmd.type) {
    case "start-turn":
      return { method: "startTurn", args: [cmd["input"]] };
    case "approve-tool":
      return { method: "approveTool", args: [cmd["toolUseId"], cmd["allow"], cmd["alwaysAllow"]] };
    case "interrupt":
      return { method: "interrupt", args: [] };
    case "fork":
      return { method: "fork", args: [cmd["forkPointMessageId"], cmd["turnSessionId"]] };
    case "dispose":
      return { method: "dispose", args: [] };
    case "tool-result":
      return { method: "toolResult", args: [cmd["callId"], cmd["result"], cmd["isError"]] };
    case "discover-methods-result":
      return { method: "discoverMethodsResult", args: [cmd["methods"]] };
    default:
      throw new Error(`Unknown command type: ${cmd.type}`);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

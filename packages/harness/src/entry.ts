/**
 * Harness process entry point.
 *
 * This is the main file that runs as a Node.js child process, spawned by the
 * {@link HarnessManager} on the server. It:
 *
 * 1. Reads environment variables set by the HarnessManager
 * 2. Connects to the server via WebSocket and authenticates
 * 3. Creates an RPC bridge for bidirectional communication
 * 4. Instantiates the appropriate adapter (Claude SDK or Pi)
 * 5. Exposes RPC methods the server can call (startTurn, interrupt, etc.)
 * 6. Pushes a `ready` event to signal successful startup
 *
 * Tool execution is async: the adapter emits `tool-call` events via pushEvent,
 * the DO orchestrates the actual call via PubSub, and the result arrives back
 * as a `toolResult` RPC call that resolves the pending promise.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { createRpcBridge } from "@natstack/rpc";
import type { RpcBridge } from "@natstack/rpc";
import { createHarnessTransport } from "./harness-transport.js";
import { ClaudeSdkAdapter } from "./claude-sdk-adapter.js";
import type { ClaudeAdapterDeps, DiscoveredMethod } from "./claude-sdk-adapter.js";
import { PiAdapter } from "./pi-adapter.js";
import type { PiAdapterDeps, PiSession, PiSessionManager } from "./pi-adapter.js";
import type { HarnessCommand, HarnessConfig, HarnessOutput, TurnInput } from "./types.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

interface HarnessEnv {
  rpcWsUrl: string;
  rpcAuthToken: string;
  harnessId: string;
  harnessType: string;
  contextId: string;
  contextFolderPath?: string;
  resumeSessionId?: string;
}

function readEnv(): HarnessEnv {
  const rpcWsUrl = process.env["RPC_WS_URL"];
  const rpcAuthToken = process.env["RPC_AUTH_TOKEN"];
  const harnessId = process.env["HARNESS_ID"];
  const harnessType = process.env["HARNESS_TYPE"];
  const contextId = process.env["CONTEXT_ID"];

  if (!rpcWsUrl || !rpcAuthToken || !harnessId || !harnessType || !contextId) {
    const missing = [
      !rpcWsUrl && "RPC_WS_URL",
      !rpcAuthToken && "RPC_AUTH_TOKEN",
      !harnessId && "HARNESS_ID",
      !harnessType && "HARNESS_TYPE",
      !contextId && "CONTEXT_ID",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(`Missing required environment variables: ${missing}`);
  }

  return {
    rpcWsUrl,
    rpcAuthToken,
    harnessId,
    harnessType,
    contextId,
    contextFolderPath: process.env["CONTEXT_FOLDER_PATH"] || undefined,
    resumeSessionId: process.env["RESUME_SESSION_ID"] || undefined,
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

type Adapter = { handleCommand(command: HarnessCommand): Promise<void> };

function parseHarnessConfig(): HarnessConfig {
  const raw = process.env["HARNESS_CONFIG"];
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HarnessConfig;
  } catch (err) {
    console.warn("[harness] Failed to parse HARNESS_CONFIG:", raw, err);
    return {};
  }
}

async function createAdapter(
  env: HarnessEnv,
  deps: ClaudeAdapterDeps,
  log: { info(...args: unknown[]): void; error(...args: unknown[]): void },
): Promise<Adapter> {
  const config = parseHarnessConfig();

  switch (env.harnessType) {
    case "claude-sdk":
      return new ClaudeSdkAdapter(config, deps, {
        resumeSessionId: env.resumeSessionId,
        contextFolderPath: env.contextFolderPath,
      });

    case "pi": {
      // Import Pi SDK lazily — it's a large dependency tree
      const { join } = await import("node:path");

      let piSdk: typeof import("@mariozechner/pi-coding-agent");
      let piAi: typeof import("@mariozechner/pi-ai");
      try {
        piSdk = await import("@mariozechner/pi-coding-agent");
        piAi = await import("@mariozechner/pi-ai");
      } catch (err) {
        throw new Error(
          `Pi SDK not available: ${err instanceof Error ? err.message : err}. ` +
          `Install @mariozechner/pi-coding-agent and @mariozechner/pi-ai.`,
        );
      }

      const cwd = env.contextFolderPath ?? process.cwd();

      // Auth and model resolution
      const authStorage = piSdk.AuthStorage.create();
      const modelRegistry = new piSdk.ModelRegistry(authStorage);

      // Resolve a model string (e.g. "anthropic:claude-opus-4-5" or "claude-sonnet-4-5")
      // to a Pi SDK Model object via ModelRegistry / piAi.getModel.
      const resolveModelStr = (modelStr: string | undefined): unknown => {
        if (!modelStr) return undefined;
        const colonIdx = modelStr.indexOf(":");
        if (colonIdx >= 0) {
          const provider = modelStr.slice(0, colonIdx);
          const modelId = modelStr.slice(colonIdx + 1);
          try {
            return modelRegistry.find(provider, modelId) ?? piAi.getModel(provider as never, modelId as never);
          } catch (err) { log.info(`Model resolution failed for ${modelStr}:`, err); return undefined; }
        }
        // Bare model ID — try anthropic for claude-* models
        if (modelStr.startsWith("claude-")) {
          try {
            return modelRegistry.find("anthropic", modelStr) ?? piAi.getModel("anthropic" as never, modelStr as never);
          } catch (err) { log.info(`Model resolution failed for ${modelStr}:`, err); return undefined; }
        }
        return undefined;
      };
      const resolveModel = (): unknown => resolveModelStr(config.model);

      // Map maxThinkingTokens (number) to Pi's ThinkingLevel (string)
      const resolveThinkingLevel = (): string => {
        // Check Pi-native thinkingLevel in adapterConfig first
        const piLevel = (config.adapterConfig as Record<string, unknown> | undefined)?.["thinkingLevel"];
        if (typeof piLevel === "string") return piLevel;
        const mtk = config.maxThinkingTokens;
        if (!mtk || mtk === 0) return "off";
        if (mtk <= 1024) return "minimal";
        if (mtk <= 4096) return "low";
        if (mtk <= 16384) return "medium";
        if (mtk <= 65536) return "high";
        return "xhigh";
      };

      // Resource loader with skills enabled.
      // Default to appending the custom prompt to the SDK's built-in system prompt
      // so skill discovery, tool instructions, and coding guidelines are preserved.
      const promptMode = config.systemPromptMode ?? 'append';
      const resourceLoader = new piSdk.DefaultResourceLoader({
        cwd,
        additionalSkillPaths: [join(cwd, "skills")],
        settingsManager: piSdk.SettingsManager.inMemory(),
        ...(config.systemPrompt && promptMode === 'replace' && {
          systemPromptOverride: () => config.systemPrompt!,
        }),
        ...(config.systemPrompt && promptMode === 'append' && {
          appendSystemPrompt: config.systemPrompt,
        }),
      });
      await resourceLoader.reload();

      const piLog = {
        info: (...args: unknown[]) => log.info(...args),
        error: (...args: unknown[]) => log.error(...args),
        warn: (...args: unknown[]) => log.error("[warn]", ...args),
        debug: (...args: unknown[]) => log.info("[debug]", ...args),
      };

      const piDeps: PiAdapterDeps = {
        pushEvent: deps.pushEvent,
        callMethod: deps.callMethod,
        discoverMethods: deps.discoverMethods,
        createSession: async (options) => {
          // Resolve per-turn model string through ModelRegistry, fall back to config
          const model =
            (typeof options.model === "string"
              ? resolveModelStr(options.model)
              : options.model) ?? resolveModel();
          const { session } = await piSdk.createAgentSession({
            cwd: options.cwd,
            ...(model ? { model: model as never } : {}),
            thinkingLevel: ((options.thinkingLevel as string) ?? resolveThinkingLevel()) as never,
            customTools: (options.customTools ?? []) as never[],
            sessionManager: options.sessionManager as never,
            resourceLoader,
            authStorage,
            modelRegistry,
          });
          return session as unknown as PiSession;
        },
        createSessionManager: (cwdPath, resumeFile) => {
          const sm = resumeFile
            ? piSdk.SessionManager.open(resumeFile)
            : piSdk.SessionManager.create(cwdPath);
          return sm as unknown as PiSessionManager;
        },
        log: piLog,
      };

      return new PiAdapter(config, piDeps, {
        resumeSessionId: env.resumeSessionId,
        contextFolderPath: env.contextFolderPath,
      });
    }

    default:
      throw new Error(`Unknown harness type: ${env.harnessType}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = readEnv();
  const log = {
    info: (...args: unknown[]) =>
      console.log(`[harness:${env.harnessId}]`, ...args),
    error: (...args: unknown[]) =>
      console.error(`[harness:${env.harnessId}]`, ...args),
  };

  log.info(
    `Starting harness process (type=${env.harnessType}, context=${env.contextId})`,
  );

  // 1. Connect to the server via WebSocket and authenticate
  const { transport, ws } = await createHarnessTransport(
    env.rpcWsUrl,
    env.rpcAuthToken,
  );

  log.info("Authenticated with RPC server");

  // 2. Create the RPC bridge
  const selfId = env.harnessId;
  const bridge: RpcBridge = createRpcBridge({ selfId, transport });

  // 3. Pending maps for async tool execution and method discovery
  //    Tool calls and discover-methods are now async: the adapter emits events
  //    via pushEvent, the DO orchestrates, and results arrive as RPC calls.
  const pendingToolResults = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
  }>();
  const pendingDiscoverResults: Array<{
    resolve: (methods: DiscoveredMethod[]) => void;
    reject: (err: Error) => void;
  }> = [];

  // 4. Wire adapter deps — pushEvent through RPC, callMethod/discoverMethods via emit+wait
  const pushEvent = async (event: HarnessOutput): Promise<void> => {
    await bridge.call("main", "harness.pushEvent", env.harnessId, event);
  };

  const deps: ClaudeAdapterDeps = {
    pushEvent,
    callMethod: async (
      participantId: string,
      method: string,
      args: unknown,
    ): Promise<unknown> => {
      // Async tool execution: emit tool-call event, wait for tool-result.
      // Register the pending entry BEFORE emitting — the result may arrive
      // during the pushEvent await (synchronous dispatch through DO back to harness).
      const callId = randomUUID();
      log.info(`callMethod (async): ${method} -> ${participantId} (callId=${callId})`);
      const CALL_STALL_WARN_MS = 60_000;   // 60s: warn
      const CALL_HARD_TIMEOUT_MS = 360_000; // 6min: reject (above channel's 5min)
      const resultPromise = new Promise<unknown>((resolve, reject) => {
        const warnTimer = setTimeout(() => {
          log.error(`callMethod STALLED: ${method} -> ${participantId} (callId=${callId}) — waiting >60s for tool-result. Promise is still pending.`);
        }, CALL_STALL_WARN_MS);
        const hardTimer = setTimeout(() => {
          clearTimeout(warnTimer);
          pendingToolResults.delete(callId);
          log.error(`callMethod HARD TIMEOUT: ${method} -> ${participantId} (callId=${callId}) — rejecting after 6 minutes`);
          reject(new Error(`callMethod hard timeout: ${method} -> ${participantId} after 6 minutes`));
        }, CALL_HARD_TIMEOUT_MS);
        pendingToolResults.set(callId, {
          resolve: (v) => { clearTimeout(warnTimer); clearTimeout(hardTimer); resolve(v); },
          reject: (e) => { clearTimeout(warnTimer); clearTimeout(hardTimer); reject(e); },
        });
      });
      await pushEvent({
        type: 'tool-call',
        callId,
        participantId,
        method,
        args,
      });
      return resultPromise;
    },
    discoverMethods: async (): Promise<DiscoveredMethod[]> => {
      log.info("discoverMethods (async): emitting discover-methods event");
      // Register pending BEFORE emitting — result may arrive during pushEvent.
      const DISCOVER_STALL_WARN_MS = 10_000;
      const DISCOVER_HARD_TIMEOUT_MS = 60_000; // 1 minute for discover
      const resultPromise = new Promise<DiscoveredMethod[]>((resolve, reject) => {
        const warnTimer = setTimeout(() => {
          log.error(`discoverMethods STALLED — waiting >10s for discover-methods-result. Promise is still pending.`);
        }, DISCOVER_STALL_WARN_MS);
        const hardTimer = setTimeout(() => {
          clearTimeout(warnTimer);
          // Remove this pending entry from the array
          const idx = pendingDiscoverResults.findIndex(p => p.reject === rejectFn);
          if (idx !== -1) pendingDiscoverResults.splice(idx, 1);
          log.error(`discoverMethods HARD TIMEOUT — rejecting after 1 minute`);
          reject(new Error(`discoverMethods hard timeout after 1 minute`));
        }, DISCOVER_HARD_TIMEOUT_MS);
        const rejectFn = (e: unknown) => { clearTimeout(warnTimer); clearTimeout(hardTimer); reject(e); };
        pendingDiscoverResults.push({
          resolve: (v) => { clearTimeout(warnTimer); clearTimeout(hardTimer); resolve(v); },
          reject: rejectFn,
        });
      });
      await pushEvent({ type: 'discover-methods' });
      return resultPromise;
    },
    log,
  };

  // 5. Instantiate the adapter (async for Pi's dynamic SDK import)
  const adapter = await createAdapter(env, deps, log);

  // 6. Expose RPC methods the server can call
  //
  // startTurn and approveTool are fire-and-forget: they return immediately
  // so the server's RPC call resolves without blocking on the full AI turn.
  // Turn progress and completion flow back via pushEvent (the event stream).
  bridge.exposeMethod(
    "startTurn",
    async (input: TurnInput) => {
      void adapter.handleCommand({ type: "start-turn", input }).catch((err) => {
        log.error("startTurn failed:", err);
        void pushEvent({ type: "error", error: String(err), code: "ADAPTER_ERROR" }).catch((pushErr) => {
          log.error("Failed to report startTurn error via pushEvent:", pushErr);
        });
      });
    },
  );

  bridge.exposeMethod(
    "approveTool",
    async (toolUseId: string, allow: boolean, alwaysAllow?: boolean, updatedInput?: Record<string, unknown>) => {
      void adapter.handleCommand({
        type: "approve-tool",
        toolUseId,
        allow,
        alwaysAllow,
        updatedInput,
      }).catch((err) => {
        log.error("approveTool failed:", err);
        void pushEvent({ type: "error", error: String(err), code: "ADAPTER_ERROR" }).catch((pushErr) => {
          log.error("Failed to report approveTool error via pushEvent:", pushErr);
        });
      });
    },
  );

  bridge.exposeMethod("interrupt", async () => {
    await adapter.handleCommand({ type: "interrupt" });
    // Reject all pending tool results on interrupt
    for (const [callId, pending] of pendingToolResults) {
      pending.reject(new Error("Turn interrupted"));
      pendingToolResults.delete(callId);
    }
    for (const pending of pendingDiscoverResults) {
      pending.reject(new Error("Turn interrupted"));
    }
    pendingDiscoverResults.length = 0;
  });

  bridge.exposeMethod(
    "fork",
    async (forkPointMessageId: number, turnSessionId: string) => {
      await adapter.handleCommand({
        type: "fork",
        forkPointMessageId,
        turnSessionId,
      });
    },
  );

  bridge.exposeMethod("dispose", async () => {
    await adapter.handleCommand({ type: "dispose" });
    // Give a brief moment for the dispose response to be sent back
    setTimeout(() => process.exit(0), 100);
  });

  // New: tool-result command — resolves pending callMethod promise
  bridge.exposeMethod(
    "toolResult",
    async (callId: string, result: unknown, isError?: boolean) => {
      const pending = pendingToolResults.get(callId);
      if (pending) {
        pendingToolResults.delete(callId);
        if (isError) {
          pending.reject(new Error(typeof result === "string" ? result : JSON.stringify(result)));
        } else {
          pending.resolve(result);
        }
      } else {
        log.info(`toolResult: no pending call for callId=${callId} (may have been cancelled)`);
      }
    },
  );

  // New: discover-methods-result — resolves pending discoverMethods promise
  bridge.exposeMethod(
    "discoverMethodsResult",
    async (methods: DiscoveredMethod[]) => {
      const pending = pendingDiscoverResults.shift();
      if (pending) {
        pending.resolve(methods);
      } else {
        log.info("discoverMethodsResult: no pending discover request");
      }
    },
  );

  // 7. Handle WebSocket close — log and exit
  ws.on("close", (code, reason) => {
    log.error(`WebSocket closed (code=${code} reason=${reason.toString()})`);
    process.exit(1);
  });

  // 8. Handle graceful shutdown
  const shutdown = async () => {
    log.info("Received shutdown signal, disposing adapter...");
    try {
      await adapter.handleCommand({ type: "dispose" });
    } catch (err) {
      log.error("Error during shutdown dispose:", err);
    }
    ws.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // 9. Signal ready
  await pushEvent({ type: "ready" });
  log.info("Harness ready");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// Catch unhandled rejections — the Claude SDK's ProcessTransport can throw
// AbortError when a turn is interrupted, and these propagate as unhandled
// rejections. Log them instead of crashing the process.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // AbortErrors are expected during interrupts — log at info level
  if (reason instanceof Error && reason.name === "AbortError") {
    console.log(`[harness] Unhandled AbortError (expected during interrupt): ${msg}`);
  } else {
    console.error("[harness] Unhandled rejection:", reason);
  }
});

main().catch((err) => {
  console.error("[harness] Fatal startup error:", err);
  process.exit(1);
});

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
 * If the WebSocket drops, the process logs and exits. The HarnessManager
 * detects the crash and handles respawn logic.
 *
 * @module
 */

import { createRpcBridge } from "@natstack/rpc";
import type { RpcBridge } from "@natstack/rpc";
import { createHarnessTransport } from "./harness-transport.js";
import { ClaudeSdkAdapter } from "./claude-sdk-adapter.js";
import type { ClaudeAdapterDeps } from "./claude-sdk-adapter.js";
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
  channelId: string;
  contextId: string;
  contextFolderPath?: string;
  resumeSessionId?: string;
}

function readEnv(): HarnessEnv {
  const rpcWsUrl = process.env["RPC_WS_URL"];
  const rpcAuthToken = process.env["RPC_AUTH_TOKEN"];
  const harnessId = process.env["HARNESS_ID"];
  const harnessType = process.env["HARNESS_TYPE"];
  const channelId = process.env["CHANNEL_ID"];
  const contextId = process.env["CONTEXT_ID"];

  if (!rpcWsUrl || !rpcAuthToken || !harnessId || !harnessType || !channelId || !contextId) {
    const missing = [
      !rpcWsUrl && "RPC_WS_URL",
      !rpcAuthToken && "RPC_AUTH_TOKEN",
      !harnessId && "HARNESS_ID",
      !harnessType && "HARNESS_TYPE",
      !channelId && "CHANNEL_ID",
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
    channelId,
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
  } catch {
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

      // Resolve model from harness config (e.g. "anthropic:claude-opus-4-5" or "claude-sonnet-4-5")
      const resolveModel = (): unknown => {
        const modelStr = config.model;
        if (!modelStr) return undefined;
        const colonIdx = modelStr.indexOf(":");
        if (colonIdx >= 0) {
          const provider = modelStr.slice(0, colonIdx);
          const modelId = modelStr.slice(colonIdx + 1);
          try {
            return modelRegistry.find(provider, modelId) ?? piAi.getModel(provider as never, modelId as never);
          } catch { return undefined; }
        }
        // Bare model ID — try anthropic for claude-* models
        if (modelStr.startsWith("claude-")) {
          try {
            return modelRegistry.find("anthropic", modelStr) ?? piAi.getModel("anthropic" as never, modelStr as never);
          } catch { return undefined; }
        }
        return undefined;
      };

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
      // The context folder is a copy of the workspace and contains skills/ at its root.
      // Pi SDK doesn't auto-discover bare `skills/` — only `.pi/skills/` and `.agents/skills/` —
      // so we point it there explicitly via additionalSkillPaths.
      const resourceLoader = new piSdk.DefaultResourceLoader({
        cwd,
        additionalSkillPaths: [join(cwd, "skills")],
        settingsManager: piSdk.SettingsManager.inMemory(),
        ...(config.systemPrompt && {
          systemPromptOverride: () => config.systemPrompt!,
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
          const model = resolveModel();
          const { session } = await piSdk.createAgentSession({
            cwd: options.cwd,
            ...(model && { model: model as never }),
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

  // 3. Wire adapter deps — all external calls go through the RPC bridge
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
      log.info(`callMethod: ${method} -> ${participantId} on ${env.channelId}`);
      try {
        const result = await bridge.call("main", "channel.callMethod", env.channelId, participantId, method, args);
        log.info(`callMethod result: ${method} (type: ${typeof result})`);
        return result;
      } catch (err) {
        log.error(`callMethod failed: ${method} -> ${participantId}:`, err);
        throw err;
      }
    },
    discoverMethods: async () => {
      return bridge.call("main", "channel.discoverMethods", env.channelId);
    },
    log,
  };

  // 4. Instantiate the adapter (async for Pi's dynamic SDK import)
  const adapter = await createAdapter(env, deps, log);

  // 5. Expose RPC methods the server can call
  //
  // startTurn and approveTool are fire-and-forget: they return immediately
  // so the server's RPC call resolves without blocking on the full AI turn.
  // Turn progress and completion flow back via pushEvent (the event stream).
  bridge.exposeMethod(
    "startTurn",
    async (input: TurnInput) => {
      void adapter.handleCommand({ type: "start-turn", input }).catch((err) => {
        log.error("startTurn failed:", err);
        void pushEvent({ type: "error", error: String(err) }).catch((pushErr) => {
          log.error("Failed to report startTurn error via pushEvent:", pushErr);
        });
      });
    },
  );

  bridge.exposeMethod(
    "approveTool",
    async (toolUseId: string, allow: boolean, alwaysAllow?: boolean) => {
      void adapter.handleCommand({
        type: "approve-tool",
        toolUseId,
        allow,
        alwaysAllow,
      }).catch((err) => {
        log.error("approveTool failed:", err);
        void pushEvent({ type: "error", error: String(err) }).catch((pushErr) => {
          log.error("Failed to report approveTool error via pushEvent:", pushErr);
        });
      });
    },
  );

  bridge.exposeMethod("interrupt", async () => {
    await adapter.handleCommand({ type: "interrupt" });
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

  // 6. Handle WebSocket close — log and exit
  ws.on("close", (code, reason) => {
    log.error(`WebSocket closed (code=${code} reason=${reason.toString()})`);
    process.exit(1);
  });

  // 7. Handle graceful shutdown
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

  // 8. Signal ready
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

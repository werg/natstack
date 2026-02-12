/**
 * Shared service orchestration for Electron and headless entry points.
 *
 * `startCoreServices` runs the service init sequence in dependency order
 * and returns a handle for deferred AI service registration and shutdown.
 * It is **fail-fast** — throws on error. Callers control error policy:
 *   - Electron wraps in try/catch and still calls markInitialized()
 *   - Server lets the error propagate to main().catch() and exits
 *
 * On partial failure, already-started resources are cleaned up before the
 * error is re-thrown (cleanup-on-error stack).
 */

import * as path from "path";
import { createDevLogger } from "./devLog.js";
import { getUserDataPath } from "./envPaths.js";
import { getAppRoot } from "./paths.js";
import { createVerdaccioServer, type VerdaccioServer } from "./verdaccioServer.js";
import { getTypeDefinitionService, typeCheckRpcMethods } from "./typecheck/service.js";
import { getNatstackPackageWatcher, shutdownNatstackWatcher } from "./natstackPackageWatcher.js";
import { createGitWatcher, type GitWatcher } from "./workspace/gitWatcher.js";
import { getPubSubServer } from "./pubsubServer.js";
import { initAgentDiscovery, shutdownAgentDiscovery } from "./agentDiscovery.js";
import { initAgentSettingsService, shutdownAgentSettingsService } from "./agentSettings.js";
import { initAgentHost, shutdownAgentHost, setAgentHostAiHandler } from "./agentHost.js";
import { getTokenManager } from "./tokenManager.js";
import { getServiceDispatcher } from "./serviceDispatcher.js";
import { handleAgentSettingsCall } from "./ipc/agentSettingsHandlers.js";
import { handleDbCall } from "./ipc/dbHandlers.js";
import { getDatabaseManager } from "./db/databaseManager.js";
import { handleAiServiceCall } from "./ipc/aiHandlers.js";
import type { Workspace } from "./workspace/types.js";
import type { GitServer } from "./gitServer.js";
import type { AIHandler } from "./ai/aiHandler.js";
import type { RpcServer } from "../server/rpcServer.js";

const log = createDevLogger("CoreServices");

export interface CoreServicesHandle {
  aiHandler: AIHandler;
  gitServer: GitServer;
  verdaccioServer: VerdaccioServer;
  gitWatcher: GitWatcher;
  pubsubPort: number;
  /** Register the "ai" dispatcher service (deferred — caller creates rpcServer first). */
  registerAiService(rpcServer: RpcServer): void;
  /** Stop core services only (not rpcServer, cdpServer, or global singletons). */
  shutdown(): Promise<void>;
}

export async function startCoreServices({
  workspace,
  gitServer,
}: {
  workspace: Workspace;
  gitServer: GitServer;
}): Promise<CoreServicesHandle> {
  // Cleanup stack: on partial failure, run these in reverse order before re-throwing.
  const cleanups: (() => void | Promise<void>)[] = [];

  try {
    // Step 1: Agent discovery + settings
    await initAgentDiscovery(workspace.path);
    cleanups.push(() => shutdownAgentDiscovery());
    log.info("[AgentDiscovery] Initialized");

    await initAgentSettingsService();
    cleanups.push(() => shutdownAgentSettingsService());
    log.info("[AgentSettingsService] Initialized");

    // Step 2: Verdaccio
    const verdaccioServer = createVerdaccioServer({
      workspaceRoot: getAppRoot(),
      storagePath: path.join(getUserDataPath(), "verdaccio-storage"),
    });
    verdaccioServer.setNatstackPublishHook(() =>
      getTypeDefinitionService().invalidateNatstackTypes()
    );
    await verdaccioServer.buildAllWorkspacePackages();
    await verdaccioServer.start();
    cleanups.push(() => verdaccioServer.stop());
    log.info(`[Verdaccio] Registry started on port ${verdaccioServer.getPort()}`);

    const publishResult = await verdaccioServer.publishChangedPackages();
    if (publishResult.changesDetected.changed.length > 0) {
      log.info(
        `[Verdaccio] Synced ${publishResult.changesDetected.changed.length} packages: ${publishResult.changesDetected.changed.join(", ")}`
      );
    } else {
      log.info("[Verdaccio] All packages up-to-date");
    }

    // Step 3: NatstackPackageWatcher
    const natstackWatcher = getNatstackPackageWatcher(getAppRoot());
    await natstackWatcher.initialize((pkgPath, pkgName) =>
      verdaccioServer.republishPackage(pkgPath, pkgName)
    );
    cleanups.push(() => void shutdownNatstackWatcher());
    log.info("[NatstackWatcher] Watching packages/ for file changes");

    // Step 4: GitServer
    await gitServer.start();
    cleanups.push(() => gitServer.stop());
    log.info(`[Git] Server started on port ${gitServer.getPort()}`);

    // Step 5: GitWatcher + subscriptions
    const gitWatcher = createGitWatcher(workspace);
    cleanups.push(() => gitWatcher.close());
    log.info("[GitWatcher] Started watching workspace for git changes");
    gitServer.subscribeToGitWatcher(gitWatcher);
    await verdaccioServer.subscribeToGitWatcher(gitWatcher, workspace.path);

    // Step 6: PubSub
    const pubsubServer = getPubSubServer();
    const pubsubPort = await pubsubServer.start();
    cleanups.push(() => pubsubServer.stop());
    log.info(`[PubSub] Server started on port ${pubsubPort}`);

    // Step 7: AgentHost
    const agentHost = initAgentHost({
      workspaceRoot: workspace.path,
      pubsubUrl: `ws://127.0.0.1:${pubsubPort}`,
      messageStore: pubsubServer.getMessageStore(),
      createToken: (instanceId) =>
        getTokenManager().createToken(instanceId, "worker"),
      revokeToken: (instanceId) => getTokenManager().revokeToken(instanceId),
    });
    await agentHost.initialize();
    cleanups.push(() => shutdownAgentHost());
    pubsubServer.setAgentHost(agentHost);
    log.info("[AgentHost] Initialized");

    // Step 8: AI handler
    const { AIHandler: AIHandlerClass } = await import("./ai/aiHandler.js");
    const aiHandler = new AIHandlerClass();
    await aiHandler.initialize();
    setAgentHostAiHandler(aiHandler);

    // Register shared dispatcher services
    const dispatcher = getServiceDispatcher();

    dispatcher.register(
      "agentSettings",
      async (_ctx, serviceMethod, serviceArgs) => {
        return handleAgentSettingsCall(
          serviceMethod,
          serviceArgs as unknown[]
        );
      }
    );

    dispatcher.register("db", async (ctx, serviceMethod, serviceArgs) => {
      return handleDbCall(
        getDatabaseManager(),
        ctx.callerId,
        serviceMethod,
        serviceArgs
      );
    });

    dispatcher.register(
      "typecheck",
      async (_ctx, serviceMethod, serviceArgs) => {
        const args = serviceArgs as unknown[];
        switch (serviceMethod) {
          case "getPackageTypes":
            return typeCheckRpcMethods["typecheck.getPackageTypes"](
              args[0] as string,
              args[1] as string
            );
          case "getPackageTypesBatch":
            return typeCheckRpcMethods["typecheck.getPackageTypesBatch"](
              args[0] as string,
              args[1] as string[]
            );
          case "check":
            return typeCheckRpcMethods["typecheck.check"](
              args[0] as string,
              args[1] as string | undefined,
              args[2] as string | undefined
            );
          case "getTypeInfo":
            return typeCheckRpcMethods["typecheck.getTypeInfo"](
              args[0] as string,
              args[1] as string,
              args[2] as number,
              args[3] as number,
              args[4] as string | undefined
            );
          case "getCompletions":
            return typeCheckRpcMethods["typecheck.getCompletions"](
              args[0] as string,
              args[1] as string,
              args[2] as number,
              args[3] as number,
              args[4] as string | undefined
            );
          default:
            throw new Error(`Unknown typecheck method: ${serviceMethod}`);
        }
      }
    );

    // Success — return handle. The cleanup stack is NOT run on success;
    // instead, the returned shutdown() uses the same teardown order.
    return {
      aiHandler,
      gitServer,
      verdaccioServer,
      gitWatcher,
      pubsubPort,

      registerAiService(rpcServer: RpcServer) {
        dispatcher.register("ai", async (ctx, method, serviceArgs) => {
          return handleAiServiceCall(
            aiHandler,
            method,
            serviceArgs,
            (handler, options, streamId) => {
              if (!ctx.wsClient) {
                throw new Error("AI streaming requires a WS connection");
              }
              const target = rpcServer.createWsStreamTarget(
                ctx.wsClient,
                streamId
              );
              handler.startTargetStream(target, options, streamId);
            }
          );
        });
      },

      async shutdown() {
        // Synchronous stops first
        shutdownAgentSettingsService();
        shutdownAgentDiscovery();
        shutdownAgentHost();
        void shutdownNatstackWatcher();

        // Parallel async stops (each individually caught)
        await Promise.all([
          gitServer
            .stop()
            .then(() => log.info("[Git] Server stopped"))
            .catch((e) =>
              console.error("[CoreServices] Git stop error:", e)
            ),
          gitWatcher
            .close()
            .then(() => log.info("[GitWatcher] Stopped"))
            .catch((e) =>
              console.error("[CoreServices] GitWatcher stop error:", e)
            ),
          pubsubServer
            .stop()
            .then(() => log.info("[PubSub] Server stopped"))
            .catch((e) =>
              console.error("[CoreServices] PubSub stop error:", e)
            ),
          verdaccioServer
            .stop()
            .then(() => log.info("[Verdaccio] Server stopped"))
            .catch((e) =>
              console.error("[CoreServices] Verdaccio stop error:", e)
            ),
        ]);
      },
    };
  } catch (error) {
    // Partial failure — clean up already-started resources in reverse order
    log.info("[CoreServices] Partial init failure, cleaning up started resources...");
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (e) {
        console.error("[CoreServices] Cleanup error:", e);
      }
    }
    throw error;
  }
}

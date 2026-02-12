/**
 * Proxy service registration — registers proxy handlers on Electron's
 * ServiceDispatcher for backend services that run on the server.
 *
 * Simple proxies forward calls directly. The AI proxy additionally
 * registers a stream bridge so server-side stream chunks reach the panel.
 */

import type { ServiceContext } from "./serviceDispatcher.js";
import { getServiceDispatcher } from "./serviceDispatcher.js";
import type { ServerClient } from "./serverClient.js";

/**
 * Register proxy handlers on Electron's dispatcher for backend services.
 * All handlers use getClient() to obtain the current server client.
 */
export function registerProxyServices(
  getClient: () => ServerClient
): void {
  const dispatcher = getServiceDispatcher();

  // Simple proxies: db, typecheck, agentSettings
  for (const service of ["db", "typecheck", "agentSettings"] as const) {
    dispatcher.register(service, async (_ctx, method, args) => {
      return getClient().call(service, method, args as unknown[]);
    });
  }

  // AI proxy with streaming support
  dispatcher.register("ai", async (ctx: ServiceContext, method, args) => {
    const client = getClient();

    // Block reinitialize from non-server callers — the proxy would launder
    // the callerKind to "server" since it uses the admin WS connection.
    if (method === "reinitialize" && ctx.callerKind !== "server") {
      throw new Error("ai.reinitialize is restricted to server callers");
    }

    if (method === "streamTextStart") {
      // args = [options, streamId]
      const streamId = (args as unknown[])[1] as string;
      if (ctx.wsClient) {
        client.bridgeStream(streamId, ctx.wsClient.ws);
      }
    }

    return client.call("ai", method, args as unknown[]);
  });
}

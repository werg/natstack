/**
 * PanelHttpProxy — RPC-backed PanelHttpServerLike for Electron.
 *
 * Wraps server's PanelHttpServer via RPC. All panel HTTP operations go through
 * the server; Electron never hosts its own PanelHttpServer.
 */

import type { PanelHttpServerLike } from "@natstack/shared/panelInterfaces";
import type { ServerClient } from "./serverClient.js";

/**
 * Create an RPC-backed PanelHttpServerLike that delegates to the server's panel HTTP service.
 * `getPort()` returns the gateway port (mandatory — always known after server connection).
 */
export function createPanelHttpProxy(client: ServerClient, port: number): PanelHttpServerLike {
  return {
    ensureSubdomainSession: (subdomain) =>
      client.call("panelHttp", "ensureSubdomainSession", [subdomain]) as Promise<string>,
    clearSubdomainSessions: (subdomain) => {
      void client.call("panelHttp", "clearSubdomainSessions", [subdomain]).catch(() => {});
    },
    hasBuild: (_source) => false, // Conservative — server tracks build cache
    invalidateBuild: (source) => {
      void client.call("panelHttp", "invalidateBuild", [source]).catch(() => {});
    },
    getPort: () => port,
  };
}

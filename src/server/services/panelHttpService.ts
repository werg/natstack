/**
 * PanelHttp RPC service — wraps PanelHttpServer operations.
 *
 * Allows Electron (or any RPC client) to interact with the PanelHttpServer
 * via RPC instead of direct object references.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { PanelHttpServerLike } from "@natstack/shared/panelInterfaces";

export function createPanelHttpService(deps: {
  panelHttpServer: PanelHttpServerLike;
}): ServiceDefinition {
  const { panelHttpServer } = deps;

  return {
    name: "panelHttp",
    description: "Panel HTTP server operations (sessions, builds)",
    policy: { allowed: ["shell", "server"] },
    methods: {
      ensureSubdomainSession: { args: z.tuple([z.string()]) },
      clearSubdomainSessions: { args: z.tuple([z.string()]) },
      hasBuild: { args: z.tuple([z.string()]) },
      invalidateBuild: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      const a = args as unknown[];

      switch (method) {
        case "ensureSubdomainSession": {
          const [subdomain] = a as [string];
          return panelHttpServer.ensureSubdomainSession(subdomain);
        }

        case "clearSubdomainSessions": {
          const [subdomain] = a as [string];
          panelHttpServer.clearSubdomainSessions(subdomain);
          return;
        }

        case "hasBuild": {
          const [source] = a as [string];
          return panelHttpServer.hasBuild(source);
        }

        case "invalidateBuild": {
          const [source] = a as [string];
          panelHttpServer.invalidateBuild(source);
          return;
        }

        default:
          throw new Error(`Unknown panelHttp method: ${method}`);
      }
    },
  };
}

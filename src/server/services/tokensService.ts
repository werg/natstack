import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { TokenManager } from "../../shared/tokenManager.js";
import type { CallerKind } from "../../shared/serviceDispatcher.js";

export function createTokensService(deps: {
  tokenManager: TokenManager;
}): ServiceDefinition {
  return {
    name: "tokens",
    description: "Token management (create/revoke panel tokens)",
    policy: { allowed: ["server"] },
    methods: {
      create: { args: z.tuple([z.string(), z.string()]) },
      ensure: { args: z.tuple([z.string(), z.string()]) },
      revoke: { args: z.tuple([z.string()]) },
      get: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      const tm = deps.tokenManager;
      switch (method) {
        case "create": return tm.createToken(args[0] as string, args[1] as CallerKind);
        case "ensure": return tm.ensureToken(args[0] as string, args[1] as CallerKind);
        case "revoke": tm.revokeToken(args[0] as string); return;
        case "get": try { return tm.getToken(args[0] as string); } catch { return null; }
        default: throw new Error(`Unknown tokens method: ${method}`);
      }
    },
  };
}

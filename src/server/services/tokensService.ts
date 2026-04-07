import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import type { FsService } from "@natstack/shared/fsService";
import type { GitServer } from "@natstack/git-server";

export function createTokensService(deps: {
  tokenManager: TokenManager;
  fsService: FsService;
  gitServer: GitServer;
}): ServiceDefinition {
  return {
    name: "tokens",
    description: "Token management (create/revoke panel tokens)",
    policy: { allowed: ["server", "shell"] },
    methods: {
      create: { args: z.tuple([z.string(), z.string()]) },
      ensure: { args: z.tuple([z.string(), z.string()]) },
      revoke: { args: z.tuple([z.string()]) },
      get: { args: z.tuple([z.string()]) },
      ensurePanelToken: { args: z.tuple([z.string(), z.string(), z.string().nullable().optional()]) },
      revokePanelToken: { args: z.tuple([z.string()]) },
      updatePanelContext: { args: z.tuple([z.string(), z.string()]) },
      updatePanelParent: { args: z.tuple([z.string(), z.string().nullable()]) },
    },
    handler: async (_ctx, method, args) => {
      const tm = deps.tokenManager;
      switch (method) {
        case "create": return tm.createToken(args[0] as string, args[1] as CallerKind);
        case "ensure": return tm.ensureToken(args[0] as string, args[1] as CallerKind);
        case "revoke": tm.revokeToken(args[0] as string); return;
        case "get": try { return tm.getToken(args[0] as string); } catch { return null; }
        case "ensurePanelToken": {
          const [panelId, contextId, parentId] = args as [string, string, string | null | undefined];
          const token = tm.ensureToken(panelId, "panel");
          tm.setPanelParent(panelId, parentId ?? null);
          deps.fsService.registerCallerContext(panelId, contextId);
          const gitToken = deps.gitServer.getTokenForPanel(panelId);
          return { token, gitToken };
        }
        case "revokePanelToken": {
          const [panelId] = args as [string];
          tm.revokeToken(panelId);
          deps.fsService.unregisterCallerContext(panelId);
          deps.gitServer.revokeTokenForPanel(panelId);
          return;
        }
        case "updatePanelContext": {
          const [panelId, contextId] = args as [string, string];
          deps.fsService.updateCallerContext(panelId, contextId);
          return;
        }
        case "updatePanelParent": {
          const [panelId, parentId] = args as [string, string | null];
          tm.setPanelParent(panelId, parentId);
          return;
        }
        default: throw new Error(`Unknown tokens method: ${method}`);
      }
    },
  };
}

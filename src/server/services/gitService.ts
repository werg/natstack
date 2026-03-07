import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { GitServer } from "../../main/gitServer.js";
import type { TokenManager } from "../../main/tokenManager.js";
import type { ContextFolderManager } from "../../main/contextFolderManager.js";

export function createGitService(deps: {
  gitServer: GitServer;
  tokenManager: TokenManager;
  contextFolderManager: ContextFolderManager;
}): ServiceDefinition {
  return {
    name: "git",
    description: "Git operations and scoped filesystem access for panels",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {
      getWorkspaceTree: { args: z.tuple([]) },
      listBranches: { args: z.tuple([z.string()]) },
      listCommits: { args: z.tuple([z.string(), z.string(), z.number()]) },
      getBaseUrl: { args: z.tuple([]) },
      getTokenForPanel: { args: z.tuple([z.string()]) },
      revokeTokenForPanel: { args: z.tuple([z.string()]) },
      resolveRef: { args: z.tuple([z.string(), z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      const g = deps.gitServer;

      // Context-scoped git operations (from agentic tools)
      if (method.startsWith("context")) {
        const { handleGitContextCall } = await import("../../main/services/gitContextService.js");
        return handleGitContextCall(
          deps.contextFolderManager, g, deps.tokenManager, method, args as unknown[],
        );
      }

      switch (method) {
        case "getWorkspaceTree": return g.getWorkspaceTree();
        case "listBranches": return g.listBranches(args[0] as string);
        case "listCommits": return g.listCommits(args[0] as string, args[1] as string, args[2] as number);
        case "getBaseUrl": return g.getBaseUrl();
        case "getTokenForPanel": return g.getTokenForPanel(args[0] as string);
        case "revokeTokenForPanel": g.revokeTokenForPanel(args[0] as string); return;
        case "resolveRef": return g.resolveRef(args[0] as string, args[1] as string);
        default: throw new Error(`Unknown git method: ${method}`);
      }
    },
  };
}

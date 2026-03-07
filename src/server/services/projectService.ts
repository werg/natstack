import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { ContextFolderManager } from "../../shared/contextFolderManager.js";
import type { GitServer } from "../../shared/gitServer.js";
import type { TokenManager } from "../../shared/tokenManager.js";

export function createProjectService(deps: {
  contextFolderManager: ContextFolderManager;
  gitServer: GitServer;
  tokenManager: TokenManager;
}): ServiceDefinition {
  return {
    name: "project",
    description: "Scaffold new workspace projects",
    policy: { allowed: ["panel", "server"] },
    methods: {
      create: { args: z.tuple([z.string()]).rest(z.unknown()) },
    },
    handler: async (_ctx, method, args) => {
      const { handleProjectCall } = await import("../../shared/services/projectService.js");
      return handleProjectCall(
        deps.contextFolderManager,
        deps.gitServer,
        deps.tokenManager,
        method,
        args as unknown[],
      );
    },
  };
}

import { z } from "zod";
import type { ServiceDefinition } from "../../main/serviceDefinition.js";
import type { ContextFolderManager } from "../../main/contextFolderManager.js";

export function createTestService(deps: {
  contextFolderManager: ContextFolderManager;
  workspacePath: string;
  panelTestSetupPath: string;
}): ServiceDefinition {
  return {
    name: "test",
    description: "Run tests on workspace panels/packages",
    policy: { allowed: ["panel", "server"] },
    methods: {
      run: { args: z.tuple([z.string()]).rest(z.unknown()) },
    },
    handler: async (_ctx, method, args) => {
      const { handleTestCall } = await import("../../main/services/testRunnerService.js");
      return handleTestCall(
        {
          contextFolderManager: deps.contextFolderManager,
          workspaceRoot: deps.workspacePath,
          panelTestSetupPath: deps.panelTestSetupPath,
        },
        method,
        args as unknown[],
      );
    },
  };
}

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ContextFolderManager } from "@natstack/shared/contextFolderManager";

export function createTestService(deps: {
  contextFolderManager: ContextFolderManager;
  workspacePath: string;
  panelTestSetupPath: string;
}): ServiceDefinition {
  return {
    name: "test",
    description: "Run tests on workspace panels/packages",
    // Security: restricted to server-only. Panels and workers must not invoke
    // test.run directly — vitest executes arbitrary *.test.ts files from
    // panel context folders inside the server process, enabling RCE with
    // access to admin tokens and gateway secrets.
    // If a panel needs to trigger tests, route through a server-side API that
    // adds proper sandboxing and explicit approval gating.
    policy: { allowed: ["server"] },
    methods: {
      run: { args: z.tuple([z.string()]).rest(z.unknown()) },
    },
    handler: async (_ctx, method, args) => {
      const { handleTestCall } = await import("@natstack/shared/services/testRunnerService");
      return handleTestCall(
        {
          contextFolderManager: deps.contextFolderManager,
          workspaceRoot: deps.workspacePath,
          panelTestSetupPath: deps.panelTestSetupPath,
        },
        method,
        args as unknown[]
      );
    },
  };
}

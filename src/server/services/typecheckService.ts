import * as path from "path";
import { z } from "zod";
import type { ServiceDefinition } from "../../main/serviceDefinition.js";
import type { ContextFolderManager } from "../../main/contextFolderManager.js";
import { resolveWithinContext, validateFilePathWithinRoot } from "../../main/services/contextPaths.js";

export function createTypecheckService(deps: {
  contextFolderManager: ContextFolderManager;
}): ServiceDefinition {
  return {
    name: "typecheck",
    description: "Type definition fetching for panels",
    policy: { allowed: ["panel", "server"] },
    methods: {
      getPackageTypes: { args: z.tuple([z.string(), z.string()]) },
      getPackageTypesBatch: { args: z.tuple([z.string(), z.array(z.string())]) },
      check: { args: z.tuple([z.string()]).rest(z.unknown()) },
      getTypeInfo: { args: z.tuple([z.string()]).rest(z.unknown()) },
      getCompletions: { args: z.tuple([z.string()]).rest(z.unknown()) },
    },
    handler: async (_ctx, method, args) => {
      const { typeCheckRpcMethods } = await import("../../main/typecheck/service.js");

      const resolvePanelPath = async (
        panelPath: string,
        ctxId: string | undefined,
      ): Promise<string> => {
        if (ctxId) {
          if (path.isAbsolute(panelPath)) {
            throw new Error("Absolute panel_path is not allowed when contextId is set — use a relative path");
          }
          const ctxRoot = await deps.contextFolderManager.ensureContextFolder(ctxId);
          return resolveWithinContext(ctxRoot, panelPath);
        }
        return panelPath;
      };

      const validateFilePath = (resolvedPanelPath: string, filePath: string | undefined): void => {
        if (!filePath) return;
        validateFilePathWithinRoot(resolvedPanelPath, filePath);
      };

      switch (method) {
        case "getPackageTypes":
          return typeCheckRpcMethods["typecheck.getPackageTypes"](
            args[0] as string,
            args[1] as string,
          );
        case "getPackageTypesBatch":
          return typeCheckRpcMethods["typecheck.getPackageTypesBatch"](
            args[0] as string,
            args[1] as string[],
          );
        case "check": {
          const panelPath = await resolvePanelPath(args[0] as string, args[3] as string | undefined);
          validateFilePath(panelPath, args[1] as string | undefined);
          return typeCheckRpcMethods["typecheck.check"](panelPath, args[1] as string | undefined, args[2] as string | undefined);
        }
        case "getTypeInfo": {
          const panelPath = await resolvePanelPath(args[0] as string, args[5] as string | undefined);
          validateFilePath(panelPath, args[1] as string | undefined);
          return typeCheckRpcMethods["typecheck.getTypeInfo"](panelPath, args[1] as string, args[2] as number, args[3] as number, args[4] as string | undefined);
        }
        case "getCompletions": {
          const panelPath = await resolvePanelPath(args[0] as string, args[5] as string | undefined);
          validateFilePath(panelPath, args[1] as string | undefined);
          return typeCheckRpcMethods["typecheck.getCompletions"](panelPath, args[1] as string, args[2] as number, args[3] as number, args[4] as string | undefined);
        }
        default:
          throw new Error(`Unknown typecheck method: ${method}`);
      }
    },
  };
}

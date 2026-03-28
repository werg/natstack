import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { ContextFolderManager } from "../../shared/contextFolderManager.js";
import { resolveContextScope } from "../../shared/contextMiddleware.js";

/**
 * Extract a panel source path from a caller ID.
 *
 * Caller IDs follow the scheme produced by computePanelId:
 *   - Root panels: `tree/{escapedPath}/{nonce}`
 *   - Named children: `tree/{escapedPath}/{nonce}/{childName}`
 *
 * The escaped path uses `~` in place of `/`, e.g. `panels/chat` → `panels~chat`.
 * We extract the first escaped-path segment after `tree/` and un-escape it.
 *
 * Returns undefined if the callerId doesn't match the expected pattern.
 */
function extractPanelSourceFromCallerId(callerId: string): string | undefined {
  // Expected: "tree/panels~something/nonce..." or "tree/panels~some~deeper/nonce..."
  if (!callerId.startsWith("tree/")) return undefined;
  const afterTree = callerId.slice("tree/".length); // "panels~chat/lk2f8g-3a1b9c4e"
  // The first segment is the escaped path (may contain ~)
  const slashIdx = afterTree.indexOf("/");
  const segment = slashIdx >= 0 ? afterTree.slice(0, slashIdx) : afterTree;
  if (!segment) return undefined;
  // Un-escape: ~ → /
  const sourcePath = segment.replace(/~/g, "/");
  // Sanity: should start with "panels/" or "packages/" or similar workspace path
  return sourcePath;
}

export function createTypecheckService(deps: {
  contextFolderManager: ContextFolderManager;
}): ServiceDefinition {
  return {
    name: "typecheck",
    description: "TypeScript type checking for panels and packages",
    policy: { allowed: ["panel", "server", "worker"] },
    methods: {
      // ── New simplified method for agents ──────────────────────────────
      checkPanel: {
        description:
          "Type-check a panel. Pass the panel source path (e.g. \"panels/chat\"), " +
          "or omit it to auto-detect from the caller's context.",
        args: z.tuple([]).or(z.tuple([z.string().describe("Panel source path, e.g. \"panels/my-app\"")])),
      },

      // ── Existing methods with explicit schemas ───────────────────────
      getPackageTypes: {
        args: z.tuple([
          z.string().describe("Panel source path"),
          z.string().describe("Package name"),
        ]),
      },
      getPackageTypesBatch: {
        args: z.tuple([
          z.string().describe("Panel source path"),
          z.array(z.string()).describe("Package names"),
        ]),
      },
      check: {
        args: z.tuple([
          z.string().describe("Panel source path"),
          z.string().optional().describe("File path (relative to panel) to check, or omit for whole panel"),
          z.string().optional().describe("File content override (skip disk read)"),
          z.string().optional().describe("Context ID for path resolution"),
        ]),
      },
      getTypeInfo: {
        args: z.tuple([
          z.string().describe("Panel source path"),
          z.string().describe("File path (relative to panel)"),
          z.number().describe("Line number (1-based)"),
          z.number().describe("Column number (1-based)"),
          z.string().optional().describe("File content override"),
          z.string().optional().describe("Context ID for path resolution"),
        ]),
      },
      getCompletions: {
        args: z.tuple([
          z.string().describe("Panel source path"),
          z.string().describe("File path (relative to panel)"),
          z.number().describe("Line number (1-based)"),
          z.number().describe("Column number (1-based)"),
          z.string().optional().describe("File content override"),
          z.string().optional().describe("Context ID for path resolution"),
        ]),
      },
    },
    handler: async (ctx, method, args) => {
      const { typeCheckRpcMethods } = await import("../../shared/typecheck/service.js");

      const resolvePanelPath = async (
        panelPath: string,
        ctxId: string | undefined,
      ): Promise<string> => {
        if (ctxId) {
          const scope = await resolveContextScope(deps.contextFolderManager, ctxId);
          return scope.resolvePath(panelPath);
        }
        return panelPath;
      };

      const validateFilePath = async (
        resolvedPanelPath: string,
        filePath: string | undefined,
        ctxId: string | undefined,
      ): Promise<void> => {
        if (!filePath) return;
        if (ctxId) {
          const scope = await resolveContextScope(deps.contextFolderManager, ctxId);
          scope.validatePath(filePath);
        }
      };

      switch (method) {
        // ── New simplified method ──────────────────────────────────────
        case "checkPanel": {
          // Determine panel source path
          let panelPath = args[0] as string | undefined;
          if (!panelPath) {
            panelPath = extractPanelSourceFromCallerId(ctx.callerId);
            if (!panelPath) {
              throw new Error(
                "Could not auto-detect panel path from caller ID. " +
                "Please pass the panel source path explicitly, e.g. typecheck.checkPanel(\"panels/my-app\")",
              );
            }
          }

          // Auto-resolve using caller's context if available
          const resolvedPath = await resolvePanelPath(panelPath, undefined);

          const result = await typeCheckRpcMethods["typecheck.check"](resolvedPath, undefined, undefined);

          const errorCount = result.diagnostics.filter((d: { severity: string }) => d.severity === "error").length;
          const warningCount = result.diagnostics.filter((d: { severity: string }) => d.severity === "warning").length;

          return {
            diagnostics: result.diagnostics,
            errorCount,
            warningCount,
          };
        }

        // ── Existing methods (backward-compatible) ─────────────────────
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
          await validateFilePath(panelPath, args[1] as string | undefined, args[3] as string | undefined);
          return typeCheckRpcMethods["typecheck.check"](panelPath, args[1] as string | undefined, args[2] as string | undefined);
        }
        case "getTypeInfo": {
          const panelPath = await resolvePanelPath(args[0] as string, args[5] as string | undefined);
          await validateFilePath(panelPath, args[1] as string | undefined, args[5] as string | undefined);
          return typeCheckRpcMethods["typecheck.getTypeInfo"](panelPath, args[1] as string, args[2] as number, args[3] as number, args[4] as string | undefined);
        }
        case "getCompletions": {
          const panelPath = await resolvePanelPath(args[0] as string, args[5] as string | undefined);
          await validateFilePath(panelPath, args[1] as string | undefined, args[5] as string | undefined);
          return typeCheckRpcMethods["typecheck.getCompletions"](panelPath, args[1] as string, args[2] as number, args[3] as number, args[4] as string | undefined);
        }
        default:
          throw new Error(`Unknown typecheck method: ${method}`);
      }
    },
  };
}

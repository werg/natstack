import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { ServiceAccessError, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ContextFolderManager } from "@natstack/shared/contextFolderManager";
import { resolveContextScope } from "@natstack/shared/contextMiddleware";
import { typeCheckRpcMethods } from "@natstack/shared/typecheck/service";

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
  if (!callerId.startsWith("tree/")) return undefined;
  const afterTree = callerId.slice("tree/".length);
  const slashIdx = afterTree.indexOf("/");
  const segment = slashIdx >= 0 ? afterTree.slice(0, slashIdx) : afterTree;
  if (!segment) return undefined;
  return segment.replace(/~/g, "/");
}

export function createTypecheckService(deps: {
  contextFolderManager: ContextFolderManager;
  /**
   * Resolves the contextId bound to a caller (panel/worker). Returned undefined
   * means "no context bound" — in that case panel/worker callers must not
   * supply a contextId.
   *
   * Wired from FsService.getCallerContext at the composition root. Defined as
   * a callback (rather than depending on FsService directly) so this module
   * stays free of the fs-service surface and the test seam is trivial.
   */
  getCallerContext: (callerId: string) => string | undefined;
}): ServiceDefinition {
  /**
   * Enforce caller↔context binding for panel/worker callers.
   *
   * - If the caller did not supply a contextId, returns undefined (the
   *   handler proceeds against the workspace root, no `ensureContextFolder`
   *   is triggered for an arbitrary id).
   * - If the caller is a panel or worker and supplied a contextId, it MUST
   *   match the contextId bound to that caller. Mismatches are rejected
   *   without ever calling `resolveContextScope`, so no context-folder
   *   side-effects (`ensureContextFolder` → `git clone --shared`) are
   *   triggered by an unauthorized caller.
   * - Server callers retain the existing behaviour (any contextId is
   *   allowed — they are trusted).
   *
   * Throws `ServiceAccessError` (code: "EACCES"), which the service
   * dispatcher passes through unchanged because it already extends
   * `ServiceError`. That preserves the error name and code on the wire.
   */
  const enforceContextBinding = (
    ctx: ServiceContext,
    method: string,
    suppliedCtxId: string | undefined
  ): string | undefined => {
    if (suppliedCtxId === undefined) return undefined;
    if (ctx.callerKind !== "panel" && ctx.callerKind !== "worker") {
      return suppliedCtxId;
    }
    const bound = deps.getCallerContext(ctx.callerId);
    if (!bound) {
      throw new ServiceAccessError(
        "typecheck",
        method,
        ctx.callerKind,
        `typecheck.${method}: no context registered for ${ctx.callerKind} ${ctx.callerId}; ` +
          `cannot supply contextId from a non-bound caller`
      );
    }
    if (suppliedCtxId !== bound) {
      throw new ServiceAccessError(
        "typecheck",
        method,
        ctx.callerKind,
        `typecheck.${method}: contextId does not match caller's bound context; ` +
          `panels and workers may only supply their own contextId`
      );
    }
    return suppliedCtxId;
  };

  return {
    name: "typecheck",
    description: "TypeScript type checking for panels and packages",
    policy: { allowed: ["panel", "server", "worker"] },
    methods: {
      checkPanel: {
        description:
          'Type-check a panel. Pass the panel source path (e.g. "panels/chat"), ' +
          "or omit it to auto-detect from the caller's context.",
        args: z
          .tuple([])
          .or(z.tuple([z.string().describe('Panel source path, e.g. "panels/my-app"')])),
      },
      check: {
        description:
          "Type-check a panel or a single file. Pass the panel source path " +
          '(e.g. "panels/chat") as the first argument, or call with no args ' +
          "to auto-detect from the caller's context.",
        args: z.tuple([
          z
            .string()
            .optional()
            .describe("Panel source path (auto-detected from caller if omitted)"),
          z
            .string()
            .optional()
            .describe("File path (relative to panel) to check, or omit for whole panel"),
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
      const resolvePanelPath = async (
        panelPath: string,
        ctxId: string | undefined
      ): Promise<string> => {
        if (ctxId) {
          const scope = await resolveContextScope(deps.contextFolderManager, ctxId);
          return scope.resolvePath(panelPath);
        }
        return panelPath;
      };

      const validateFilePath = async (
        _resolvedPanelPath: string,
        filePath: string | undefined,
        ctxId: string | undefined
      ): Promise<void> => {
        if (!filePath) return;
        if (ctxId) {
          const scope = await resolveContextScope(deps.contextFolderManager, ctxId);
          scope.validatePath(filePath);
        }
      };

      switch (method) {
        case "checkPanel": {
          let panelPath = args[0] as string | undefined;
          if (!panelPath) {
            panelPath = extractPanelSourceFromCallerId(ctx.callerId);
            if (!panelPath) {
              throw new Error(
                "Could not auto-detect panel path from caller ID. " +
                  'Please pass the panel source path explicitly, e.g. typecheck.checkPanel("panels/my-app")'
              );
            }
          }

          const resolvedPath = await resolvePanelPath(panelPath, undefined);
          const result = await typeCheckRpcMethods["typecheck.check"](
            resolvedPath,
            undefined,
            undefined
          );

          const errorCount = result.diagnostics.filter((d) => d.severity === "error").length;
          const warningCount = result.diagnostics.filter((d) => d.severity === "warning").length;

          return {
            diagnostics: result.diagnostics,
            errorCount,
            warningCount,
          };
        }

        case "check": {
          let rawPanelPath = args[0] as string | undefined;
          if (!rawPanelPath) {
            rawPanelPath = extractPanelSourceFromCallerId(ctx.callerId);
            if (!rawPanelPath) {
              throw new Error(
                "typecheck.check: panel path is required and could not be auto-detected from caller. " +
                  'Pass the panel source path explicitly, e.g. typecheck.check("panels/my-app")'
              );
            }
          }
          // Enforce caller↔context binding BEFORE any resolveContextScope call
          // (which would otherwise create a foreign context folder via
          // ensureContextFolder). See enforceContextBinding above.
          const ctxId = enforceContextBinding(ctx, "check", args[3] as string | undefined);
          const panelPath = await resolvePanelPath(rawPanelPath, ctxId);
          await validateFilePath(panelPath, args[1] as string | undefined, ctxId);
          return typeCheckRpcMethods["typecheck.check"](
            panelPath,
            args[1] as string | undefined,
            args[2] as string | undefined
          );
        }
        case "getTypeInfo": {
          const ctxId = enforceContextBinding(ctx, "getTypeInfo", args[5] as string | undefined);
          const panelPath = await resolvePanelPath(args[0] as string, ctxId);
          await validateFilePath(panelPath, args[1] as string | undefined, ctxId);
          return typeCheckRpcMethods["typecheck.getTypeInfo"](
            panelPath,
            args[1] as string,
            args[2] as number,
            args[3] as number,
            args[4] as string | undefined
          );
        }
        case "getCompletions": {
          const ctxId = enforceContextBinding(ctx, "getCompletions", args[5] as string | undefined);
          const panelPath = await resolvePanelPath(args[0] as string, ctxId);
          await validateFilePath(panelPath, args[1] as string | undefined, ctxId);
          return typeCheckRpcMethods["typecheck.getCompletions"](
            panelPath,
            args[1] as string,
            args[2] as number,
            args[3] as number,
            args[4] as string | undefined
          );
        }
        default:
          throw new Error(`Unknown typecheck method: ${method}`);
      }
    },
  };
}

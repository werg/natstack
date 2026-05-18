import * as path from "node:path";
import { PANEL_PRINCIPAL_PREFIX } from "@natstack/shared/principalIds";
import { typeCheckRpcMethods } from "@natstack/shared/typecheck/service";

interface ExtensionContextLike {
  workspace: {
    getInfo(): Promise<{ path: string; contextsPath: string }>;
  };
  invocation: {
    current(): { caller: { callerId: string } } | null;
  };
  log: {
    info(message: string): void;
  };
}

function extractPanelSourceFromCallerId(callerId: string): string | undefined {
  const treePrefix = `${PANEL_PRINCIPAL_PREFIX}tree/`;
  if (!callerId.startsWith(treePrefix)) return undefined;
  const afterTree = callerId.slice(treePrefix.length);
  const slashIdx = afterTree.indexOf("/");
  const segment = slashIdx >= 0 ? afterTree.slice(0, slashIdx) : afterTree;
  if (!segment) return undefined;
  return segment.replace(/~/g, "/");
}

function validateContextId(contextId: string): void {
  if (!contextId || contextId.length > 63) {
    throw new Error(`Invalid context ID: length must be 1-63, got ${contextId.length}`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(contextId)) {
    throw new Error(`Invalid context ID: ${contextId}`);
  }
}

function resolveWithin(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes context root: ${relativePath}`);
  }
  return resolved;
}

async function resolvePanelPath(
  ctx: ExtensionContextLike,
  panelPath: string,
  contextId: string | undefined,
): Promise<string> {
  if (!contextId) return panelPath;
  validateContextId(contextId);
  const info = await ctx.workspace.getInfo();
  return resolveWithin(path.join(info.contextsPath, contextId), panelPath);
}

async function validateFilePath(
  ctx: ExtensionContextLike,
  filePath: string | undefined,
  contextId: string | undefined,
): Promise<void> {
  if (!filePath || !contextId) return;
  validateContextId(contextId);
  const info = await ctx.workspace.getInfo();
  resolveWithin(path.join(info.contextsPath, contextId), filePath);
}

function currentCallerPanelPath(ctx: ExtensionContextLike): string | undefined {
  const callerId = ctx.invocation.current()?.caller.callerId;
  return callerId ? extractPanelSourceFromCallerId(callerId) : undefined;
}

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("typecheck-service activating");
  return {
    async checkPanel(panelPath?: string) {
      const source = panelPath ?? currentCallerPanelPath(ctx);
      if (!source) {
        throw new Error(
          "Could not auto-detect panel path from caller ID. " +
          "Pass the panel source path explicitly, e.g. checkPanel(\"panels/my-app\")",
        );
      }
      const resolvedPath = await resolvePanelPath(ctx, source, undefined);
      const result = await typeCheckRpcMethods["typecheck.check"](resolvedPath, undefined, undefined);
      return {
        diagnostics: result.diagnostics,
        errorCount: result.diagnostics.filter((d) => d.severity === "error").length,
        warningCount: result.diagnostics.filter((d) => d.severity === "warning").length,
      };
    },

    async check(
      panelPath?: string,
      filePath?: string,
      fileContent?: string,
      contextId?: string,
    ) {
      const source = panelPath ?? currentCallerPanelPath(ctx);
      if (!source) {
        throw new Error(
          "typecheck-service.check: panel path is required and could not be auto-detected from caller. " +
          "Pass the panel source path explicitly, e.g. check(\"panels/my-app\")",
        );
      }
      const resolvedPanelPath = await resolvePanelPath(ctx, source, contextId);
      await validateFilePath(ctx, filePath, contextId);
      return typeCheckRpcMethods["typecheck.check"](resolvedPanelPath, filePath, fileContent);
    },

    async getTypeInfo(
      panelPath: string,
      filePath: string,
      line: number,
      column: number,
      fileContent?: string,
      contextId?: string,
    ) {
      const resolvedPanelPath = await resolvePanelPath(ctx, panelPath, contextId);
      await validateFilePath(ctx, filePath, contextId);
      return typeCheckRpcMethods["typecheck.getTypeInfo"](
        resolvedPanelPath,
        filePath,
        line,
        column,
        fileContent,
      );
    },

    async getCompletions(
      panelPath: string,
      filePath: string,
      line: number,
      column: number,
      fileContent?: string,
      contextId?: string,
    ) {
      const resolvedPanelPath = await resolvePanelPath(ctx, panelPath, contextId);
      await validateFilePath(ctx, filePath, contextId);
      return typeCheckRpcMethods["typecheck.getCompletions"](
        resolvedPanelPath,
        filePath,
        line,
        column,
        fileContent,
      );
    },
  };
}

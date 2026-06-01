import * as fs from "node:fs";
import * as path from "node:path";
import { PANEL_PRINCIPAL_PREFIX } from "@natstack/shared/principalIds";
import { typeCheckRpcMethods } from "@natstack/shared/typecheck/service";
import {
  discoverWorkspaceContext,
  type WorkspaceContext,
  type WorkspacePackageInfo,
} from "@natstack/typecheck";

interface ExtensionContextLike {
  workspace: {
    getInfo(): Promise<{ path: string; contextsPath: string }>;
  };
  invocation: {
    current(): {
      caller: { callerId: string; contextId?: string };
      chainCaller?: { contextId?: string };
    } | null;
  };
  log: {
    info(message: string): void;
  };
}

type CheckPanelOptions = {
  contextId?: string;
};

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

async function buildContextWorkspaceContext(
  ctx: ExtensionContextLike,
  contextId: string | undefined,
): Promise<WorkspaceContext | undefined> {
  if (!contextId) return undefined;
  validateContextId(contextId);
  const info = await ctx.workspace.getInfo();
  const sourceContext = discoverWorkspaceContext(info.path);
  if (!sourceContext) return undefined;

  const contextRoot = path.join(info.contextsPath, contextId);
  const packages = new Map<string, WorkspacePackageInfo>();
  for (const [name, pkg] of sourceContext.packages) {
    const relativeDir = path.relative(sourceContext.monorepoRoot, pkg.dir);
    if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) continue;

    const contextDir = path.join(contextRoot, relativeDir);
    const contextPackageJson = path.join(contextDir, "package.json");
    if (fs.existsSync(contextPackageJson)) {
      try {
        packages.set(name, {
          name,
          dir: contextDir,
          packageJson: JSON.parse(fs.readFileSync(contextPackageJson, "utf-8")),
        });
        continue;
      } catch {
        // Fall back to the source package below.
      }
    }
    packages.set(name, pkg);
  }

  return { monorepoRoot: contextRoot, packages };
}

function currentCallerPanelPath(ctx: ExtensionContextLike): string | undefined {
  const callerId = ctx.invocation.current()?.caller.callerId;
  return callerId ? extractPanelSourceFromCallerId(callerId) : undefined;
}

function currentInvocationContextId(ctx: ExtensionContextLike): string | undefined {
  const invocation = ctx.invocation.current();
  return invocation?.chainCaller?.contextId ?? invocation?.caller.contextId;
}

function normalizeCheckPanelOptions(options?: CheckPanelOptions | string): CheckPanelOptions {
  if (options === undefined) return {};
  if (typeof options === "string") return { contextId: options };
  return options;
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
// Intentionally NOT registered in the WorkspaceExtensions type registry.
// typecheck-service is agent/host infrastructure invoked over the extension RPC,
// not something panels call via extensions.use(...). Registering it would drag
// its type graph — including @natstack/typecheck and the ~2.4MB bundled
// TypeScript lib sources — into every panel's type-check program for no benefit.

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("typecheck-service activating");
  return {
    async checkPanel(panelPath?: string, options?: CheckPanelOptions | string) {
      const source = panelPath ?? currentCallerPanelPath(ctx);
      if (!source) {
        throw new Error(
          "Could not auto-detect panel path from caller ID. " +
          "Pass the panel source path explicitly, e.g. checkPanel(\"panels/my-app\")",
        );
      }
      const { contextId = currentInvocationContextId(ctx) } = normalizeCheckPanelOptions(options);
      const resolvedPath = await resolvePanelPath(ctx, source, contextId);
      const result = await typeCheckRpcMethods["typecheck.check"](
        resolvedPath,
        undefined,
        undefined,
        { workspaceContext: await buildContextWorkspaceContext(ctx, contextId) },
      );
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
      const effectiveContextId = contextId ?? currentInvocationContextId(ctx);
      const resolvedPanelPath = await resolvePanelPath(ctx, source, effectiveContextId);
      await validateFilePath(ctx, filePath, effectiveContextId);
      return typeCheckRpcMethods["typecheck.check"](
        resolvedPanelPath,
        filePath,
        fileContent,
        { workspaceContext: await buildContextWorkspaceContext(ctx, effectiveContextId) },
      );
    },

    async getTypeInfo(
      panelPath: string,
      filePath: string,
      line: number,
      column: number,
      fileContent?: string,
      contextId?: string,
    ) {
      const effectiveContextId = contextId ?? currentInvocationContextId(ctx);
      const resolvedPanelPath = await resolvePanelPath(ctx, panelPath, effectiveContextId);
      await validateFilePath(ctx, filePath, effectiveContextId);
      return typeCheckRpcMethods["typecheck.getTypeInfo"](
        resolvedPanelPath,
        filePath,
        line,
        column,
        fileContent,
        { workspaceContext: await buildContextWorkspaceContext(ctx, effectiveContextId) },
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
      const effectiveContextId = contextId ?? currentInvocationContextId(ctx);
      const resolvedPanelPath = await resolvePanelPath(ctx, panelPath, effectiveContextId);
      await validateFilePath(ctx, filePath, effectiveContextId);
      return typeCheckRpcMethods["typecheck.getCompletions"](
        resolvedPanelPath,
        filePath,
        line,
        column,
        fileContent,
        { workspaceContext: await buildContextWorkspaceContext(ctx, effectiveContextId) },
      );
    },
  };
}

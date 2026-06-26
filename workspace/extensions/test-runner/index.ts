import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TestRunRequest {
  target: string;
  contextId?: string;
  fileFilter?: string;
  testName?: string;
}

export interface TestRunResult {
  summary: string;
  passed: number;
  failed: number;
  total: number;
  contextId: string;
  target: string;
  pattern: string;
  details: Array<{
    file: string;
    status: "pass" | "fail" | "skip";
    duration?: number;
    errors?: string[];
  }>;
}

interface ExtensionContextLike {
  workspace: {
    getInfo(): Promise<{ path: string; contextsPath: string }>;
  };
  fs: {
    ensureMaterialized(scope: string | string[] | "all"): Promise<void>;
  };
  invocation: {
    current(): {
      caller: { callerId: string; callerKind?: string; contextId?: string };
      chainCaller?: { contextId?: string };
    } | null;
  };
  approvals: {
    request(req: {
      subject: { id: string; label?: string };
      title: string;
      summary?: string;
      warning?: string;
      details?: Array<{ label: string; value: string }>;
      promptOptions?: "scoped" | "choices";
      options?: Array<{
        value: string;
        label: string;
        description?: string;
        tone?: "primary" | "danger" | "neutral";
      }>;
    }): Promise<
      | { kind: "choice"; choice: string }
      | { kind: "dismissed" }
      | { kind: "uncallable"; reason: "no-user-context" }
    >;
  };
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
  };
}

const WORKSPACE_ROOTS = new Set([
  "about",
  "apps",
  "extensions",
  "packages",
  "panels",
  "projects",
  "skills",
  "templates",
  "workers",
]);

const PANEL_SETUP_SOURCE = `
export {};
globalThis.__natstackModuleMap__ = globalThis.__natstackModuleMap__ ?? {};
globalThis.__natstackRequire__ = (id) => globalThis.__natstackModuleMap__[id];
globalThis.__natstackRequireAsync__ = async (id) => globalThis.__natstackModuleMap__[id];
globalThis.__natstackEntityId = "test-panel";
globalThis.__natstackContextId = "ctx-test";
`;

function validateContextId(contextId: string): void {
  if (!contextId || contextId.length > 63) {
    throw new Error(`Invalid context ID: length must be 1-63, got ${contextId.length}`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(contextId)) {
    throw new Error(`Invalid context ID: ${contextId}`);
  }
}

function assertWorkspaceTarget(target: string): void {
  if (!target || path.isAbsolute(target)) {
    throw new Error(`Target must be a workspace-relative path: ${target}`);
  }
  const normalized = target.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Target must not contain parent traversal: ${target}`);
  }
  const [root] = normalized.split("/");
  if (!root || !WORKSPACE_ROOTS.has(root)) {
    throw new Error(`Target must start with a workspace unit root: ${target}`);
  }
}

function resolveWithin(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes test root: ${relativePath}`);
  }
  return resolved;
}

function currentInvocationContextId(ctx: ExtensionContextLike): string | undefined {
  const invocation = ctx.invocation.current();
  return invocation?.chainCaller?.contextId ?? invocation?.caller.contextId;
}

function normalizeRunRequest(
  requestOrTarget: TestRunRequest | string,
  options: Omit<TestRunRequest, "target"> = {}
): TestRunRequest {
  if (typeof requestOrTarget === "string") return { ...options, target: requestOrTarget };
  return requestOrTarget;
}

function testPatternFor(targetPath: string, fileFilter?: string): string {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return targetPath;
  if (!stat.isDirectory()) throw new Error(`Target must be a file or directory: ${targetPath}`);
  if (fileFilter) return resolveWithin(targetPath, fileFilter);
  return path.join(targetPath, "**/*.test.{ts,tsx}");
}

function ensurePanelSetupFile(): string {
  const setupDir = path.join(os.tmpdir(), "natstack-workspace-test-runner");
  fs.mkdirSync(setupDir, { recursive: true });
  const setupFile = path.join(setupDir, "panel-test-setup.mjs");
  fs.writeFileSync(setupFile, PANEL_SETUP_SOURCE);
  return setupFile;
}

async function requestApproval(ctx: ExtensionContextLike, req: TestRunRequest): Promise<void> {
  const target = req.target.length > 80 ? `${req.target.slice(0, 77)}...` : req.target;
  const subjectHash = createHash("sha256")
    .update(
      JSON.stringify({
        contextId: req.contextId ?? null,
        target: req.target,
        fileFilter: req.fileFilter ?? null,
        testName: req.testName ?? null,
      })
    )
    .digest("hex")
    .slice(0, 16);
  const decision = await ctx.approvals.request({
    subject: {
      id: `workspace-test:${subjectHash}`,
      label: `Run tests: ${target}`,
    },
    title: "Run workspace tests",
    summary:
      "Vitest will execute test files from the selected workspace unit in the test-runner extension process.",
    warning:
      "Tests are code execution. Only run tests from workspace code you trust or are actively reviewing.",
    details: [
      { label: "target", value: req.target },
      ...(req.contextId ? [{ label: "context", value: req.contextId }] : []),
      ...(req.fileFilter ? [{ label: "file filter", value: req.fileFilter }] : []),
      ...(req.testName ? [{ label: "test name", value: req.testName }] : []),
    ],
  });
  if (decision?.kind === "uncallable") {
    throw new Error(`Workspace test run cannot request approval: ${decision.reason}`);
  }
  if (decision?.kind === "dismissed" || decision?.choice === "deny") {
    throw new Error("Workspace test run denied");
  }
}

function formatTaskErrors(task: { name?: string; result?: { errors?: unknown[] } }): string[] {
  return (task.result?.errors ?? []).map((error) => {
    const message =
      error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message)
          : String(error);
    return task.name ? `${task.name}: ${message}` : message;
  });
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
// Intentionally NOT registered in the WorkspaceExtensions type registry.
// test-runner is agent/host infrastructure and imports Node/Vitest modules;
// registering it would drag that type graph into every panel type-check.

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("test-runner activating");
  return {
    async run(
      requestOrTarget: TestRunRequest | string,
      options?: Omit<TestRunRequest, "target">
    ): Promise<TestRunResult> {
      const request = normalizeRunRequest(requestOrTarget, options);
      assertWorkspaceTarget(request.target);

      const info = await ctx.workspace.getInfo();
      const contextId = request.contextId ?? currentInvocationContextId(ctx);
      if (!contextId) {
        throw new Error("test-runner.run requires a contextId");
      }
      validateContextId(contextId);
      const root = path.join(info.contextsPath, contextId);
      await ctx.fs.ensureMaterialized(request.target);
      const targetPath = resolveWithin(root, request.target);
      if (!fs.existsSync(targetPath)) {
        throw new Error(`Target does not exist: ${request.target}`);
      }

      await requestApproval(ctx, { ...request, contextId });

      const pattern = testPatternFor(targetPath, request.fileFilter);
      const setupFiles = request.target.startsWith("panels/") ? [ensurePanelSetupFile()] : [];
      const { startVitest } = await import("vitest/node");
      const vitest = await startVitest("run" as never, [pattern], {
        root: info.path,
        exclude: ["**/node_modules/**", "dist"],
        setupFiles,
        testNamePattern: request.testName,
        reporters: ["default"],
        silent: true,
      });

      if (!vitest) {
        return {
          summary: "Vitest failed to start",
          passed: 0,
          failed: 0,
          total: 0,
          contextId,
          target: request.target,
          pattern,
          details: [],
        };
      }

      try {
        const files = vitest.state.getFiles();
        let passed = 0;
        let failed = 0;
        const details: TestRunResult["details"] = [];

        for (const file of files) {
          const fileErrors: string[] = [];
          for (const task of file.tasks ?? []) {
            if (task.result?.state === "pass") passed++;
            else if (task.result?.state === "fail") {
              failed++;
              fileErrors.push(...formatTaskErrors(task));
            }
          }
          const fileStatus: "pass" | "fail" | "skip" =
            file.result?.state === "fail"
              ? "fail"
              : file.result?.state === "pass"
                ? "pass"
                : "skip";
          details.push({
            file: path.relative(root, file.filepath),
            status: fileStatus,
            duration: file.result?.duration,
            ...(fileErrors.length > 0 ? { errors: fileErrors } : {}),
          });
        }

        const total = passed + failed;
        const summary =
          files.length === 0
            ? `No test files found matching: ${request.target}${request.fileFilter ? `/${request.fileFilter}` : ""}`
            : failed > 0
              ? `${failed} of ${total} test${total !== 1 ? "s" : ""} failed`
              : `${total} test${total !== 1 ? "s" : ""} passed`;

        return {
          summary,
          passed,
          failed,
          total,
          contextId,
          target: request.target,
          pattern,
          details,
        };
      } finally {
        await vitest.close();
      }
    },
  };
}

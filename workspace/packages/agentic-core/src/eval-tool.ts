/**
 * Shared eval tool definition builder.
 *
 * Both the panel eval tool and the headless eval tool use this to build
 * identical eval method definitions. One implementation, consistent behavior.
 */

import { z } from "zod";
import { executeSandbox as defaultExecuteSandbox } from "@workspace/eval";
import type { SandboxOptions, SandboxResult, ScopeManager } from "@workspace/eval";
import type { MethodDefinition, MethodExecutionContext } from "@natstack/pubsub";
import type { SandboxConfig, ChatSandboxValue } from "./types.js";

export interface BuildEvalToolOptions {
  sandbox: SandboxConfig;
  rpc: SandboxConfig["rpc"];
  runtimeTarget: "panel" | "workerRuntime";
  /** Scope manager for enter/exit eval lifecycle. If not provided, no scope management. */
  scopeManager?: ScopeManager | null;
  /** Build the ChatSandboxValue at call time (may change between calls) */
  getChatSandboxValue: () => ChatSandboxValue;
  /** Get the current scope proxy */
  getScope: () => Record<string, unknown>;
  /**
   * Override the executeSandbox function. If provided, this is used instead
   * of the default. Useful when the caller has already wrapped executeSandbox
   * with scope lifecycle hooks (like the panel's useAgenticChat).
   * When set, scopeManager is ignored (the override handles it).
   */
  executeSandbox?: (code: string, opts: SandboxOptions) => Promise<SandboxResult>;
}

/**
 * Build the eval MethodDefinition.
 *
 * Returns a tool definition with consistent formatting between panel and
 * headless contexts: console streaming via ctx.stream, structured text
 * parts for return values, scope summary, and proper error formatting.
 */
export function buildEvalTool(opts: BuildEvalToolOptions): MethodDefinition {
  const { sandbox, scopeManager } = opts;
  const runSandbox = opts.executeSandbox ?? defaultExecuteSandbox;

  return {
    description: `Execute TypeScript/JavaScript code in the sandbox.

Call \`await help()\` first when you need the live service catalog or runtime surface for this context. Only \`chat\`, \`scope\`, \`scopes\`, and \`help\` are pre-injected. Import everything else from \`@workspace/runtime\` using static \`import\`, not \`await import(...)\`.

Workspace packages (\`@workspace/*\`, \`@workspace-skills/*\`, \`@natstack/*\`) are auto-resolved — just write the \`import\` statement. npm packages require the \`imports\` parameter with \`"npm:<version>"\`.

\`return\` sends a value back to the agent. \`console.log\` streams in real time. \`scope\` persists across eval calls.`,
    parameters: z.object({
      code: z.string().describe("The TypeScript/JavaScript code to execute"),
      syntax: z.enum(["typescript", "jsx", "tsx"]).default("tsx").describe("Target syntax"),
      imports: z.record(z.string(), z.string()).optional()
        .describe("On-demand package builds. Workspace packages (@workspace/*, @natstack/*) are auto-resolved and don't need this. Use for npm packages (\"npm:<version>\") or to pin a workspace package to a specific git ref."),
    }),
    streaming: true,
    execute: async (args: unknown, ctx: MethodExecutionContext) => {
      const typedArgs = args as { code: string; syntax?: "typescript" | "jsx" | "tsx"; imports?: Record<string, string> };

      // Only manage scope lifecycle if using the default executeSandbox
      // (callers who override executeSandbox handle scope themselves)
      if (!opts.executeSandbox) scopeManager?.enterEval();
      try {
        const result: SandboxResult = await runSandbox(typedArgs.code, {
          syntax: typedArgs.syntax,
          imports: typedArgs.imports,
          loadImport: sandbox.loadImport,
          bindings: {
            chat: opts.getChatSandboxValue(),
            scope: scopeManager?.current ?? {},
            scopes: scopeManager?.api ?? {},
            help: async (serviceName?: string) => {
              if (serviceName) {
                return await opts.rpc.call("main", "meta.describeService", serviceName);
              }
              const [services, runtime, skillPackages] = await Promise.all([
                opts.rpc.call("main", "meta.listServices"),
                opts.rpc.call("main", "meta.getRuntimeSurface", opts.runtimeTarget),
                opts.rpc.call("main", "build.listSkills").catch(() => null),
              ]);
              return {
                services,
                runtime,
                imports: {
                  description: "Use the eval tool's `imports` parameter to load additional packages on-demand.",
                  usage: 'Workspace packages (@workspace/*, @natstack/*) are auto-resolved. For npm: imports: { "lodash": "npm:4" }. To pin a git ref: imports: { "pkg": "branch-name" }',
                  workspaceSkills: skillPackages ?? "Use build.listSkills to discover available skills",
                  npmPackages: 'Use "npm:<version>" for npm packages, e.g. "npm:latest" or "npm:^4.0.0"',
                },
              };
            },
          },
          onConsole: (formatted: string) => {
            void ctx.stream({ type: "console", content: formatted }).catch((error) => {
              console.error("[buildEvalTool] Failed to stream console output:", error);
            });
          },
        });

        const scopeKeys = Object.keys(opts.getScope());
        const scopeLine = scopeKeys.length > 0
          ? `[scope] keys: ${scopeKeys.join(", ")} (${scopeKeys.length} total)`
          : "[scope] (empty)";

        if (!result.success) {
          throw new Error(`${result.error || "Eval failed"}\n${scopeLine}`);
        }

        // Format as structured text parts so the AI sees clean, readable text
        const parts: Array<{ type: "text"; text: string }> = [];
        if (result.consoleOutput) {
          parts.push({ type: "text", text: `[eval] Console:\n${result.consoleOutput}` });
        }
        if (result.returnValue !== undefined && result.returnValue !== null) {
          let formatted: string;
          try {
            formatted = typeof result.returnValue === "string"
              ? result.returnValue
              : JSON.stringify(result.returnValue, null, 2);
          } catch {
            formatted = String(result.returnValue);
          }
          parts.push({ type: "text", text: `[eval] Return value:\n${formatted}` });
        }
        if (parts.length === 0) {
          parts.push({ type: "text", text: "[eval] (no output)" });
        }
        parts.push({ type: "text", text: scopeLine });
        return { content: parts };
      } finally {
        if (!opts.executeSandbox) await scopeManager?.exitEval();
      }
    },
  };
}

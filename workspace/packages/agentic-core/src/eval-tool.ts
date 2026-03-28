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

Available imports (static — no \`imports\` parameter needed):
- \`@workspace/runtime\` — rpc, fs, db, workers, ai, contextId, panel navigation
- \`react\`, \`@radix-ui/themes\`, \`@radix-ui/react-icons\` — UI components
- \`isomorphic-git\` — git operations

On-demand imports (use \`imports\` parameter):
- \`@workspace-skills/*\` — skill packages (value: "latest")
- \`@natstack/*\` — platform packages (value: "latest")
- npm packages (value: "npm:<version>")

Pre-injected variables (do NOT import): chat, scope, scopes
Import contextId from @workspace/runtime.

scope is a live in-memory object shared across eval calls.
Use scope to store data between calls (scope.myVar = value).`,
    parameters: z.object({
      code: z.string().describe("The TypeScript/JavaScript code to execute"),
      syntax: z.enum(["typescript", "jsx", "tsx"]).default("tsx").describe("Target syntax"),
      imports: z.record(z.string(), z.string()).optional()
        .describe("Packages to build on-demand. For workspace packages: \"latest\". For npm: \"npm:<version>\". E.g. { \"@workspace-skills/paneldev\": \"latest\", \"lodash\": \"npm:4\" }"),
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
          },
          onConsole: (formatted: string) => {
            void ctx.stream({ type: "console", content: formatted }).catch(() => {});
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

import type { KernelManager } from "../../kernel/KernelManager";
import type { CodeLanguage } from "../../types/messages";
import type { AgentTool } from "../AgentSession";

/**
 * Tool execution result format.
 */
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/**
 * Create kernel operation tools for the agent.
 */
export function createKernelTools(kernel: KernelManager): AgentTool[] {
  return [
    {
      name: "execute_code",
      description: `Execute JavaScript/TypeScript/JSX code in the notebook kernel.

The kernel maintains state across executions - variables and functions you define persist.
Use this for:
- Running computations
- Defining functions and variables
- Creating and mounting React components
- Importing npm packages (via importModule)
- Importing files from OPFS (via importOPFS)

The kernel has these pre-injected:
- mount(element) - Render a React element to output
- importModule(specifier) - Import from CDN (e.g., importModule('lodash-es'))
- importOPFS(path) - Import a module from OPFS storage

To render React components, use:
mount(<YourComponent />)

The component will be displayed in the chat output.`,
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The code to execute",
          },
          language: {
            type: "string",
            enum: ["javascript", "typescript", "jsx", "tsx"],
            description: "Code language (default: typescript)",
          },
        },
        required: ["code"],
      },
      execute: async (args): Promise<ToolResult> => {
        try {
          const code = args.code as string | undefined;
          const language = (args.language as CodeLanguage | undefined) ?? "typescript";
          if (!code || typeof code !== "string" || code.trim() === "") {
            return {
              content: [{ type: "text", text: "Error: No code provided. The 'code' parameter is required." }],
              isError: true,
            };
          }
          const result = await kernel.executeFromAgent(code, language);

          if (result.success) {
            // Format console output
            const consoleOutput = result.output
              .map((entry: { level: string; args: unknown[] }) => {
                const argsStr = entry.args
                  .map((arg: unknown) =>
                    typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
                  )
                  .join(" ");
                return `[${entry.level}] ${argsStr}`;
              })
              .join("\n");

            // Format result
            let resultText = "";
            if (consoleOutput) {
              resultText += consoleOutput;
            }
            if (result.result !== undefined) {
              const resultStr =
                typeof result.result === "object"
                  ? JSON.stringify(result.result, null, 2)
                  : String(result.result);
              resultText += resultText ? "\n=> " + resultStr : "=> " + resultStr;
            }

            // Note declared variables
            if (result.constNames.length > 0 || result.mutableNames.length > 0) {
              const vars = [...result.constNames, ...result.mutableNames];
              resultText += resultText
                ? `\n\nDeclared: ${vars.join(", ")}`
                : `Declared: ${vars.join(", ")}`;
            }

            return {
              content: [{ type: "text", text: resultText || "Code executed successfully (no output)" }],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: ${result.error?.message ?? "Unknown error"}`,
                },
              ],
              isError: true,
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },

    {
      name: "reset_kernel",
      description:
        "Reset the kernel state, clearing all variables and definitions. Optionally keep certain bindings.",
      parameters: {
        type: "object",
        properties: {
          keep_bindings: {
            type: "array",
            items: { type: "string" },
            description: "Names of bindings to preserve (e.g., ['myData', 'helper'])",
          },
        },
      },
      execute: async (args): Promise<ToolResult> => {
        try {
          const keepBindings = args.keep_bindings as string[] | undefined;
          kernel.reset(keepBindings);
          return {
            content: [
              {
                type: "text",
                text: keepBindings?.length
                  ? `Kernel reset. Preserved: ${keepBindings.join(", ")}`
                  : "Kernel reset. All state cleared.",
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error resetting kernel: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },

    {
      name: "get_kernel_scope",
      description: "Get the current kernel scope - list all defined variables and their types.",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (): Promise<ToolResult> => {
        try {
          const scope = kernel.getScope();
          const entries = Object.entries(scope).map(([name, value]) => {
            const type = typeof value;
            const preview =
              type === "function"
                ? "[function]"
                : type === "object"
                  ? value === null
                    ? "null"
                    : Array.isArray(value)
                      ? `[Array(${value.length})]`
                      : `[Object]`
                  : JSON.stringify(value);
            return `${name}: ${type} = ${preview}`;
          });

          return {
            content: [
              {
                type: "text",
                text: entries.length > 0 ? entries.join("\n") : "Scope is empty",
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error getting scope: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
  ];
}

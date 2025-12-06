import { execute, createBindings, type ConsoleEntry } from "../../eval";
import type { AgentTool, ToolExecutionContext } from "../AgentSession";

/**
 * Tool execution result format.
 */
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/**
 * Create the code execution tool for the agent.
 */
export function createEvalTools(): AgentTool[] {
  return [
    {
      name: "execute_code",
      description: `Execute JavaScript/TypeScript code.

Each execution is independent - variables don't persist between calls.

The code has access to:
- importModule(specifier) - Import npm packages from CDN (e.g., importModule('lodash-es'))
- importOPFS(path) - Import a module from OPFS storage

Example:
\`\`\`typescript
const _ = await importModule('lodash-es');
const result = _.sum([1, 2, 3]);
result // returns 6
\`\`\``,
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The TypeScript/JavaScript code to execute",
          },
        },
        required: ["code"],
      },
      execute: async (args, context?: ToolExecutionContext): Promise<ToolResult> => {
        const code = args.code as string | undefined;

        if (!code || typeof code !== "string" || code.trim() === "") {
          return {
            content: [{ type: "text", text: "Error: No code provided" }],
            isError: true,
          };
        }

        // Create bindings fresh each time (they're stateless functions)
        const bindings = createBindings();

        const result = await execute(code, {
          bindings,
          signal: context?.signal,
        });

        if (result.success) {
          const output = formatOutput(result.console, result.value);
          return {
            content: [{ type: "text", text: output || "Code executed successfully (no output)" }],
          };
        } else {
          return {
            content: [{ type: "text", text: `Error: ${result.error?.message ?? "Unknown error"}` }],
            isError: true,
          };
        }
      },
    },
  ];
}

/**
 * Format console output and return value into a string.
 */
function formatOutput(consoleEntries: ConsoleEntry[], value: unknown): string {
  const parts: string[] = [];

  // Console output
  if (consoleEntries.length > 0) {
    const consoleOutput = consoleEntries
      .map((entry) => {
        const argsStr = entry.args
          .map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)))
          .join(" ");
        return `[${entry.level}] ${argsStr}`;
      })
      .join("\n");
    parts.push(consoleOutput);
  }

  // Return value
  if (value !== undefined) {
    const valueStr = typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
    parts.push(`=> ${valueStr}`);
  }

  return parts.join("\n");
}

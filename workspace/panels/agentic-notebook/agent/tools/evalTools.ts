import { execute, createBindings, type ConsoleEntry, componentRegistry } from "../../eval";
import type { AgentTool, ToolExecutionContext } from "../AgentSession";
import type { ComponentType } from "react";
import { isValidComponent } from "../../utils/componentUtils";
import type { CodeExecutionToolResult } from "../../types/messages";

/**
 * Tool execution result format.
 */
type ToolResult = CodeExecutionToolResult | {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  data?: undefined;
};

/**
 * Make a value serializable for IPC.
 * Functions and other non-serializable values are converted to descriptive strings.
 */
function makeSerializable(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return `[Symbol: ${value.description}]`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(makeSerializable);
  }

  // Handle objects - check for React components and other non-serializable things
  const obj = value as Record<string, unknown>;

  // If it looks like a module namespace with a default export that's a function,
  // just indicate it's a component
  if ("default" in obj && typeof obj.default === "function") {
    return { __type: "ReactComponent", name: (obj.default as { name?: string }).name || "Component" };
  }

  // Recursively process object properties
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = makeSerializable(val);
  }
  return result;
}

/**
 * Create the code execution tool for the agent.
 */
export function createEvalTools(): AgentTool[] {
  return [
    {
      name: "execute_code",
      description: `Execute JavaScript/TypeScript code.

Each execution is independent - variables don't persist between calls.

Use standard ES module imports:
- Bare specifiers (react, lodash-es) → loaded from CDN
- Paths (./utils.ts, /config.json) → loaded from OPFS

To render a UI component, export it as default or return it:

Example (Export Default):
\`\`\`tsx
import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
\`\`\`

Example (Return):
\`\`\`tsx
const App = () => <h1>Hello</h1>;
App // Return the component
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

        // Create bindings fresh each time
        const bindings = createBindings();

        const startTime = Date.now();
        const result = await execute(code, {
          bindings,
          signal: context?.signal,
        });
        const executionTime = Date.now() - startTime;

        let componentId: string | undefined;

        if (result.success) {
          // Check for component in default export or return value
          let component: ComponentType | undefined;

          // 1. Check default export (if result.value is a module namespace object)
          if (
            result.value &&
            typeof result.value === "object" &&
            "default" in result.value &&
            isValidComponent((result.value as { default: unknown }).default)
          ) {
            component = (result.value as { default: ComponentType }).default;
          }
          // 2. Check return value directly
          else if (isValidComponent(result.value)) {
            component = result.value as ComponentType;
          }

          if (component) {
            componentId = componentRegistry.register(component);
          }
        }

        if (result.success) {
          const output = formatOutput(result.console, result.value);
          return {
            content: [{ type: "text", text: output || "Code executed successfully (no output)" }],
            data: {
              type: "code_execution",
              result: makeSerializable(result.value), // Make serializable for IPC
              consoleOutput: result.console,
              componentId,
              executionTime,
              code, // Include source code for rehydration
            },
          };
        } else {
          return {
            content: [{ type: "text", text: `Error: ${result.error?.message ?? "Unknown error"}` }],
            isError: true,
            data: {
              type: "code_execution",
              result: undefined,
              consoleOutput: result.console,
              executionTime,
              error: result.error?.message,
              code, // Include source code even on error
            },
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

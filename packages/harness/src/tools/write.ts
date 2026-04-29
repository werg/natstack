/**
 * Write tool — workerd port of pi-coding-agent's `dist/core/tools/write.js`.
 *
 * Differences from upstream:
 * - File I/O goes through `RuntimeFs` (no `fs/promises`).
 * - Parent directories are created via `fs.mkdir(..., { recursive: true })`.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import { dirname } from "node:path";
import type { RuntimeFs } from "./runtime-fs.js";
import { resolveToCwd } from "./path-utils.js";

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
  bytesWritten: number;
  path: string;
}

export function createWriteTool(
  cwd: string,
  fs: RuntimeFs,
): AgentTool<typeof writeSchema, WriteToolDetails> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    execute: async (_toolCallId, input, signal) => {
      const { path, content } = input;
      if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("write requires path and content");
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);

      await fs.mkdir(dir, { recursive: true });

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      await fs.writeFile(absolutePath, content);

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const result: { content: (TextContent | ImageContent)[]; details: WriteToolDetails } = {
        content: [
          { type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` },
        ],
        details: { bytesWritten: content.length, path: absolutePath },
      };
      return result;
    },
  };
}

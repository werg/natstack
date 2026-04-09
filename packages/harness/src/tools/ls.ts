/**
 * Ls tool — workerd port of pi-coding-agent's `dist/core/tools/ls.js`.
 *
 * Differences from upstream:
 * - File I/O goes through `RuntimeFs` (no synchronous Node fs).
 * - Uses `readdir({ withFileTypes: true })` so we don't need a per-entry
 *   `stat()` call to check directory-ness.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import type { RuntimeFs, Dirent } from "./runtime-fs.js";
import { resolveToCwd } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolDetails {
  truncation?: TruncationResult;
  entryLimitReached?: number;
}

const DEFAULT_LIMIT = 500;

export function createLsTool(
  cwd: string,
  fs: RuntimeFs,
): AgentTool<typeof lsSchema, LsToolDetails | undefined> {
  return {
    name: "ls",
    label: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: lsSchema,
    execute: async (_toolCallId, { path: rawPath, limit }, signal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const dirPath = resolveToCwd(rawPath || ".", cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      let stat;
      try {
        stat = await fs.stat(dirPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Path not found: ${dirPath}`);
        }
        throw err;
      }
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }

      let entries: Dirent[];
      try {
        entries = (await fs.readdir(dirPath, { withFileTypes: true })) as Dirent[];
      } catch (e) {
        throw new Error(`Cannot read directory: ${(e as Error).message}`);
      }

      // Sort case-insensitively to match upstream.
      entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

      const results: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        const suffix = entry.isDirectory() ? "/" : "";
        results.push(entry.name + suffix);
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "(empty directory)" }],
          details: undefined,
        } as { content: (TextContent | ImageContent)[]; details: undefined };
      }

      const rawOutput = results.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: LsToolDetails = {};
      const notices: string[] = [];

      if (entryLimitReached) {
        notices.push(
          `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
        );
        details.entryLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}

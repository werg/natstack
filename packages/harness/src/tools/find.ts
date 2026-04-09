/**
 * Find tool — workerd-native rewrite of pi-coding-agent's
 * `dist/core/tools/find.js`.
 *
 * Upstream uses `fd` via `child_process.spawnSync`, plus the `glob` package
 * for nested .gitignore discovery. workerd has neither, so we walk the tree
 * with `RuntimeFs` and apply our own glob → regex helper. Schema and details
 * shape match the upstream tool.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import path from "node:path";
import type { RuntimeFs, Dirent } from "./runtime-fs.js";
import { resolveToCwd } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";
import { globToRegex } from "./grep.js";

const findSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
  }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
  truncation?: TruncationResult;
  resultLimitReached?: number;
}

const DEFAULT_LIMIT = 1000;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".svelte-kit",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
]);

export function createFindTool(
  cwd: string,
  fs: RuntimeFs,
): AgentTool<typeof findSchema, FindToolDetails | undefined> {
  return {
    name: "find",
    label: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: findSchema,
    execute: async (_toolCallId, { pattern, path: searchDir, limit }, signal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const searchPath = resolveToCwd(searchDir || ".", cwd);
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      // Verify the search root exists.
      try {
        await fs.stat(searchPath);
      } catch {
        throw new Error(`Path not found: ${searchPath}`);
      }

      const regex = globToRegex(pattern);
      const matches: string[] = [];
      let resultLimitReached = false;

      const walk = async (dir: string): Promise<void> => {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        if (resultLimitReached) return;
        let entries: Dirent[];
        try {
          entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
        } catch {
          return;
        }
        for (const entry of entries) {
          if (signal?.aborted) throw new Error("Operation aborted");
          if (resultLimitReached) return;
          const full = path.join(dir, entry.name);
          const rel = path.relative(searchPath, full).replace(/\\/g, "/");
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            // Test the directory itself against the glob too — it lets users find
            // directories like `**/__tests__`.
            if (regex.test(rel + "/")) {
              matches.push(rel + "/");
              if (matches.length >= effectiveLimit) {
                resultLimitReached = true;
                return;
              }
            }
            await walk(full);
          } else if (entry.isFile()) {
            if (regex.test(rel)) {
              matches.push(rel);
              if (matches.length >= effectiveLimit) {
                resultLimitReached = true;
                return;
              }
            }
          }
        }
      };

      await walk(searchPath);

      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: "No files found matching pattern" }],
          details: undefined,
        } as { content: (TextContent | ImageContent)[]; details: undefined };
      }

      const rawOutput = matches.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let resultOutput = truncation.content;
      const details: FindToolDetails = {};
      const notices: string[] = [];

      if (resultLimitReached) {
        notices.push(
          `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
        details.resultLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (notices.length > 0) {
        resultOutput += `\n\n[${notices.join(". ")}]`;
      }

      return {
        content: [{ type: "text", text: resultOutput }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}

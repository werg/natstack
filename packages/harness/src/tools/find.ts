/**
 * Find tool — workerd-native rewrite of pi-coding-agent's
 * `dist/core/tools/find.js`.
 *
 * Upstream uses `fd` via `child_process.spawnSync`, plus the `glob` package
 * for nested .gitignore discovery. workerd has neither, so active agent runs
 * delegate to the Node-side `@workspace-extensions/file-tools` extension, which
 * uses ripgrep's file listing. If the extension is unavailable, this file
 * falls back to walking the tree with `RuntimeFs` and applying our own
 * glob → regex helper.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { RpcCaller } from "@natstack/rpc";
import { createExtensionProxy } from "@natstack/extension";
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
  engine?: "ripgrep" | "runtime-fs";
}

interface FindToolResult {
  content: (TextContent | ImageContent)[];
  details: FindToolDetails | undefined;
}

interface FileToolsApi {
  find(request: {
    pattern: string;
    path?: string;
    cwd: string;
    limit?: number;
  }): Promise<FindToolResult>;
}

export interface FindToolDeps {
  rpc?: RpcCaller;
}

const DEFAULT_LIMIT = 1000;
const FILE_TOOLS_EXTENSION = "@workspace-extensions/file-tools";

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
  deps?: FindToolDeps,
): AgentTool<typeof findSchema, FindToolDetails | undefined> {
  const fileTools = deps?.rpc
    ? createExtensionProxy<FileToolsApi>(deps.rpc, FILE_TOOLS_EXTENSION, () => false)
    : null;
  return {
    name: "find",
    label: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: findSchema,
    execute: async (_toolCallId, input, signal) => {
      const { pattern, path: searchDir, limit } = input;
      if (typeof pattern !== "string") {
        throw new Error("find requires pattern");
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (fileTools) {
        try {
          return (await fileTools.find({ pattern, path: searchDir, cwd, limit })) as FindToolResult;
        } catch (err) {
          if (!isFileToolsExtensionUnavailable(err)) throw err;
        }
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
      const details: FindToolDetails = { engine: "runtime-fs" };
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

function isFileToolsExtensionUnavailable(err: unknown): boolean {
  const code = typeof err === "object" && err !== null
    ? (err as { code?: unknown }).code
    : undefined;
  // ENOEXT = not installed/enabled; ENOTREADY = declared but not yet running.
  // Both mean the extension can't serve this call, so fall back to runtime-fs.
  if (code === "ENOEXT" || code === "ENOTREADY") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /Extension @workspace-extensions\/file-tools(?:\.\w+)? invocation failed: Extension is not installed or enabled|Extension is not running/.test(message);
}
